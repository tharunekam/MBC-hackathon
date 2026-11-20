/**
 * An order whose answer was lost and which the exchange could not account for stays "unknown", and its bet cannot be sold or
 * settled. It used to be looked at again only when the process started, so it waited for a restart. Now the auto-settle timer
 * looks it up again by tag: once the order is a minute old, at most every five minutes per bet, only the orders it names
 * (never the account's whole order list). The clock is injected, so none of this waits.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RECHECK_AFTER_MS, RECHECK_EVERY_MS, UNKNOWN_NOTE, placeConditionalBet, recheckUnresolved } from '../src/bets.ts';
import type { Deps } from '../src/bets.ts';
import { Ledger } from '../src/ledger.ts';
import { cannotBeAsked, start } from './api-harness.ts';
import { FakeExchange } from './fake.ts';

const LADDER = [
  { strike: 1780, bid: 0.88, ask: 0.9 },
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.6, ask: 0.62 },
  { strike: 1840, bid: 0.4, ask: 0.42 },
];
const T0 = Date.parse('2026-11-17T23:10:00Z');

function setup() {
  const exchange = new FakeExchange('ETHTEST', LADDER);
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-recheck-')), 'ledger.json'));
  let n = 0;
  const clock = { at: T0 };
  const deps: Deps = { exchange, ledger, newId: () => `t${++n}`, now: () => new Date(clock.at), waiveMarkup: false, lookupWaitsMs: [0, 0, 0] };
  // What the exchange is asked, so a test can say what was NOT asked.
  const reads = { byTag: 0, allOrders: 0 };
  const find = exchange.findOrder.bind(exchange);
  exchange.findOrder = (tag, opts) => (reads.byTag++, find(tag, opts));
  const all = exchange.allOrders.bind(exchange);
  exchange.allOrders = () => (reads.allOrders++, all());
  return { exchange, ledger, deps, clock, reads, checkedAt: new Map<string, number>() };
}
const parlay = (ex: FakeExchange, user = 'primary') => ({ user, eventTicker: 'ETHTEST', conditionSymbol: ex.symbol(1800), targetSymbol: ex.symbol(1820), stake: 10, slippageTicks: 0 });

/** A bet whose first order filled at the exchange and whose answer was lost, with the exchange unable to say so. */
async function unknownBet(s: ReturnType<typeof setup>, user = 'primary') {
  s.exchange.failAfterSend = `gv-t${s.ledger.data.bets.length + 1}-b`;
  const restore = cannotBeAsked(s.exchange);
  const bet = await placeConditionalBet(s.deps, parlay(s.exchange, user));
  restore();
  s.reads.byTag = 0; // the look-ups the bet itself made while it was being placed are not what these tests count
  assert.equal(bet.legs[0]!.status, 'unknown');
  return bet;
}

test('the limits are a minute for the age of the order and five minutes between looks at one bet', () => {
  assert.equal(RECHECK_AFTER_MS, 60_000);
  assert.equal(RECHECK_EVERY_MS, 300_000);
});

test('an order younger than a minute is left alone: it may still be in flight', async () => {
  const s = setup();
  const bet = await unknownBet(s);
  s.reads.byTag = 0;
  s.clock.at = T0 + 59_000;
  assert.equal(await recheckUnresolved(s.deps, 'primary', s.checkedAt), 0);
  assert.equal(s.reads.byTag, 0, 'nothing was asked');
  assert.equal(bet.legs[0]!.status, 'unknown');
  assert.equal(bet.note, UNKNOWN_NOTE);
});

