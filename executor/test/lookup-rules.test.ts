/**
 * The rules by which an order whose answer was lost is looked up, and what recovery and settling do with the result.
 * Each test below pins one rule that no other test did, by making the exchange answer with a scripted sequence.
 *
 *   - a "no such order" count starts again when an order is seen: only the LAST two answers decide "never received"
 *   - an immediate-or-cancel order that still reads as open is not finished: it is asked about again, never taken as found
 *   - recovery leaves an "error" leg alone when the venue's own record of it shows nothing filled
 *   - an order that was sent but never recorded stops a bet from being settled or sold, like an unknown one
 *   - the real schedule of look-ups is 0, 0.5, 2 and 5 seconds after the lost answer
 *   - a range or a breakout whose FIRST order is unknown is held, with nothing else sent
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LOOKUP_WAITS_MS, UNKNOWN_NOTE, placeConditionalBet, recoverBets, settleBets } from '../src/bets.ts';
import type { Deps } from '../src/bets.ts';
import { quoteCashOut } from '../src/cashout.ts';
import type { OrderResult } from '../src/exchange.ts';
import { Ledger } from '../src/ledger.ts';
import { cannotBeAsked, start } from './api-harness.ts';
import { FakeExchange } from './fake.ts';

const LADDER = [
  { strike: 1780, bid: 0.88, ask: 0.9 },
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.6, ask: 0.62 },
  { strike: 1840, bid: 0.4, ask: 0.42 },
];

function setup(waits: number[] = [0, 0, 0]) {
  const exchange = new FakeExchange('ETHTEST', LADDER);
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-lookup-')), 'ledger.json'));
  let n = 0;
  const deps: Deps = { exchange, ledger, newId: () => `t${++n}`, now: () => new Date('2026-11-17T23:10:00Z'), waiveMarkup: false, lookupWaitsMs: waits };
  return { exchange, ledger, deps };
}
const parlay = (ex: FakeExchange) => ({ user: 'primary', eventTicker: 'ETHTEST', conditionSymbol: ex.symbol(1800), targetSymbol: ex.symbol(1820), stake: 10, slippageTicks: 0 });

/** An immediate-or-cancel order as an exchange can show it for a moment: listed, still open, nothing filled yet. */
const STILL_OPEN: OrderResult = { orderId: '9', filledQuantity: 0, avgPrice: null, open: true };

/** The exchange answers the next look-ups from this list (null is "no such order"); once it runs out, with the truth. */
function scripted(ex: FakeExchange, answers: Array<OrderResult | null>): { asked: () => number } {
  const real = ex.findOrder.bind(ex);
  let asked = 0;
  ex.findOrder = async (tag, opts) => {
    asked++;
    return answers.length > 0 ? answers.shift()! : real(tag, opts);
  };
  return { asked: () => asked };
}

// ------------------------------------------------------------------ lookUpOrder

test('"no such order" twice in a row means never received; an order that shows up in between starts the count again', async () => {
  const { exchange, deps } = setup([0, 0, 0, 0]);
  exchange.failAfterSend = 'gv-t1-b';
  // none, none, listed-but-open, none: two answers in a row were never given, so nothing can be said
  const look = scripted(exchange, [null, null, STILL_OPEN, null]);
  const bet = await placeConditionalBet(deps, parlay(exchange));
  assert.equal(look.asked(), 4);
  assert.equal(bet.legs[0]!.status, 'unknown', 'not "error": the exchange did show the order once, and then could not say');
  assert.equal(bet.status, 'unhedged');
  assert.equal(bet.note, UNKNOWN_NOTE);
  assert.deepEqual(exchange.sent.map((o) => o.clientOrderId), ['gv-t1-b'], 'nothing more is sent around an order that may have filled');
});

test('"no such order" in the last two looks is still enough, whatever came before', async () => {
  const { exchange, deps } = setup([0, 0, 0, 0]);
  exchange.failBeforeSend = 'gv-t1-b';
  scripted(exchange, [STILL_OPEN, null, null, null]);
  const bet = await placeConditionalBet(deps, parlay(exchange));
  assert.equal(bet.legs[0]!.status, 'error');
  assert.equal(bet.status, 'failed');
});

test('an immediate order that still reads open is asked about again, and the fill that follows is what is recorded', async () => {
  const { exchange, ledger, deps } = setup([0, 0]);
  exchange.failAfterSend = 'gv-t1-b';
  const look = scripted(exchange, [STILL_OPEN]); // the first look sees it open and empty; the second sees the fill
  const bet = await placeConditionalBet(deps, parlay(exchange));
  assert.equal(look.asked() >= 2, true);
  assert.equal(bet.legs[0]!.status, 'filled', 'not a resting order with nothing filled');
  assert.ok(bet.legs[0]!.quantityFilled > 0);
  assert.equal(bet.status, 'open');
  assert.deepEqual(exchange.sent.map((o) => o.clientOrderId), ['gv-t1-b', 'gv-t1-a1']);
  // the ledger and the account agree
  const held = ledger.data.bets[0]!.legs.filter((l) => l.symbol === exchange.symbol(1820)).reduce((q, l) => q + l.quantityFilled, 0);
  assert.equal(held, exchange.positions.get(`${exchange.symbol(1820)}|yes`));
});

test('an immediate order that never stops reading open is not taken as found: the leg is unknown, not a resting zero-fill order', async () => {
  const { exchange, deps } = setup([0, 0, 0]);
  exchange.failAfterSend = 'gv-t1-b';
  scripted(exchange, [STILL_OPEN, STILL_OPEN, STILL_OPEN]);
  const bet = await placeConditionalBet(deps, parlay(exchange));
  assert.equal(bet.legs[0]!.status, 'unknown');
  assert.equal(bet.status, 'unhedged');
});

