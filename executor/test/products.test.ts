import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BasketRefused, placeBasket } from '../src/basket.ts';
import { betIdFor, kindOfBetId } from '../src/bet-id.ts';
import { BetRefused, isScorable, placeConditionalBet, recoverBets, settleBets } from '../src/bets.ts';
import { Ledger } from '../src/ledger.ts';
import { flipOutcome, mirrorBook, mirrorEvent, orient, realStrike } from '../src/mirror.ts';
import { findPair, linkedPairs, realRung } from '../src/pairs.ts';
import { assessRange, capRangeToDepth, findRange, planRange, rangeContractsFor } from '../src/range.ts';
import { placeRangeBet } from '../src/range-bet.ts';
import { ensureBaseline, reconcile } from '../src/reconcile.ts';
import { rangePrice } from '../src/pricing.ts';
import { FakeExchange } from './fake.ts';

const near = (actual: number, expected: number, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);

/**
 * A tight four-strike ladder: every pair and range here passes the offer rule as it stands, so these tests are about what
 * each product buys and pays, not about value. Chances of finishing at or above: 1780 89%, 1800 81%, 1820 61%, 1840 41%.
 */
const LADDER = [
  { strike: 1780, bid: 0.88, ask: 0.9 },
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.6, ask: 0.62 },
  { strike: 1840, bid: 0.4, ask: 0.42 },
];

function setup(strikes: ConstructorParameters<typeof FakeExchange>[1] = LADDER) {
  const exchange = new FakeExchange('ETHTEST', strikes);
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-products-')), 'ledger.json'));
  let n = 0;
  // lookupWaitsMs: after a lost answer an order is looked up by its tag at once, not over several seconds.
  const deps = { exchange, ledger, newId: () => `t${++n}`, now: () => new Date('2026-11-17T23:10:00Z'), waiveMarkup: false, lookupWaitsMs: [0, 0] };
  return { exchange, ledger, deps };
}

/** Makes the depth read report a full book, so a test can thin the REAL book out after the bet was sized. */
const pretendDeep = (ex: FakeExchange, strike: number) => ex.reportedDepth.set(ex.symbol(strike), { bidSize: 1000, askSize: 1000 });

// ------------------------------------------------------------------ the mirror

test('the mirror: strikes negate, books flip, results swap, and mirroring twice gives back the ladder', async () => {
  const { exchange } = setup();
  const real = await exchange.getEvent('ETHTEST');
  const mirrored = mirrorEvent(real);
  const c = mirrored.contracts.find((x) => x.instrumentSymbol === exchange.symbol(1800))!;
  assert.equal(c.strike?.value, '-1800');
  assert.equal(c.prices?.bestBid, '0.18'); // 1 - the real ask of 0.82
  assert.equal(c.prices?.bestAsk, '0.2'); //  1 - the real bid of 0.8
  assert.deepEqual(mirrorBook({ symbol: 'X', bid: 0.8, bidSize: 5, ask: 0.82, askSize: 7 }), { symbol: 'X', bid: 0.18, bidSize: 7, ask: 0.2, askSize: 5 });
  assert.deepEqual(mirrorBook(mirrorBook({ symbol: 'X', bid: 0.8, bidSize: 5, ask: 0.82, askSize: 7 })), { symbol: 'X', bid: 0.8, bidSize: 5, ask: 0.82, askSize: 7 });
  assert.equal(flipOutcome('yes'), 'no');
  assert.equal(orient('down', 'yes'), 'no');
  assert.equal(orient('up', 'yes'), 'yes');
  assert.equal(realStrike('down', -1800), 1800);
});