test('a minute on, the order is looked up by its tag and the bet is put right, on disk too; the account\'s whole order list is never read', async () => {
  const s = setup();
  const bet = await unknownBet(s);
  // The bet also has an order the exchange refused. Looking at that one means reading the whole order list: not done here.
  bet.legs.push({ clientOrderId: 'gv-t1-a0', role: 'hedge', symbol: s.exchange.symbol(1800), side: 'buy', outcome: 'no', limitPrice: 0.2, quantityRequested: 5, quantityFilled: 0, avgPrice: null, fee: 0, status: 'error', sentAt: new Date(T0).toISOString(), note: 'refused' });
  s.reads.byTag = 0;
  s.clock.at = T0 + 61_000;
  assert.equal(await recheckUnresolved(s.deps, 'primary', s.checkedAt), 1);
  assert.equal(s.reads.byTag, 1);
  assert.equal(s.reads.allOrders, 0, 'only the order it names is read');
  assert.equal(bet.legs[0]!.status, 'filled');
  assert.equal(bet.legs[1]!.status, 'error', 'the refused order was left as it was');
  assert.equal(bet.status, 'unhedged', 'the outcome is held and the hedge was never sent: said so, not hidden');
  assert.doesNotMatch(bet.note ?? '', /did not confirm/, 'the unknown note is gone: the order is accounted for');
  assert.deepEqual(s.exchange.sent.map((o) => o.clientOrderId), ['gv-t1-b'], 'looked up, never sent again');
  assert.equal(new Ledger(s.ledger.path).bet('t1')!.legs[0]!.status, 'filled');
});

test('a hedge that filled is found and the bet becomes open without a restart', async () => {
  const s = setup();
  s.exchange.failAfterSend = 'gv-t1-a1';
  const restore = cannotBeAsked(s.exchange);
  const bet = await placeConditionalBet(s.deps, parlay(s.exchange));
  restore();
  assert.equal(bet.status, 'unhedged');
  assert.equal(bet.note, UNKNOWN_NOTE);
  s.clock.at = T0 + 90_000;
  assert.equal(await recheckUnresolved(s.deps, 'primary', s.checkedAt), 1);
  assert.equal(bet.status, 'open');
  assert.equal(bet.note, undefined);
  assert.equal(bet.payoffs?.hedged, true);
  assert.equal(s.exchange.sent.length, 2);
});

test('an order the exchange never received is put right the same way: its bet fails with a plain note', async () => {
  const s = setup();
  s.exchange.failBeforeSend = 'gv-t1-b';
  const restore = cannotBeAsked(s.exchange);
  const bet = await placeConditionalBet(s.deps, parlay(s.exchange));
  restore();
  assert.equal(bet.status, 'unhedged');
  s.clock.at = T0 + 61_000;
  assert.equal(await recheckUnresolved(s.deps, 'primary', s.checkedAt), 1);
  assert.equal(bet.legs[0]!.status, 'unfilled');
  assert.equal(bet.status, 'failed');
  assert.match(bet.note ?? '', /no record of this bet's order, so nothing was bought/);
});

test('a bet is looked at at most once every five minutes, and an exchange that cannot answer leaves it exactly as it was', async () => {
  const s = setup();
  const bet = await unknownBet(s);
  let tries = 0;
  let canAnswer = false;
  const answering = s.exchange.findOrder;
  s.exchange.findOrder = async (tag, opts) => {
    tries++;
    if (!canAnswer) throw new Error('fetch failed');
    return answering(tag, opts);
  };

  s.clock.at = T0 + 61_000;
  assert.equal(await recheckUnresolved(s.deps, 'primary', s.checkedAt), 0);
  assert.equal(tries, 1, 'looked at');
  assert.equal(bet.legs[0]!.status, 'unknown', 'left as it was: an exchange that cannot say has said nothing');
  assert.equal(bet.note, UNKNOWN_NOTE);
  assert.equal(bet.status, 'unhedged');

  s.clock.at = T0 + 61_000 + RECHECK_EVERY_MS - 1_000;
  assert.equal(await recheckUnresolved(s.deps, 'primary', s.checkedAt), 0);
  assert.equal(tries, 1, 'a little under five minutes later: not again yet');

  canAnswer = true;
  s.clock.at = T0 + 61_000 + RECHECK_EVERY_MS;
  assert.equal(await recheckUnresolved(s.deps, 'primary', s.checkedAt), 1);
  assert.equal(tries, 2, 'five minutes after the last look: again, and now it answers');
  assert.equal(bet.legs[0]!.status, 'filled');
});

test('only the named user\'s bets with an unaccounted order are looked at: a healthy bet or another account\'s is not', async () => {
  const s = setup();
  const mine = await unknownBet(s, 'primary');
  const theirs = await unknownBet(s, 'alice');
  const healthy = await placeConditionalBet(s.deps, { ...parlay(s.exchange), conditionSymbol: s.exchange.symbol(1780), targetSymbol: s.exchange.symbol(1840) });
  assert.equal(healthy.status, 'open');
  s.reads.byTag = 0;
  s.clock.at = T0 + 3_600_000; // an hour on
  assert.equal(await recheckUnresolved(s.deps, 'primary', s.checkedAt), 1);
  assert.equal(s.reads.byTag, 1, 'one order, the primary account\'s');
  assert.equal(mine.legs[0]!.status, 'filled');
  assert.equal(theirs.legs[0]!.status, 'unknown');
  assert.equal(healthy.status, 'open');
  assert.deepEqual([...s.checkedAt.keys()], [mine.id], 'only the bet that was looked at is remembered as looked at');
});

test('an order whose sent time cannot be read counts as old, and a bet that was never looked at as due', async () => {
  const s = setup();
  const bet = await unknownBet(s);
  bet.legs[0]!.sentAt = 'not a time';
  s.clock.at = T0 + 1_000;
  assert.equal(await recheckUnresolved(s.deps, 'primary', s.checkedAt), 1);
  assert.equal(bet.legs[0]!.status, 'filled');
});

// ------------------------------------------------------------------ on the server's own timer

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > end) return v;
    await sleep(15);
  }
}

