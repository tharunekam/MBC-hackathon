/**
 * An order whose answer is lost (a timeout, a socket that closed mid-request) may still have reached Gemini and filled.
 * Placing used to call that a failure and carry on: an outcome that filled was recorded as "failed" while the account held
 * it, and a hedge that filled was bought a second time. These tests lose the answer at every point, for every product, and
 * check the one thing that matters: what the ledger says the account holds is what the exchange says it holds, and no
 * order is ever sent twice.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { UNKNOWN_NOTE, placeConditionalBet, recoverBets, settleBets } from '../src/bets.ts';
import type { Deps } from '../src/bets.ts';
import { placeBreakoutBet } from '../src/breakout-bet.ts';
import { quoteCashOut } from '../src/cashout.ts';
import { OrderNotSent, OrderUnconfirmed } from '../src/exchange.ts';
import type { OrderRequest } from '../src/exchange.ts';
import { Ledger } from '../src/ledger.ts';
import { clean } from '../src/pricing.ts';
import { placeRangeBet } from '../src/range-bet.ts';
import { ensureBaseline, reconcile } from '../src/reconcile.ts';
import { start, TIGHT } from './api-harness.ts';
import { FakeExchange } from './fake.ts';

const LADDER = [
  { strike: 1780, bid: 0.88, ask: 0.9 },
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.6, ask: 0.62 },
  { strike: 1840, bid: 0.4, ask: 0.42 },
];

function setup() {
  const exchange = new FakeExchange('ETHTEST', LADDER);
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-lost-')), 'ledger.json'));
  let n = 0;
  // The look-ups after a lost answer are timed in the real thing (0, 0.5, 1.5, 3 s); here they are back to back.
  const deps: Deps = { exchange, ledger, newId: () => `t${++n}`, now: () => new Date('2026-11-17T23:10:00Z'), waiveMarkup: false, lookupWaitsMs: [0, 0, 0] };
  return { exchange, ledger, deps };
}

const parlay = (ex: FakeExchange, extra: object = {}) => ({ user: 'primary', eventTicker: 'ETHTEST', conditionSymbol: ex.symbol(1800), targetSymbol: ex.symbol(1820), stake: 10, slippageTicks: 0, ...extra });
const faller = (ex: FakeExchange, extra: object = {}) => ({ user: 'primary', eventTicker: 'ETHTEST', conditionSymbol: ex.symbol(1840), targetSymbol: ex.symbol(1800), direction: 'down' as const, stake: 10, slippageTicks: 0, ...extra });
const spread = (ex: FakeExchange, extra: object = {}) => ({ user: 'primary', eventTicker: 'ETHTEST', lowSymbol: ex.symbol(1800), highSymbol: ex.symbol(1840), stake: 14.2, slippageTicks: 0, ...extra });

const PRODUCTS = [
  { name: 'a rising parlay', id: 't1', place: (ex: FakeExchange, deps: Deps) => placeConditionalBet(deps, parlay(ex)) },
  { name: 'a falling parlay', id: 'dn-t1', place: (ex: FakeExchange, deps: Deps) => placeConditionalBet(deps, faller(ex)) },
  { name: 'a range', id: 'rg-t1', place: (ex: FakeExchange, deps: Deps) => placeRangeBet(deps, spread(ex)) },
  { name: 'a breakout', id: 'bo-t1', place: (ex: FakeExchange, deps: Deps) => placeBreakoutBet(deps, { ...spread(ex), stake: 12.4 }) },
] as const;

/** What the ledger says the account holds, against what the exchange says it holds: every contract, both ways round. */
function assertLedgerMatchesVenue(exchange: FakeExchange, ledger: Ledger): void {
  const mine = new Map<string, number>();
  for (const bet of ledger.data.bets) {
    for (const leg of bet.legs) {
      if (leg.quantityFilled <= 0) continue;
      const key = `${leg.symbol}|${leg.outcome}`;
      mine.set(key, clean((mine.get(key) ?? 0) + (leg.side === 'buy' ? 1 : -1) * leg.quantityFilled));
    }
  }
  for (const key of new Set([...mine.keys(), ...exchange.positions.keys()])) {
    const ledgerSays = mine.get(key) ?? 0;
    const venueSays = exchange.positions.get(key) ?? 0;
    assert.ok(Math.abs(ledgerSays - venueSays) < 1e-6, `${key}: the ledger holds ${ledgerSays}, the exchange holds ${venueSays}`);
  }
}