test('the mirror: a result of "yes" becomes "no" and anything else, such as a void, is left as reported', () => {
  const event = mirrorEvent({
    id: '1',
    title: 't',
    ticker: 'T',
    category: 'Crypto',
    status: 'settled',
    contracts: [
      { id: 'a', label: 'a', ticker: 'a', instrumentSymbol: 'A', status: 'settled', resolutionSide: 'yes' },
      { id: 'b', label: 'b', ticker: 'b', instrumentSymbol: 'B', status: 'settled', resolutionSide: 'no' },
      { id: 'c', label: 'c', ticker: 'c', instrumentSymbol: 'C', status: 'settled', resolutionSide: 'UNSPECIFIED' },
    ],
  });
  assert.deepEqual(event.contracts.map((c) => c.resolutionSide), ['no', 'yes', 'UNSPECIFIED']);
});

test('falling pairs: the condition is the higher strike, and the real rungs come back the right way up', async () => {
  const { exchange } = setup();
  const event = await exchange.getEvent('ETHTEST');
  const pairs = linkedPairs(event, { direction: 'down' });
  assert.equal(pairs.length, 6); // four strikes, every lower-and-higher combination
  const p = findPair(event, exchange.symbol(1840), exchange.symbol(1800), 0, false, 'down');
  assert.equal(p.a.strike, -1840);
  assert.equal(realRung(p.a, 'down').strike, 1840);
  assert.equal(realRung(p.a, 'down').bid, 0.4);
  assert.equal(realRung(p.a, 'down').ask, 0.42);
  // chance the condition holds is the chance of finishing BELOW 1840, from the middle of its book
  near(p.offer.chanceCondition!, 0.59);
  near(p.offer.chanceBothHappen!, 0.19);
  assert.equal(p.offer.offerable, true);
  assert.throws(() => findPair(event, exchange.symbol(1800), exchange.symbol(1840), 0, false, 'down'), /outcome strike lower than the condition strike/);
  assert.throws(() => findPair(event, exchange.symbol(1840), exchange.symbol(1800), 0, false, 'up'), /outcome strike higher than the condition strike/);
});

// ------------------------------------------------------------------ the falling parlay

const down = (ex: FakeExchange, extra: object = {}) => ({
  user: 'primary',
  eventTicker: 'ETHTEST',
  conditionSymbol: ex.symbol(1840), // it stays below 1840 ...
  targetSymbol: ex.symbol(1800), //    ... and then falls below 1800
  direction: 'down' as const,
  stake: 10,
  slippageTicks: 0,
  ...extra,
});

test('a falling parlay: a NO on the lower strike and a YES on the higher, stake protected, cash conserved', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeConditionalBet(deps, down(exchange));

  assert.equal(bet.status, 'open');
  assert.equal(bet.product, 'parlay');
  assert.equal(bet.direction, 'down');
  assert.equal(bet.condition.strike, 1840); // real strikes, not the mirror's
  assert.equal(bet.target.strike, 1800);
  assert.equal(bet.legs.length, 2);
  assert.deepEqual([bet.legs[0]!.symbol, bet.legs[0]!.outcome, bet.legs[0]!.side], [exchange.symbol(1800), 'no', 'buy']);
  assert.deepEqual([bet.legs[1]!.symbol, bet.legs[1]!.outcome, bet.legs[1]!.side], [exchange.symbol(1840), 'yes', 'buy']);
  near(bet.legs[0]!.avgPrice!, 0.2); // a NO on 1800 costs 1 minus its YES bid
  near(bet.legs[1]!.avgPrice!, 0.42); // a YES on 1840 costs its ask
  assert.equal(bet.payoffs!.hedged, true);
  assert.ok(bet.payoffs!.ifConditionFails! >= 0 && bet.payoffs!.ifConditionFails! < 0.01);
  near(bet.cost, bet.legs[0]!.quantityFilled * 0.2 + bet.legs[1]!.quantityFilled * 0.42);
  near(await exchange.cash(), 1000 - bet.cost);

  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true);
  assert.equal(rec.mismatches.length, 0);
});

