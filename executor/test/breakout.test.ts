import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { placeBasket } from '../src/basket.ts';
import { betIdFor, kindOfBetId } from '../src/bet-id.ts';
import { BetRefused, holdings, isScorable, legMap, recoverBets, settleBets } from '../src/bets.ts';
import { assessBreakout, breakoutContractsFor, capBreakoutToDepth, findBreakout, planBreakout } from '../src/breakout.ts';
import { placeBreakoutBet } from '../src/breakout-bet.ts';
import { cashOutBet, quoteCashOut } from '../src/cashout.ts';
import { Ledger } from '../src/ledger.ts';
import { breakoutPrice, breakoutUnitCost, rangePrice } from '../src/pricing.ts';
import { findRange } from '../src/range.ts';
import { placeRangeBet } from '../src/range-bet.ts';
import { ensureBaseline, reconcile } from '../src/reconcile.ts';
import { near, start } from './api-harness.ts';
import { FakeExchange } from './fake.ts';

/**
 * The tight four-strike ladder the other product tests use. Chances of finishing at or above: 1780 89%, 1800 81%, 1820 61%,
 * 1840 41%. A breakout on 1800 and 1840 buys NO on 1800 at 20 cents and YES on 1840 at 42 cents: 62 cents for a dollar if the
 * price finishes below 1800 or at or above 1840, against a 60% chance of that.
 */
const LADDER = [
  { strike: 1780, bid: 0.88, ask: 0.9 },
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.6, ask: 0.62 },
  { strike: 1840, bid: 0.4, ask: 0.42 },
];

function setup(strikes: ConstructorParameters<typeof FakeExchange>[1] = LADDER, feeCoef = 0) {
  const exchange = new FakeExchange('ETHTEST', strikes);
  exchange.feeCoef = feeCoef;
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-breakout-')), 'ledger.json'));
  let n = 0;
  const deps = { exchange, ledger, feeCoef, newId: () => `t${++n}`, now: () => new Date('2026-11-17T23:10:00Z'), waiveMarkup: false };
  return { exchange, ledger, deps };
}

const pretendDeep = (ex: FakeExchange, strike: number) => ex.reportedDepth.set(ex.symbol(strike), { bidSize: 1000, askSize: 1000 });

/** $12.40 buys exactly 20 contracts of each leg at 62 cents the pair. */
const breakout = (ex: FakeExchange, extra: object = {}) => ({
  user: 'primary',
  eventTicker: 'ETHTEST',
  lowSymbol: ex.symbol(1800),
  highSymbol: ex.symbol(1840),
  stake: 12.4,
  slippageTicks: 0,
  ...extra,
});

// ------------------------------------------------------------------ the maths

test('breakout price: the pair costs what NO on the lower strike and YES on the higher cost, and that is the price of the dollar', () => {
  near(breakoutUnitCost(0.8, 0.42), 0.62); // (1 - bidL) + askH
  near(breakoutPrice(0.8, 0.42)!, 0.62);
  near(breakoutPrice(0.8, 0.42, 0.07)!, 0.2 + 0.07 * 0.2 * 0.8 + 0.42 + 0.07 * 0.42 * 0.58);
  assert.equal(breakoutPrice(0.3, 0.9), null); // costs a dollar or more for the dollar it can win
  assert.equal(breakoutPrice(null, 0.42), null);
  assert.equal(breakoutPrice(0.8, null), null);
});

test('a breakout and a range on the same two strikes are the two sides of one question: their fair prices add up to a dollar', async () => {
  const { exchange } = setup();
  const event = await exchange.getEvent('ETHTEST');
  const out = findBreakout(event, exchange.symbol(1800), exchange.symbol(1840));
  const inside = findRange(event, exchange.symbol(1800), exchange.symbol(1840));
  near(out.offer.chanceOutside! + inside.offer.chanceInRange!, 1);
  // Bought together they are YES and NO on both strikes: two dollars always, for the two dollars plus both spreads.
  near(breakoutPrice(0.8, 0.42)! + rangePrice(0.82, 0.4)!, 1 + 0.02 + 0.02);
});