test('the schedule of look-ups after a lost answer is pinned', () => {
  assert.deepEqual(LOOKUP_WAITS_MS, [0, 500, 1500, 3000]);
});

test('with no schedule given, a lost answer is looked up at 0, 0.5, 2 and 5 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { exchange, deps } = setup();
  const { lookupWaitsMs: _own, ...withDefaults } = deps;
  exchange.failBeforeSend = 'gv-t1-b';
  let elapsed = 0;
  const looks: number[] = [];
  const real = exchange.findOrder.bind(exchange);
  exchange.findOrder = (tag, opts) => (looks.push(elapsed), real(tag, opts));
  let finished = false;
  const placing = placeConditionalBet(withDefaults, parlay(exchange)).finally(() => (finished = true));
  while (!finished && elapsed < 20_000) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(100);
    elapsed += 100;
  }
  const bet = await placing;
  assert.deepEqual(looks, [0, 500, 2000, 5000]);
  assert.equal(bet.status, 'failed', 'four "no such order" answers, the last two in a row');
});

// ------------------------------------------------------------------ recoverBets

test('recovery leaves an "error" leg alone when the exchange lists the order with nothing filled', async () => {
  const { exchange, deps } = setup();
  exchange.failBeforeSend = 'gv-t1-b';
  const bet = await placeConditionalBet(deps, parlay(exchange));
  assert.equal(bet.legs[0]!.status, 'error');
  const note = bet.legs[0]!.note;
  // Afterwards the exchange does list the tag, as an order that filled nothing.
  exchange.orders.set('gv-t1-b', { orderId: '77', filledQuantity: 0, avgPrice: null, open: false, clientOrderId: 'gv-t1-b', symbol: exchange.symbol(1820), side: 'buy', createdAt: '2026-11-17T23:10:01Z' });
  assert.equal(await recoverBets(deps), 0, 'nothing was repaired');
  assert.equal(bet.legs[0]!.status, 'error');
  assert.equal(bet.legs[0]!.note, note, 'and no claim that it was found on the exchange is added');
  assert.equal(bet.status, 'failed');
});

test('recovery does apply an "error" leg the exchange shows filled', async () => {
  const { exchange, deps } = setup();
  exchange.failBeforeSend = 'gv-t1-b';
  const bet = await placeConditionalBet(deps, parlay(exchange));
  assert.equal(bet.status, 'failed');
  exchange.orders.set('gv-t1-b', { orderId: '78', filledQuantity: 5, avgPrice: 0.62, open: false, clientOrderId: 'gv-t1-b', symbol: exchange.symbol(1820), side: 'buy', createdAt: '2026-11-17T23:10:01Z' });
  assert.equal(await recoverBets(deps), 1);
  assert.equal(bet.legs[0]!.status, 'partial');
  assert.match(bet.legs[0]!.note ?? '', /found on the exchange by its tag/);
});

// ------------------------------------------------------------------ hasUnresolvedLeg

test('an order that was sent and never recorded keeps its bet from being settled or sold, as an unknown one does', async () => {
  const { exchange, ledger, deps } = setup();
  const bet = await placeConditionalBet(deps, parlay(exchange));
  assert.equal(bet.status, 'open');
  // As a crash between sending and recording leaves it: the hedge's result is not in the ledger.
  bet.legs[1]!.status = 'sent';
  ledger.save();

  const quote = await quoteCashOut(deps, bet);
  assert.equal(quote.available, false);
  assert.equal(quote.code, 'not_open');
  assert.match(quote.reason ?? '', /no confirmed result/);

  exchange.resolve(1800, 'no');
  exchange.resolve(1820, 'no');
  const done = await settleBets(deps);
  assert.equal(done.settled.length, 0, 'what it paid cannot be worked out while an order is unaccounted for');
  assert.equal(bet.status, 'open');
  assert.equal(bet.settlement, undefined);

  bet.legs[1]!.status = 'filled';
  assert.equal((await settleBets(deps)).settled.length, 1, 'once every order is accounted for it settles');
});

// ------------------------------------------------------------------ a range or breakout whose first order is unknown

for (const product of [
  { name: 'range', id: 'rg-api1', body: { product: 'range', stake: 14.2 } },
  { name: 'breakout', id: 'bo-api1', body: { product: 'breakout', stake: 12.4 } },
] as const) {
  test(`POST /bets, a ${product.name} whose first order filled and could not be asked about: 201, held as unhedged, nothing else sent`, async () => {
    const app = await start(LADDER, { waiveMarkup: true, orderLookupWaitsMs: [0, 0, 0] });
    try {
      app.exchange.failAfterSend = `gv-${product.id}-b`;
      const restore = cannotBeAsked(app.exchange);
      const res = await app.call('POST', '/bets', { ...product.body, user: 'primary', event: 'ETHTEST', low: app.exchange.symbol(1800), high: app.exchange.symbol(1840), slippageTicks: 0 });
      assert.equal(res.status, 201);
      assert.equal(res.json.bet.id, product.id);
      assert.equal(res.json.bet.status, 'unhedged', 'not "failed": the account holds the first order');
      assert.equal(res.json.bet.note, UNKNOWN_NOTE);
      assert.deepEqual(res.json.bet.legs.map((l: { status: string }) => l.status), ['unknown']);
      assert.deepEqual(app.exchange.sent.map((o) => o.clientOrderId), [`gv-${product.id}-b`], 'no second order, no unwind');

      restore();
      assert.equal(await recoverBets({ exchange: app.exchange, ledger: app.ledger, waiveMarkup: true }), 1);
      assert.equal(app.ledger.bet(product.id)!.legs[0]!.status, 'filled');
      assert.equal(app.exchange.sent.length, 1);
    } finally {
      await app.close();
    }
  });
}