for (const [name, resolve1840, resolve1800, conditionResolved, targetResolved] of [
  ['it finishes below 1800: the bet wins', 'no', 'no', 'yes', 'yes'],
  ['it finishes between 1800 and 1840: the bet loses', 'no', 'yes', 'yes', 'no'],
  ['it finishes at or above 1840: the stake comes back', 'yes', 'yes', 'no', 'no'],
] as const) {
  test(`a falling parlay settles correctly when ${name}`, async () => {
    const { exchange, ledger, deps } = setup();
    await ensureBaseline(exchange, ledger, 'primary');
    const bet = await placeConditionalBet(deps, down(exchange));
    const predicted = { ...bet.payoffs! };
    exchange.resolve(1840, resolve1840);
    exchange.resolve(1800, resolve1800);
    const done = await settleBets(deps);
    assert.equal(done.settled.length, 1);
    assert.equal(bet.settlement!.conditionResolved, conditionResolved);
    assert.equal(bet.settlement!.targetResolved, targetResolved);
    assert.equal(isScorable(bet), true);
    const expected = targetResolved === 'yes' ? predicted.ifBothHit : conditionResolved === 'no' ? predicted.ifConditionFails! : predicted.ifConditionOnly;
    near(bet.settlement!.pnl, expected);
    near(await exchange.cash(), 1000 + bet.settlement!.pnl);
    const rec = await reconcile(exchange, ledger, 'primary');
    assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
  });
}

test('a falling parlay whose hedge cannot fill is sold back, on the right sides, and nothing is left open', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  pretendDeep(exchange, 1840);
  exchange.setBook(1840, { askSize: 0 }); // the YES the hedge needs is gone after the bet was sized
  const bet = await placeConditionalBet(deps, down(exchange));
  assert.equal(bet.status, 'unwound');
  const unwind = bet.legs.filter((l) => l.role === 'unwind');
  assert.equal(unwind.length, 1);
  assert.deepEqual([unwind[0]!.symbol, unwind[0]!.side, unwind[0]!.outcome], [exchange.symbol(1800), 'sell', 'no']);
  assert.equal(exchange.positions.get(`${exchange.symbol(1800)}|no`) ?? 0, 0);
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
});

test('a falling parlay is checked against the mirror: a pair that is poor value there is refused with no order sent', async () => {
  const { exchange, deps } = setup([
    { strike: 1800, bid: 0.83, ask: 0.97 },
    { strike: 1840, bid: 0.35, ask: 0.54 },
  ]);
  await assert.rejects(placeConditionalBet(deps, down(exchange)), (err: unknown) => err instanceof BetRefused && err.code === 'offer_refused');
  assert.equal(exchange.sent.length, 0);
});

for (const [name, id, place] of [
  ['a falling parlay', 'dn-t1', (ex: FakeExchange, deps: ReturnType<typeof setup>['deps']) => placeConditionalBet(deps, down(ex))],
  ['a range bet', 'rg-t1', (ex: FakeExchange, deps: ReturnType<typeof setup>['deps']) => placeRangeBet(deps, range(ex))],
] as const) {
  test(`${name} interrupted mid-bet is recovered by its tag, never resent, and its legs read on the right sides`, async () => {
    const { exchange, ledger, deps } = setup();
    await ensureBaseline(exchange, ledger, 'primary');
    exchange.failAfterSend = `gv-${id}-b`; // the first order reaches the venue, then the connection dies
    const lookup = exchange.findOrder.bind(exchange);
    exchange.findOrder = async () => {
      throw new Error('fetch failed'); // and Gemini cannot be asked about it either, so the answer stays lost
    };
    const bet = await place(exchange, deps);
    exchange.findOrder = lookup;
    assert.equal(bet.status, 'unhedged'); // we could not confirm it, so the bet says so and sends nothing more...
    assert.equal(bet.legs[0]!.status, 'unknown');
    assert.equal(bet.legs.length, 1);
    assert.ok(exchange.orders.get(`gv-${id}-b`)!.filledQuantity > 0); // ...but it did fill

    // Simulate the crash state a restart would see: order recorded as sent, bet still placing.
    bet.legs[0]!.status = 'sent';
    bet.status = 'placing';
    ledger.save();

    const reloaded = new Ledger(ledger.path);
    const fixed = await recoverBets({ ...deps, ledger: reloaded });
    assert.equal(fixed, 1);
    const recovered = reloaded.bet(id)!;
    assert.equal(recovered.legs[0]!.quantityFilled, exchange.orders.get(`gv-${id}-b`)!.filledQuantity);
    assert.equal(recovered.status, 'unhedged'); // the truth: first leg bought, second never sent
    assert.equal(exchange.sent.filter((o) => o.clientOrderId === `gv-${id}-b`).length, 1); // never sent twice
  });
}