const tagsSent = (ex: FakeExchange) => ex.sent.map((o) => o.clientOrderId);

/** Gemini cannot be asked: every look-up by tag fails, as when its REST side is down. */
function cannotBeAsked(ex: FakeExchange): () => void {
  const real = ex.findOrder.bind(ex);
  ex.findOrder = async () => {
    throw new Error('fetch failed');
  };
  return () => {
    ex.findOrder = real;
  };
}

for (const product of PRODUCTS) {
  for (const [which, tag] of [
    ['first order', `gv-${product.id}-b`],
    ['second order', `gv-${product.id}-a1`],
  ] as const) {
    test(`${product.name}: the ${which} fills and its answer is lost: it is recorded as filled, nothing is sent twice, the ledger matches the account`, async () => {
      const { exchange, ledger, deps } = setup();
      await ensureBaseline(exchange, ledger, 'primary');
      exchange.failAfterSend = tag;
      const bet = await product.place(exchange, deps);

      assert.equal(bet.status, 'open');
      assert.deepEqual(bet.legs.map((l) => l.status), ['filled', 'filled']);
      assert.deepEqual(tagsSent(exchange), [`gv-${product.id}-b`, `gv-${product.id}-a1`], 'one order per leg, none re-sent under a new tag');
      assert.match(bet.legs.find((l) => l.clientOrderId === tag)!.note ?? '', /found on the exchange by its tag/);
      assert.equal(bet.payoffs?.hedged, true);
      assertLedgerMatchesVenue(exchange, ledger);
      const rec = await reconcile(exchange, ledger, 'primary');
      assert.equal(rec.ok, true);
      assert.deepEqual(rec.mismatches, []);
    });
  }
}

test('the exchange\'s history trails the order: it is asked again until it shows it, and the order is still sent once', async () => {
  const { exchange, ledger, deps } = setup();
  exchange.failAfterSend = 'gv-t1-b';
  exchange.findLag = 2; // "no such order" twice, though it is there
  let asked = 0;
  const real = exchange.findOrder.bind(exchange);
  exchange.findOrder = (tag) => (asked++, real(tag));
  const bet = await placeConditionalBet(deps, parlay(exchange));
  assert.equal(asked, 3);
  assert.equal(bet.status, 'open');
  assert.deepEqual(tagsSent(exchange), ['gv-t1-b', 'gv-t1-a1']);
  assertLedgerMatchesVenue(exchange, ledger);
});

test('the look-ups read only the newest orders, except the last, which reads everything', async () => {
  const { exchange, deps } = setup();
  exchange.failBeforeSend = 'gv-t1-b';
  const looks: Array<boolean | undefined> = [];
  const real = exchange.findOrder.bind(exchange);
  exchange.findOrder = (tag, opts) => (looks.push(opts?.recent), real(tag, opts));
  await placeConditionalBet(deps, parlay(exchange));
  assert.deepEqual(looks, [true, true, false]);
});

test('an order the exchange never received is an error, as before: no fill is invented, and the outcome simply fails', async () => {
  const { exchange, ledger, deps } = setup();
  exchange.failBeforeSend = 'gv-t1-b';
  const bet = await placeConditionalBet(deps, parlay(exchange));
  assert.equal(bet.status, 'failed');
  assert.equal(bet.legs[0]!.status, 'error');
  assert.match(bet.note ?? '', /Outcome order failed/);
  assert.deepEqual(tagsSent(exchange), []);
  assert.equal(await exchange.cash(), 1000);
  assertLedgerMatchesVenue(exchange, ledger);
});

test('a hedge the exchange never received is tried again under a new tag, as before, and the bet is still hedged once', async () => {
  const { exchange, ledger, deps } = setup();
  exchange.failBeforeSend = 'gv-t1-a1';
  const bet = await placeConditionalBet(deps, parlay(exchange));
  assert.equal(bet.status, 'open');
  assert.deepEqual(bet.legs.map((l) => `${l.clientOrderId}:${l.status}`), ['gv-t1-b:filled', 'gv-t1-a1:error', 'gv-t1-a2:filled']);
  assert.deepEqual(tagsSent(exchange), ['gv-t1-b', 'gv-t1-a2']);
  assertLedgerMatchesVenue(exchange, ledger);
});