test('breakout plan: what a stake buys and what each result nets (the README example)', () => {
  const q = breakoutContractsFor(10, 0.8, 0.42, 0);
  near(q, 16.12);
  const plan = planBreakout(q, 0.8, 0.42, 0);
  near(plan.cost, 9.9944);
  near(plan.ifOutside, 16.12 - 9.9944);
  near(plan.ifInRange, -9.9944);
  near(breakoutContractsFor(12.4, 0.8, 0.42, 0), 20);
  const withFees = breakoutContractsFor(10, 0.8, 0.42, 0.07);
  assert.ok(withFees < q); // fees mean fewer contracts for the same stake
  assert.ok(planBreakout(withFees, 0.8, 0.42, 0.07).cost <= 10 + 1e-9);
  assert.ok(planBreakout(withFees, 0.8, 0.42, 0.07).feesAtProductionRates > 0);
  assert.equal(capBreakoutToDepth(10, 4, 100), 4);
  assert.equal(capBreakoutToDepth(10, 100, 3), 3);
  assert.equal(capBreakoutToDepth(10, 100, 100), 10);
});

test('breakout offer: chance is one less the chance of landing between, and the usual refusals apply', async () => {
  const { exchange } = setup();
  const event = await exchange.getEvent('ETHTEST');
  const p = findBreakout(event, exchange.symbol(1800), exchange.symbol(1840));
  near(p.offer.chanceOutside!, 0.6);
  near(p.offer.fairPrice!, 0.6);
  near(p.offer.pricePaid!, 0.62);
  near(p.offer.allInPrice!, 0.648252);
  near(p.offer.markup!, 0.048252);
  assert.equal(p.offer.verdict, 'ok');
  assert.equal(p.offer.offerable, true);
  // Selling straight back: NO on 1800 at 1 - 0.82, YES on 1840 at 0.40, on 100 / 0.62 contracts.
  near(p.offer.cashOutPer100!, Math.round((100 / 0.62) * (0.18 + 0.4) * 100) / 100);
  assert.throws(() => findBreakout(event, exchange.symbol(1840), exchange.symbol(1800)), /not a range/);

  const wide = new FakeExchange('WIDE', [
    { strike: 1800, bid: 0.63, ask: 0.97 },
    { strike: 1840, bid: 0.35, ask: 0.54 },
  ]);
  const w = findBreakout(await wide.getEvent('WIDE'), wide.symbol(1800), wide.symbol(1840));
  assert.equal(w.offer.offerable, false);
  assert.ok(w.offer.reasons.some((r) => r.code === 'markup_too_high'));
  const waived = findBreakout(await wide.getEvent('WIDE'), wide.symbol(1800), wide.symbol(1840), 0, true);
  assert.equal(waived.offer.offerable, true);
  assert.equal(waived.offer.overridden, true);

  const one = new FakeExchange('ONE', [
    { strike: 1800, bid: 0.8, ask: 0.82 },
    { strike: 1840, bid: null, ask: null },
  ]);
  const o = findBreakout(await one.getEvent('ONE'), one.symbol(1800), one.symbol(1840));
  assert.ok(o.offer.reasons.some((r) => r.code === 'one_sided_book'));
  assert.equal(assessBreakout([], { ...p.low, open: false }, p.high).reasons[0]!.code, 'market_closed');

  // Two strikes priced the same leave no chance of landing between them: "outside" is then a certainty, not a bet.
  const flat = new FakeExchange('FLAT', [
    { strike: 1800, bid: 0.5, ask: 0.52 },
    { strike: 1840, bid: 0.5, ask: 0.52 },
  ]);
  const f = findBreakout(await flat.getEvent('FLAT'), flat.symbol(1800), flat.symbol(1840));
  assert.equal(f.offer.offerable, false);
  assert.ok(f.offer.reasons.some((r) => r.code === 'no_price'));
});

// ------------------------------------------------------------------ placing and settling