// ------------------------------------------------------------------ range: the maths

test('range price: the cost of the second dollar is what the pair costs above the dollar that always comes back', () => {
  near(rangePrice(0.82, 0.4)!, 0.42); // askL - bidH
  assert.equal(rangePrice(0.4, 0.8), null); // a lower strike cheaper than a higher one is not a range
  near(rangePrice(0.82, 0.4, 0.07)!, 0.82 + 0.07 * 0.82 * 0.18 + 0.6 + 0.07 * 0.6 * 0.4 - 1);
});

test('range plan: what a stake buys, what comes back whatever happens, and what each result nets', () => {
  const q = rangeContractsFor(14.2, 0.82, 0.4, 0);
  near(q, 10);
  const plan = planRange(q, 0.82, 0.4, 0);
  near(plan.cost, 14.2);
  near(plan.backAlways, 10);
  near(plan.ifInRange, 5.8);
  near(plan.ifOutside, -4.2);
  assert.ok(rangeContractsFor(14.2, 0.82, 0.4, 0.07) * 1 < q + 1e-9); // fees mean fewer contracts for the same stake
  const withFees = rangeContractsFor(14.2, 0.82, 0.4, 0.07);
  assert.ok(planRange(withFees, 0.82, 0.4, 0.07).cost <= 14.2 + 1e-9);
  assert.equal(capRangeToDepth(10, 4, 100), 4);
  assert.equal(capRangeToDepth(10, 100, 3), 3);
  assert.equal(capRangeToDepth(10, 100, 100), 10);
});

test('range offer: chance is the lower strike minus the higher, and the usual refusals apply', async () => {
  const { exchange } = setup();
  const event = await exchange.getEvent('ETHTEST');
  const p = findRange(event, exchange.symbol(1800), exchange.symbol(1840));
  near(p.offer.chanceInRange!, 0.4);
  near(p.offer.fairPrice!, 0.4);
  near(p.offer.pricePaid!, 0.42);
  assert.equal(p.offer.offerable, true);
  assert.ok(p.offer.cashOutPer100! > 90 && p.offer.cashOutPer100! < 100);
  assert.throws(() => findRange(event, exchange.symbol(1840), exchange.symbol(1800)), /not a range/);

  const wide = new FakeExchange('WIDE', [
    { strike: 1800, bid: 0.83, ask: 0.97 },
    { strike: 1840, bid: 0.35, ask: 0.54 },
  ]);
  const w = findRange(await wide.getEvent('WIDE'), wide.symbol(1800), wide.symbol(1840));
  assert.equal(w.offer.offerable, false);
  assert.ok(w.offer.reasons.some((r) => r.code === 'markup_too_high'));
  const waived = findRange(await wide.getEvent('WIDE'), wide.symbol(1800), wide.symbol(1840), 0, true);
  assert.equal(waived.offer.offerable, true);
  assert.equal(waived.offer.overridden, true);

  const one = new FakeExchange('ONE', [
    { strike: 1800, bid: 0.8, ask: 0.82 },
    { strike: 1840, bid: null, ask: null },
  ]);
  const o = findRange(await one.getEvent('ONE'), one.symbol(1800), one.symbol(1840));
  assert.ok(o.offer.reasons.some((r) => r.code === 'one_sided_book'));
  assert.equal(assessRange([], { ...p.low, open: false }, p.high).reasons[0]!.code, 'market_closed');
});

// ------------------------------------------------------------------ range: placing and settling