test('one "no such order" is not enough to call an order unsent: asked once, the answer stays unknown', async () => {
  const { exchange, deps } = setup();
  exchange.failBeforeSend = 'gv-t1-b';
  const bet = await placeConditionalBet({ ...deps, lookupWaitsMs: [0] }, parlay(exchange));
  assert.equal(bet.legs[0]!.status, 'unknown');
  assert.equal(bet.status, 'unhedged');
});

test('an order the exchange refused is an error at once, without asking whether it filled', async () => {
  const { exchange, deps } = setup();
  const real = exchange.placeOrder.bind(exchange);
  exchange.placeOrder = async (req: OrderRequest) => {
    if (req.clientOrderId === 'gv-t1-b') throw new OrderNotSent('Gemini rejected the request: market is closed');
    return real(req);
  };
  let asked = 0;
  exchange.findOrder = async () => {
    asked++;
    return null;
  };
  const bet = await placeConditionalBet(deps, parlay(exchange));
  assert.equal(bet.status, 'failed');
  assert.equal(bet.legs[0]!.status, 'error');
  assert.equal(asked, 0, 'a refusal is final; there is nothing to look for');
});

test('the exchange cannot be asked about the first order: the bet says so, sends nothing more, and recovery settles it', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  exchange.failAfterSend = 'gv-t1-b';
  const restore = cannotBeAsked(exchange);
  const bet = await placeConditionalBet(deps, parlay(exchange));

  assert.equal(bet.status, 'unhedged', 'never "failed" (nothing staked) and never "open"');
  assert.equal(bet.note, UNKNOWN_NOTE);
  assert.deepEqual(bet.legs.map((l) => l.status), ['unknown']);
  assert.deepEqual(tagsSent(exchange), ['gv-t1-b'], 'no hedge, no unwind, no second try');

  // It must not be sold while an order has no confirmed result: the sale could leave a position behind.
  const quote = await quoteCashOut(deps, bet);
  assert.equal(quote.code, 'not_open');
  assert.match(quote.reason ?? '', /no confirmed result/);

  restore();
  // The same ledger that was saved at that moment, read by a new process.
  const reborn = new Ledger(ledger.path);
  assert.equal(await recoverBets({ ...deps, ledger: reborn }), 1);
  const found = reborn.bet('t1')!;
  assert.equal(found.legs[0]!.status, 'filled');
  assert.equal(found.status, 'unhedged', 'the outcome is held and the hedge was never sent: said so, not hidden');
  assert.deepEqual(tagsSent(exchange), ['gv-t1-b'], 'recovery looks the order up; it never sends it again');
  assertLedgerMatchesVenue(exchange, reborn);
});

test('the exchange cannot be asked about the hedge: no second hedge is sent, no unwind either, and recovery makes the bet open', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  exchange.failAfterSend = 'gv-t1-a1';
  const restore = cannotBeAsked(exchange);
  const bet = await placeConditionalBet(deps, parlay(exchange));

  assert.equal(bet.status, 'unhedged');
  assert.equal(bet.note, UNKNOWN_NOTE);
  assert.deepEqual(bet.legs.map((l) => `${l.clientOrderId}:${l.status}`), ['gv-t1-b:filled', 'gv-t1-a1:unknown']);
  assert.deepEqual(tagsSent(exchange), ['gv-t1-b', 'gv-t1-a1'], 'the hedge was sent once and is not sent again, and nothing was sold back');

  restore();
  assert.equal(await recoverBets(deps), 1);
  assert.equal(bet.status, 'open');
  assert.equal(bet.note, undefined);
  assert.equal(bet.payoffs?.hedged, true);
  assert.deepEqual(tagsSent(exchange), ['gv-t1-b', 'gv-t1-a1']);
  assertLedgerMatchesVenue(exchange, ledger);
  assert.equal((await reconcile(exchange, ledger, 'primary')).ok, true);
  // and now it settles like any other bet
  exchange.resolve(1800, 'no');
  exchange.resolve(1820, 'no');
  assert.equal((await settleBets(deps)).settled.length, 1);
  assert.equal((await reconcile(exchange, ledger, 'primary')).ok, true);
});