test('a breakout: YES on the higher strike and NO on the lower, equal size, cash conserved', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeBreakoutBet(deps, breakout(exchange));

  assert.equal(bet.status, 'open');
  assert.equal(bet.product, 'breakout');
  assert.equal(bet.direction, undefined);
  assert.match(bet.id, /^bo-/);
  assert.equal(bet.condition.strike, 1800); // named as a range names them: the lower strike, then the higher
  assert.equal(bet.target.strike, 1840);
  assert.equal(bet.legs.length, 2);
  assert.deepEqual([bet.legs[0]!.role, bet.legs[0]!.symbol, bet.legs[0]!.outcome, bet.legs[0]!.side], ['outcome', exchange.symbol(1840), 'yes', 'buy']);
  assert.deepEqual([bet.legs[1]!.role, bet.legs[1]!.symbol, bet.legs[1]!.outcome, bet.legs[1]!.side], ['hedge', exchange.symbol(1800), 'no', 'buy']);
  assert.equal(bet.legs[0]!.quantityFilled, 20);
  assert.equal(bet.legs[1]!.quantityFilled, 20);
  assert.ok(bet.legs.every((l) => l.clientOrderId.startsWith('gv-bo-')));
  near(bet.cost, 12.4);
  assert.equal(bet.payoffs!.hedged, true);
  near(bet.payoffs!.ifOutside!, 7.6);
  near(bet.payoffs!.ifInRange!, -12.4);
  near(bet.payoffs!.ifBothHit, 7.6); // the win and loss lines every consumer reads carry the same numbers
  near(bet.payoffs!.ifConditionOnly, -12.4);
  assert.equal(bet.payoffs!.ifConditionFails, undefined); // a breakout has no refund line
  near(bet.payoffs!.conditionalPrice!, 0.62);
  near(await exchange.cash(), 1000 - 12.4);

  // The legs are the ones the rest of the service reads: cash-out, unwind and recovery all go through this map.
  assert.deepEqual(legMap(bet), { outcome: { symbol: exchange.symbol(1840), side: 'yes' }, hedge: { symbol: exchange.symbol(1800), side: 'no' } });
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
  assert.equal(rec.mismatches.length, 0);
});

for (const [name, resolve1800, resolve1840, targetResolved, payout] of [
  ['it finishes above both levels', 'yes', 'yes', 'yes', 20],
  ['it finishes below both levels', 'no', 'no', 'yes', 20],
  ['it finishes between them', 'yes', 'no', 'no', 0],
] as const) {
  test(`a breakout settles correctly when ${name}`, async () => {
    const { exchange, ledger, deps } = setup();
    await ensureBaseline(exchange, ledger, 'primary');
    const bet = await placeBreakoutBet(deps, breakout(exchange));
    exchange.resolve(1800, resolve1800);
    exchange.resolve(1840, resolve1840);
    const done = await settleBets(deps);
    assert.equal(done.settled.length, 1);
    assert.equal(bet.settlement!.conditionResolved, 'yes'); // never refunded, so never void
    assert.equal(bet.settlement!.targetResolved, targetResolved);
    near(bet.settlement!.payout, payout);
    near(bet.settlement!.pnl, payout - 12.4);
    assert.equal(isScorable(bet), true);
    near(await exchange.cash(), 1000 - 12.4 + payout);
    const rec = await reconcile(exchange, ledger, 'primary');
    assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
  });
}

test('a settled bet records where the ladder finished when Gemini reports it, and settles the same without it', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeBreakoutBet(deps, breakout(exchange));
  exchange.resolve(1800, 'yes', 1851.25); // every contract of a ladder settles against the same reference price
  exchange.resolve(1840, 'yes', 1851.25);
  await settleBets(deps);
  assert.equal(bet.settlement!.finishedAt, 1851.25);
  near(bet.settlement!.payout, 20);

  const bare = setup();
  await ensureBaseline(bare.exchange, bare.ledger, 'primary');
  const other = await placeBreakoutBet(bare.deps, breakout(bare.exchange));
  bare.exchange.resolve(1800, 'yes');
  bare.exchange.resolve(1840, 'yes');
  await settleBets(bare.deps);
  assert.equal(other.settlement!.finishedAt, undefined);
  near(other.settlement!.payout, 20);
});

test('with fees charged, a breakout never spends more than the stake and still ties out', async () => {
  const { exchange, ledger, deps } = setup(LADDER, 0.07);
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeBreakoutBet(deps, breakout(exchange, { stake: 10 }));
  assert.equal(bet.status, 'open');
  assert.ok(bet.cost <= 10 + 1e-9, `cost ${bet.cost}`);
  assert.ok(bet.legs.every((l) => l.fee > 0));
  near(bet.payoffs!.ifOutside!, bet.legs[0]!.quantityFilled - bet.cost);
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
});