const range = (ex: FakeExchange, extra: object = {}) => ({
  user: 'primary',
  eventTicker: 'ETHTEST',
  lowSymbol: ex.symbol(1800),
  highSymbol: ex.symbol(1840),
  stake: 14.2,
  slippageTicks: 0,
  ...extra,
});

test('a range bet: YES on the lower strike and NO on the higher, equal size, cash conserved', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeRangeBet(deps, range(exchange));

  assert.equal(bet.status, 'open');
  assert.equal(bet.product, 'range');
  assert.equal(bet.condition.strike, 1800);
  assert.equal(bet.target.strike, 1840);
  assert.equal(bet.legs.length, 2);
  assert.deepEqual([bet.legs[0]!.symbol, bet.legs[0]!.outcome, bet.legs[0]!.side], [exchange.symbol(1800), 'yes', 'buy']);
  assert.deepEqual([bet.legs[1]!.symbol, bet.legs[1]!.outcome, bet.legs[1]!.side], [exchange.symbol(1840), 'no', 'buy']);
  assert.equal(bet.legs[0]!.quantityFilled, 10);
  assert.equal(bet.legs[1]!.quantityFilled, 10);
  near(bet.cost, 14.2);
  assert.equal(bet.payoffs!.hedged, true);
  near(bet.payoffs!.ifInRange!, 5.8);
  near(bet.payoffs!.ifOutside!, -4.2);
  near(bet.payoffs!.ifBothHit, 5.8); // the win and loss lines every consumer reads carry the same numbers
  near(bet.payoffs!.ifConditionOnly, -4.2);
  assert.equal(bet.payoffs!.ifConditionFails, undefined); // a range has no refund line
  near(bet.payoffs!.conditionalPrice!, 0.42);
  near(await exchange.cash(), 1000 - 14.2);

  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
  assert.equal(rec.mismatches.length, 0);
});

for (const [name, resolve1800, resolve1840, targetResolved, payout] of [
  ['it finishes inside the range', 'yes', 'no', 'yes', 20],
  ['it finishes above the range', 'yes', 'yes', 'no', 10],
  ['it finishes below the range', 'no', 'no', 'no', 10],
] as const) {
  test(`a range bet settles correctly when ${name}`, async () => {
    const { exchange, ledger, deps } = setup();
    await ensureBaseline(exchange, ledger, 'primary');
    const bet = await placeRangeBet(deps, range(exchange));
    exchange.resolve(1800, resolve1800);
    exchange.resolve(1840, resolve1840);
    const done = await settleBets(deps);
    assert.equal(done.settled.length, 1);
    assert.equal(bet.settlement!.conditionResolved, 'yes'); // never refunded, so never void
    assert.equal(bet.settlement!.targetResolved, targetResolved);
    near(bet.settlement!.payout, payout);
    near(bet.settlement!.pnl, payout - 14.2);
    assert.equal(isScorable(bet), true);
    near(await exchange.cash(), 1000 - 14.2 + payout);
    const rec = await reconcile(exchange, ledger, 'primary');
    assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
  });
}

test('a range bet whose second leg cannot fill is sold back and nothing is left open', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  pretendDeep(exchange, 1840);
  exchange.setBook(1840, { bidSize: 0 }); // the YES bids a NO buys against are gone after the bet was sized
  const bet = await placeRangeBet(deps, range(exchange));
  assert.equal(bet.status, 'unwound');
  assert.equal(bet.legs.filter((l) => l.role === 'unwind').length, 1);
  assert.equal(exchange.positions.get(`${exchange.symbol(1800)}|yes`) ?? 0, 0);
  assert.ok(bet.cost > 0 && bet.cost < 0.5, `the round trip should cost a little, not ${bet.cost}`);
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
});

test('a range bet whose second leg can fill only part of the first is not left half matched: it is sold back whole', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  pretendDeep(exchange, 1840);
  exchange.setBook(1840, { bidSize: 6 }); // the NO leg can only get 6 now; the rest never comes
  const bet = await placeRangeBet(deps, range(exchange));
  assert.equal(bet.status, 'unwound'); // 6 of 10 is not a matched range
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
});