test('a bet with an order of unknown result is not settled on figures that leave the order out; once it is known it settles and the cash ties out', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  exchange.failAfterSend = 'gv-t1-a1';
  const restore = cannotBeAsked(exchange);
  const bet = await placeConditionalBet(deps, parlay(exchange));
  assert.equal(bet.status, 'unhedged');

  exchange.resolve(1800, 'no'); // the condition failed: the hedge the ledger does not know about pays the stake back
  exchange.resolve(1820, 'no');
  const early = await settleBets(deps);
  assert.equal(early.settled.length, 0);
  assert.equal(bet.status, 'unhedged');
  assert.equal(bet.settlement, undefined);

  restore();
  await recoverBets(deps);
  assert.equal((await settleBets(deps)).settled.length, 1);
  assert.equal(bet.status, 'settled');
  assert.ok(Math.abs(bet.settlement!.pnl) < 0.01, 'the stake came back');
  assert.equal((await reconcile(exchange, ledger, 'primary')).ok, true);
});

for (const product of PRODUCTS.slice(2)) {
  test(`${product.name}: the exchange cannot be asked about the second order: nothing is unwound or re-sent`, async () => {
    const { exchange, ledger, deps } = setup();
    exchange.failAfterSend = `gv-${product.id}-a1`;
    const restore = cannotBeAsked(exchange);
    const bet = await product.place(exchange, deps);
    assert.equal(bet.status, 'unhedged');
    assert.equal(bet.note, UNKNOWN_NOTE);
    assert.deepEqual(tagsSent(exchange), [`gv-${product.id}-b`, `gv-${product.id}-a1`]);
    restore();
    await recoverBets(deps);
    assert.equal(bet.status, 'open');
    assertLedgerMatchesVenue(exchange, ledger);
  });
}

test('an order Gemini says it accepted but whose record never appears is unknown, not an error: it is not sent again', async () => {
  const { exchange, deps } = setup();
  const real = exchange.placeOrder.bind(exchange);
  exchange.placeOrder = async (req: OrderRequest) => {
    if (req.clientOrderId !== 'gv-t1-a1') return real(req);
    throw new OrderUnconfirmed('Order gv-t1-a1 was accepted by Gemini (id 7) but its record did not appear; check it before retrying.');
  };
  const bet = await placeConditionalBet(deps, parlay(exchange)); // the exchange honestly answers "no such order" every time
  assert.equal(bet.legs.at(-1)!.status, 'unknown');
  assert.equal(bet.status, 'unhedged');
  assert.deepEqual(tagsSent(exchange), ['gv-t1-b'], 'no a2: it may well be on the account');
});

test('a bet already recorded as failed by an earlier version, whose order filled, is put right by recovery', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  exchange.failAfterSend = 'gv-t1-b';
  const restore = cannotBeAsked(exchange);
  const bet = await placeConditionalBet(deps, parlay(exchange));
  restore();
  // The ledger as the old code left it: the leg an "error", the bet "failed", cost 0, while the account holds the outcome.
  bet.legs[0]!.status = 'error';
  bet.status = 'failed';
  bet.note = 'Outcome order failed: connection dropped after the order was sent';
  ledger.save();

  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, false);
  assert.equal(rec.mismatches.length, 1, 'the order is named, not skipped');
  assert.equal(rec.mismatches[0]!.clientOrderId, 'gv-t1-b');
  assert.match(rec.mismatches[0]!.ledger, /^0 @ /);

  assert.equal(await recoverBets(deps), 1);
  assert.equal(bet.legs[0]!.status, 'filled');
  assert.equal(bet.status, 'unhedged');
  assertLedgerMatchesVenue(exchange, ledger);
  assert.equal((await reconcile(exchange, ledger, 'primary')).ok, true);
});

test('recovery leaves an error leg alone when the exchange agrees it never filled', async () => {
  const { exchange, ledger, deps } = setup();
  exchange.failBeforeSend = 'gv-t1-b';
  const bet = await placeConditionalBet(deps, parlay(exchange));
  assert.equal(bet.status, 'failed');
  assert.equal(await recoverBets(deps), 0);
  assert.equal(bet.status, 'failed');
  assert.equal(bet.legs[0]!.status, 'error');
  assertLedgerMatchesVenue(exchange, ledger);
});