test('a breakout whose second leg cannot fill is sold back and nothing is left open', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  pretendDeep(exchange, 1800);
  exchange.setBook(1800, { bidSize: 0 }); // the YES bids a NO buys against are gone after the bet was sized
  const bet = await placeBreakoutBet(deps, breakout(exchange));
  assert.equal(bet.status, 'unwound');
  assert.equal(bet.legs.filter((l) => l.role === 'unwind').length, 1);
  assert.equal(exchange.positions.get(`${exchange.symbol(1840)}|yes`) ?? 0, 0);
  assert.ok(bet.cost > 0 && bet.cost < 0.5, `the round trip should cost a little, not ${bet.cost}`);
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
});

test('a breakout whose second leg can fill only part of the first is not left half matched: it is sold back whole', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  pretendDeep(exchange, 1800);
  exchange.setBook(1800, { bidSize: 6 }); // the NO leg can only get 6 now; the rest never comes
  const bet = await placeBreakoutBet(deps, breakout(exchange));
  assert.equal(bet.status, 'unwound'); // 6 of 20 is a bet on a fall with a little on a rise, not a breakout
  assert.equal([...exchange.positions.values()].filter((q) => Math.abs(q) > 1e-9).length, 0);
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
});

test('a breakout is sized to the thinner leg and says so', async () => {
  const { exchange, deps } = setup([
    { strike: 1800, bid: 0.8, ask: 0.82, bidSize: 1000 },
    { strike: 1840, bid: 0.4, ask: 0.42, askSize: 4 },
  ]);
  const bet = await placeBreakoutBet(deps, breakout(exchange));
  assert.equal(bet.status, 'open');
  assert.equal(bet.legs[0]!.quantityFilled, 4);
  assert.equal(bet.legs[1]!.quantityFilled, 4);
  assert.equal(bet.stakeReduced?.requested, 12.4);
  near(bet.stakeReduced!.reducedTo, 4 * 0.62);

  const thinLow = setup([
    { strike: 1800, bid: 0.8, ask: 0.82, bidSize: 3 },
    { strike: 1840, bid: 0.4, ask: 0.42, askSize: 1000 },
  ]);
  const other = await placeBreakoutBet(thinLow.deps, breakout(thinLow.exchange));
  assert.equal(other.legs[0]!.quantityFilled, 3); // the first order is never bigger than the second can match
  assert.equal(other.legs[1]!.quantityFilled, 3);
});

test('a breakout that is poor value, closed or the wrong way round is refused before any order', async () => {
  const wide = setup([
    { strike: 1800, bid: 0.63, ask: 0.97 },
    { strike: 1840, bid: 0.35, ask: 0.54 },
  ]);
  await assert.rejects(placeBreakoutBet(wide.deps, breakout(wide.exchange)), (e: unknown) => e instanceof BetRefused && e.code === 'offer_refused');
  assert.equal(wide.exchange.sent.length, 0);

  const closed = setup();
  closed.exchange.setMarketState(1800, 'post_only');
  await assert.rejects(placeBreakoutBet(closed.deps, breakout(closed.exchange)), (e: unknown) => e instanceof BetRefused && e.code === 'market_closed');
  assert.equal(closed.exchange.sent.length, 0);

  const flipped = setup();
  await assert.rejects(placeBreakoutBet(flipped.deps, breakout(flipped.exchange, { lowSymbol: flipped.exchange.symbol(1840), highSymbol: flipped.exchange.symbol(1800) })), /not a range/);
  assert.equal(flipped.exchange.sent.length, 0);

  const tiny = setup();
  await assert.rejects(placeBreakoutBet(tiny.deps, breakout(tiny.exchange, { stake: 0.005 })), (e: unknown) => e instanceof BetRefused && e.code === 'stake_too_small');

  const capped = setup();
  await assert.rejects(placeBreakoutBet(capped.deps, breakout(capped.exchange, { maxPrice: 0.6 })), (e: unknown) => e instanceof BetRefused && e.code === 'price_above_limit');
  assert.equal(capped.exchange.sent.length, 0);
});