test('a range bet is sized to the thinner leg and says so', async () => {
  const { exchange, deps } = setup([
    { strike: 1800, bid: 0.8, ask: 0.82, askSize: 4 },
    { strike: 1840, bid: 0.4, ask: 0.42, bidSize: 1000 },
  ]);
  const bet = await placeRangeBet(deps, range(exchange));
  assert.equal(bet.status, 'open');
  assert.equal(bet.legs[0]!.quantityFilled, 4);
  assert.equal(bet.legs[1]!.quantityFilled, 4);
  assert.equal(bet.stakeReduced?.requested, 14.2);
  near(bet.stakeReduced!.reducedTo, 4 * 1.42);
});

test('a range bet that is poor value, closed or the wrong way round is refused before any order', async () => {
  const wide = setup([
    { strike: 1800, bid: 0.83, ask: 0.97 },
    { strike: 1840, bid: 0.35, ask: 0.54 },
  ]);
  await assert.rejects(placeRangeBet(wide.deps, range(wide.exchange)), (e: unknown) => e instanceof BetRefused && e.code === 'offer_refused');
  assert.equal(wide.exchange.sent.length, 0);

  const closed = setup();
  closed.exchange.setMarketState(1840, 'post_only');
  await assert.rejects(placeRangeBet(closed.deps, range(closed.exchange)), (e: unknown) => e instanceof BetRefused && e.code === 'market_closed');

  const flipped = setup();
  await assert.rejects(placeRangeBet(flipped.deps, range(flipped.exchange, { lowSymbol: flipped.exchange.symbol(1840), highSymbol: flipped.exchange.symbol(1800) })), /not a range/);
  assert.equal(flipped.exchange.sent.length, 0);

  const tiny = setup();
  await assert.rejects(placeRangeBet(tiny.deps, range(tiny.exchange, { stake: 0.01 })), (e: unknown) => e instanceof BetRefused && e.code === 'stake_too_small');
});

// ------------------------------------------------------------------ baskets

const parlayLeg = (ex: FakeExchange, stake = 10) => ({
  product: 'parlay' as const,
  eventTicker: 'ETHTEST',
  conditionSymbol: ex.symbol(1800),
  targetSymbol: ex.symbol(1840),
  stake,
});
const downLeg = (ex: FakeExchange, stake = 10) => ({
  product: 'parlay' as const,
  direction: 'down' as const,
  eventTicker: 'ETHTEST',
  conditionSymbol: ex.symbol(1840),
  targetSymbol: ex.symbol(1800),
  stake,
});
const rangeLeg = (ex: FakeExchange, stake = 14.2) => ({ product: 'range' as const, eventTicker: 'ETHTEST', lowSymbol: ex.symbol(1800), highSymbol: ex.symbol(1840), stake });

test('a basket places every leg, tags each bet with the basket, and reconciles', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  const result = await placeBasket(deps, { user: 'primary', name: 'ETH to chop', legs: [parlayLeg(exchange), downLeg(exchange), rangeLeg(exchange)] });
  assert.equal(result.failed, null);
  assert.equal(result.size, 3);
  assert.equal(result.bets.length, 3);
  assert.deepEqual(result.bets.map((b) => b.status), ['open', 'open', 'open']);
  assert.deepEqual(result.bets.map((b) => b.basket!.index), [0, 1, 2]);
  assert.ok(result.bets.every((b) => b.basket!.id === result.id && b.basket!.size === 3 && b.basket!.name === 'ETH to chop'));
  assert.deepEqual(result.bets.map((b) => b.product), ['parlay', 'parlay', 'range']);
  assert.equal(result.bets[1]!.direction, 'down');
  assert.equal(ledger.data.bets.length, 3);
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
});