test('recovery of an unknown order the exchange has no record of: the bet ends as failed, with a plain note, holding nothing', async () => {
  const { exchange, ledger, deps } = setup();
  exchange.failBeforeSend = 'gv-t1-b'; // it never reached the venue...
  const restore = cannotBeAsked(exchange); // ...but nobody could say so at the time
  const bet = await placeConditionalBet(deps, parlay(exchange));
  assert.equal(bet.status, 'unhedged');
  restore();
  assert.equal(await recoverBets(deps), 1);
  assert.equal(bet.status, 'failed');
  assert.equal(bet.legs[0]!.status, 'unfilled');
  assert.match(bet.note ?? '', /no record of this bet's order, so nothing was bought/);
  assertLedgerMatchesVenue(exchange, ledger);
});

test('an unwind whose sell has no confirmed result is not called "unwound"; once known, it is', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  const real = exchange.placeOrder.bind(exchange);
  exchange.placeOrder = async (req: OrderRequest) => {
    const res = await real(req);
    if (req.clientOrderId === 'gv-t1-b') exchange.setBook(1800, { bid: 0.5 }); // the hedge now costs too much: the bet is sold back
    return res;
  };
  exchange.failAfterSend = 'gv-t1-ub'; // the sell fills, its answer is lost
  const restore = cannotBeAsked(exchange);
  const bet = await placeConditionalBet(deps, { ...parlay(exchange), maxPrice: 0.8 });
  assert.equal(bet.status, 'unhedged');
  assert.equal(bet.note, UNKNOWN_NOTE);
  assert.equal(bet.legs.at(-1)!.status, 'unknown');
  assert.deepEqual(tagsSent(exchange), ['gv-t1-b', 'gv-t1-ub'], 'the sell is not sent again');
  restore();
  await recoverBets(deps);
  assert.equal(bet.status, 'unwound');
  assert.equal(bet.payoffs?.stake, bet.cost);
  assertLedgerMatchesVenue(exchange, ledger);
  assert.equal((await reconcile(exchange, ledger, 'primary')).ok, true);
});

test('recovery that cannot read the account leaves a doubtful leg as it is, and does not fail', async () => {
  const { exchange, ledger, deps } = setup();
  exchange.failBeforeSend = 'gv-t1-b';
  const bet = await placeConditionalBet(deps, parlay(exchange));
  assert.equal(bet.legs[0]!.status, 'error');
  exchange.allOrders = async () => {
    throw new Error('fetch failed');
  };
  assert.equal(await recoverBets(deps), 0);
  assert.equal(bet.status, 'failed');
  assert.equal(ledger.data.bets.length, 1);
});

// ------------------------------------------------------------------ through the real HTTP handler

test('POST /bets: the first order fills and its answer is lost: 201, an open bet, one order per leg, and the account matches', async () => {
  const app = await start(TIGHT, { orderLookupWaitsMs: [0, 0, 0] });
  try {
    app.exchange.failAfterSend = 'gv-api1-b';
    const res = await app.call('POST', '/bets', app.betBody());
    assert.equal(res.status, 201);
    assert.equal(res.json.bet.status, 'open');
    assert.deepEqual(res.json.bet.legs.map((l: { status: string }) => l.status), ['filled', 'filled']);
    assert.deepEqual(app.exchange.sent.map((o) => o.clientOrderId), ['gv-api1-b', 'gv-api1-a1']);
    assertLedgerMatchesVenue(app.exchange, app.ledger);
    assert.equal((await app.call('GET', '/reconcile')).json.ok, true);
  } finally {
    await app.close();
  }
});

test('POST /bets: the exchange cannot be asked: 201 with a bet that says it needs checking, and /reconcile names nothing wrongly', async () => {
  const app = await start(TIGHT, { orderLookupWaitsMs: [0, 0, 0] });
  try {
    app.exchange.failAfterSend = 'gv-api1-b';
    cannotBeAsked(app.exchange);
    const res = await app.call('POST', '/bets', app.betBody());
    assert.equal(res.status, 201);
    assert.equal(res.json.bet.status, 'unhedged');
    assert.equal(res.json.bet.note, UNKNOWN_NOTE);
    assert.deepEqual(app.exchange.sent.map((o) => o.clientOrderId), ['gv-api1-b']);
    // The cash-out says why it cannot be done, in the usual shape.
    const out = await app.call('POST', '/cashout', { bet: 'api1' });
    assert.equal(out.status, 409);
    assert.equal(out.json.code, 'not_open');
  } finally {
    await app.close();
  }
});