// ------------------------------------------------------------------ what else a bet goes through

test('a breakout cashes out: YES on the higher strike and NO on the lower are both sold, and the cash ties out', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeBreakoutBet(deps, breakout(exchange));
  const h = holdings(bet);
  assert.equal(h.outcome.quantity, 20);
  assert.equal(h.hedge.quantity, 20);

  const quote = await quoteCashOut(deps, bet);
  assert.equal(quote.available, true);
  // YES on 1840 sells at 0.40, NO on 1800 at 1 - 0.82 = 0.18.
  near(quote.proceeds!, 20 * 0.4 + 20 * 0.18);

  const done = await cashOutBet(deps, bet);
  assert.equal(done.status, 'cashed_out');
  assert.deepEqual(
    exchange.sent.slice(2).map((o) => [o.side, o.outcome, o.symbol, o.quantity]),
    [
      ['sell', 'yes', exchange.symbol(1840), 20],
      ['sell', 'no', exchange.symbol(1800), 20],
    ],
  );
  near(done.cashOut!.proceeds, 20 * 0.4 + 20 * 0.18);
  assert.equal([...exchange.positions.values()].filter((q) => Math.abs(q) > 1e-9).length, 0);
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
  near(rec.cashDifference!, 0);
});

test('a breakout interrupted between its two orders is recovered by its tags and never resent', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeBreakoutBet(deps, breakout(exchange));
  // As a crash would leave it: the orders are on the exchange, the ledger only knows they were sent.
  const saved = ledger.data.bets.find((b) => b.id === bet.id)!;
  saved.status = 'placing';
  for (const leg of saved.legs) Object.assign(leg, { status: 'sent', quantityFilled: 0, avgPrice: null, fee: 0, orderId: undefined });
  ledger.save();

  const before = exchange.sent.length;
  await recoverBets(deps);
  assert.equal(exchange.sent.length, before); // nothing was sent again
  assert.equal(saved.status, 'open');
  assert.equal(saved.legs[0]!.quantityFilled, 20);
  assert.equal(saved.legs[1]!.quantityFilled, 20);
  near(saved.payoffs!.ifOutside!, 7.6);
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
});

test('a breakout and a range on the same strikes held together are netted by the exchange, and the books still tie out', async () => {
  // Together they are YES and NO on both contracts. Gemini pays a dollar a pair for that at once (see GEMINI_API_NOTES.md),
  // which is what the reconcile's netting line is for.
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  const out = await placeBreakoutBet(deps, breakout(exchange));
  const inside = await placeRangeBet(deps, { user: 'primary', eventTicker: 'ETHTEST', lowSymbol: exchange.symbol(1800), highSymbol: exchange.symbol(1840), stake: 14.2, slippageTicks: 0 });
  assert.equal(out.status, 'open');
  assert.equal(inside.status, 'open');
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true, JSON.stringify(rec));
});

test('a basket can carry a breakout beside the other kinds, each with its own result', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  const res = await placeBasket(deps, {
    user: 'primary',
    name: 'Either way',
    legs: [
      { product: 'breakout', eventTicker: 'ETHTEST', lowSymbol: exchange.symbol(1800), highSymbol: exchange.symbol(1840), stake: 12.4 },
      { product: 'parlay', eventTicker: 'ETHTEST', conditionSymbol: exchange.symbol(1780), targetSymbol: exchange.symbol(1820), stake: 10 },
    ],
  });
  assert.equal(res.failed, null);
  assert.deepEqual(res.bets.map((b) => b.product), ['breakout', 'parlay']);
  assert.ok(res.bets.every((b) => b.basket?.id === res.id && b.status === 'open'));
});

// ------------------------------------------------------------------ ids and the API

test('a breakout id says so, because the id is committed on Solana with the call', () => {
  assert.equal(betIdFor('breakout', undefined, 'a1b2'), 'bo-a1b2');
  assert.deepEqual(kindOfBetId('bo-a1b2'), { product: 'breakout', direction: 'up' });
  assert.deepEqual(kindOfBetId('rg-a1b2'), { product: 'range', direction: 'up' }); // the others are unchanged
  assert.deepEqual(kindOfBetId('a1b2'), { product: 'parlay', direction: 'up' });
});