test('the auto-settle timer puts a bet with an unaccounted order right once the order is a minute old, without a restart, and then stops asking', async () => {
  const app = await start(LADDER, { waiveMarkup: true, orderLookupWaitsMs: [0, 0, 0], autoSettleMs: 15 });
  try {
    app.exchange.failAfterSend = 'gv-api1-a1';
    const restore = cannotBeAsked(app.exchange);
    const placed = await app.call('POST', '/bets', app.betBody({ condition: app.exchange.symbol(1800), target: app.exchange.symbol(1820) }));
    assert.equal(placed.json.bet.status, 'unhedged');
    assert.equal(placed.json.bet.note, UNKNOWN_NOTE);
    restore();
    let asked = 0;
    const find = app.exchange.findOrder.bind(app.exchange);
    app.exchange.findOrder = (tag, opts) => (asked++, find(tag, opts));

    // The clock has not moved: the order is not a minute old, so however often the timer fires it asks nothing.
    await sleep(120);
    assert.equal(asked, 0);
    assert.equal((await app.call('GET', '/bets')).json.bets[0].status, 'unhedged');

    app.setClock('2026-11-17T23:11:05Z'); // 65 seconds on
    const bet = await until(async () => (await app.call('GET', '/bets')).json.bets[0], (b) => b.status === 'open');
    assert.equal(bet.status, 'open');
    assert.equal(bet.note, undefined);
    assert.deepEqual(bet.legs.map((l: { status: string }) => l.status), ['filled', 'filled']);
    assert.equal(app.exchange.sent.length, 2, 'found by its tag, never sent again');
    assert.equal(asked, 1);

    await sleep(120);
    assert.equal(asked, 1, 'an accounted-for bet is not asked about again');
  } finally {
    await app.close();
  }
});

test('the timer asks about a bet at most once in five minutes while the exchange cannot answer', async () => {
  const app = await start(LADDER, { waiveMarkup: true, orderLookupWaitsMs: [0, 0, 0], autoSettleMs: 15 });
  try {
    app.exchange.failAfterSend = 'gv-api1-b';
    cannotBeAsked(app.exchange);
    const placed = await app.call('POST', '/bets', app.betBody({ condition: app.exchange.symbol(1800), target: app.exchange.symbol(1820) }));
    assert.equal(placed.json.bet.legs[0].status, 'unknown');
    let asked = 0;
    const down = app.exchange.findOrder;
    app.exchange.findOrder = (tag, opts) => (asked++, down(tag, opts));

    app.setClock('2026-11-17T23:11:05Z');
    await until(async () => asked, (n) => n >= 1);
    await sleep(150);
    assert.equal(asked, 1, 'many ticks, one look');
    const bet = (await app.call('GET', '/bets')).json.bets[0];
    assert.equal(bet.legs[0].status, 'unknown');
    assert.equal(bet.note, UNKNOWN_NOTE);

    app.setClock('2026-11-17T23:16:06Z'); // five minutes after the look
    await until(async () => asked, (n) => n >= 2);
    assert.equal(asked, 2);
  } finally {
    await app.close();
  }
});