test('a basket with a leg that is not offered places nothing at all', async () => {
  const { exchange, ledger, deps } = setup();
  const bad = { ...rangeLeg(exchange), lowSymbol: exchange.symbol(1840), highSymbol: exchange.symbol(1800) };
  await assert.rejects(
    placeBasket(deps, { user: 'primary', legs: [parlayLeg(exchange), bad] }),
    (e: unknown) => e instanceof BasketRefused && e.index === 1 && e.code === 'not_a_linked_pair' && /^Leg 2:/.test(e.message),
  );
  const wide = setup([
    { strike: 1800, bid: 0.83, ask: 0.97 },
    { strike: 1840, bid: 0.35, ask: 0.54 },
  ]);
  await assert.rejects(
    placeBasket(wide.deps, { user: 'primary', legs: [rangeLeg(wide.exchange)] }),
    /needs from 2 to 6 legs/,
  );
  await assert.rejects(
    placeBasket(wide.deps, { user: 'primary', legs: [parlayLeg(wide.exchange), rangeLeg(wide.exchange)] }),
    (e: unknown) => e instanceof BasketRefused && e.index === 0 && e.code === 'offer_refused',
  );
  assert.equal(exchange.sent.length, 0);
  assert.equal(wide.exchange.sent.length, 0);
  assert.equal(ledger.data.bets.length, 0);
});

test('a basket that cannot complete a leg keeps the earlier legs, places nothing further, and says which leg failed', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  pretendDeep(exchange, 1800);
  exchange.setBook(1800, { askSize: 0 }); // the range's YES leg finds nothing to buy once leg 1 is in
  const result = await placeBasket(deps, { user: 'primary', legs: [parlayLeg(exchange), rangeLeg(exchange), downLeg(exchange)] });
  assert.equal(result.bets.length, 2);
  assert.equal(result.bets[0]!.status, 'open');
  assert.equal(result.bets[1]!.status, 'failed');
  assert.deepEqual(result.failed && { index: result.failed.index, code: result.failed.code }, { index: 1, code: 'failed' });
  assert.equal(ledger.data.bets.length, 2); // the third leg was never attempted
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
});

test('a basket needs between two and six legs', async () => {
  const { exchange, deps } = setup();
  await assert.rejects(placeBasket(deps, { user: 'primary', legs: [] }), /needs from 2 to 6 legs/);
  const seven = Array.from({ length: 7 }, () => parlayLeg(exchange, 1));
  await assert.rejects(placeBasket(deps, { user: 'primary', legs: seven }), /needs from 2 to 6 legs/);
});

// ------------------------------------------------------------------ ids

test('a bet id says what kind of bet it is, because the id is committed on Solana with the call', async () => {
  assert.equal(betIdFor('parlay', 'up', 'a1b2'), 'a1b2');
  assert.equal(betIdFor('parlay', undefined, 'a1b2'), 'a1b2'); // ids issued before there were other kinds still mean a rising parlay
  assert.equal(betIdFor('parlay', 'down', 'a1b2'), 'dn-a1b2');
  assert.equal(betIdFor('range', undefined, 'a1b2'), 'rg-a1b2');
  assert.deepEqual(kindOfBetId('a1b2'), { product: 'parlay', direction: 'up' });
  assert.deepEqual(kindOfBetId('dn-a1b2'), { product: 'parlay', direction: 'down' });
  assert.deepEqual(kindOfBetId('rg-a1b2'), { product: 'range', direction: 'up' });

  const { exchange, deps } = setup();
  const up = await placeConditionalBet(deps, { ...down(exchange), direction: 'up', conditionSymbol: exchange.symbol(1800), targetSymbol: exchange.symbol(1840) });
  const fall = await placeConditionalBet(deps, down(exchange));
  const box = await placeRangeBet(deps, range(exchange));
  assert.deepEqual([up.id, fall.id, box.id].map((id) => kindOfBetId(id)), [
    { product: 'parlay', direction: 'up' },
    { product: 'parlay', direction: 'down' },
    { product: 'range', direction: 'up' },
  ]);
  assert.ok(box.legs.every((l) => l.clientOrderId.startsWith('gv-rg-')));
});