test('GET /quote and POST /bets: a breakout is quoted, placed, listed with its product and reconciles', async () => {
  const app = await start(LADDER);
  try {
    const q = `/quote?product=breakout&event=ETHTEST&low=${app.exchange.symbol(1800)}&high=${app.exchange.symbol(1840)}&stake=12.4`;
    const res = await app.call('GET', q);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.product, 'breakout');
    assert.equal(res.json.low.strike, 1800);
    assert.equal(res.json.high.strike, 1840);
    near(res.json.quote.chanceOutside, 0.6);
    near(res.json.quote.pricePaid, 0.62);
    near(res.json.stake.contracts, 20);
    near(res.json.stake.cost, 12.4);
    near(res.json.stake.ifOutside, 7.6);
    near(res.json.stake.ifInRange, -12.4);
    assert.ok(res.json.stake.cashOutNow > 0 && res.json.stake.cashOutNow < 12.4);
    assert.ok(res.json.depth.maxStake > 12.4);

    const backwards = await app.call('GET', `/quote?product=breakout&event=ETHTEST&low=${app.exchange.symbol(1840)}&high=${app.exchange.symbol(1800)}&stake=10`);
    assert.equal(backwards.status, 400);
    assert.equal(backwards.json.code, 'not_a_range');
    const noStake = await app.call('GET', `/quote?product=breakout&event=ETHTEST&low=${app.exchange.symbol(1800)}&high=${app.exchange.symbol(1840)}`);
    assert.equal(noStake.json.stake, null);
    const unknown = await app.call('GET', `/quote?product=straddle&event=ETHTEST&low=${app.exchange.symbol(1800)}&high=${app.exchange.symbol(1840)}`);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.code, 'invalid_product');

    const placed = await app.call('POST', '/bets', { product: 'breakout', user: 'primary', event: 'ETHTEST', low: app.exchange.symbol(1800), high: app.exchange.symbol(1840), stake: 12.4 });
    assert.equal(placed.status, 201, JSON.stringify(placed.json));
    assert.equal(placed.json.bet.product, 'breakout');
    assert.match(placed.json.bet.id, /^bo-/);
    assert.equal(placed.json.bet.status, 'open');
    assert.equal(placed.json.bet.payoffs.hedged, true);
    assert.ok(placed.json.bet.payoffs.ifOutside > 0 && placed.json.bet.payoffs.ifInRange < 0);
    near(placed.json.bet.offer.chanceOutside, 0.6);

    const listed = await app.call('GET', '/bets');
    assert.equal(listed.json.bets[0].product, 'breakout');
    const rec = await app.call('GET', '/reconcile');
    assert.equal(rec.json.ok, true, JSON.stringify(rec.json));

    const basket = await app.call('POST', '/baskets', {
      user: 'primary',
      legs: [
        { product: 'breakout', event: 'ETHTEST', low: app.exchange.symbol(1780), high: app.exchange.symbol(1820), stake: 5 },
        { product: 'range', event: 'ETHTEST', low: app.exchange.symbol(1800), high: app.exchange.symbol(1840), stake: 5 },
      ],
    });
    assert.equal(basket.status, 201, JSON.stringify(basket.json));
    assert.deepEqual(basket.json.bets.map((b: { product: string }) => b.product), ['breakout', 'range']);
  } finally {
    await app.close();
  }
});

test('POST /bets: a breakout that is poor value is refused with the offer rule\'s numbers, and no order is sent', async () => {
  const app = await start([
    { strike: 1800, bid: 0.63, ask: 0.97 },
    { strike: 1840, bid: 0.35, ask: 0.54 },
  ]);
  try {
    const res = await app.call('POST', '/bets', { product: 'breakout', user: 'primary', event: 'ETHTEST', low: app.exchange.symbol(1800), high: app.exchange.symbol(1840), stake: 10 });
    assert.equal(res.status, 422);
    assert.equal(res.json.code, 'offer_refused');
    assert.equal(res.json.quote.verdict, 'refuse');
    assert.ok(res.json.quote.chanceOutside > 0);
    assert.equal(app.exchange.sent.length, 0);
  } finally {
    await app.close();
  }
});
