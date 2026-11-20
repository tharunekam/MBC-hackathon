import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BetRefused, isScorable, netHolding, placeConditionalBet, recoverBets, settleBets } from '../src/bets.ts';
import { Ledger } from '../src/ledger.ts';
import { ensureBaseline, reconcile } from '../src/reconcile.ts';
import { FakeExchange } from './fake.ts';

const near = (actual: number, expected: number, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);

/**
 * `waiveMarkup` defaults to true here because the classic LADDER fixture below
 * has a sandbox-style wide spread (about 20 cents over fair) that the offer
 * rule would refuse; the execution tests are about fills, not value. The
 * offer-rule tests further down run with the rule fully enforced.
 */
function setup(strikes: ConstructorParameters<typeof FakeExchange>[1], opts: { waiveMarkup?: boolean } = {}) {
  const exchange = new FakeExchange('ETHTEST', strikes);
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-')), 'ledger.json'));
  let n = 0;
  const deps = {
    exchange,
    ledger,
    newId: () => `t${++n}`,
    now: () => new Date('2026-11-17T23:10:00Z'),
    waiveMarkup: opts.waiveMarkup ?? true,
  };
  return { exchange, ledger, deps };
}

/** Makes the depth read report a full book, so a test can thin the REAL book out after the bet was sized. */
const pretendDeep = (ex: FakeExchange, strike: number) => ex.reportedDepth.set(ex.symbol(strike), { bidSize: 1000, askSize: 1000 });

/** A pair the offer rule accepts as it stands: 4.1 cents (8.2%) over fair at production fees. */
const TIGHT = [
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.4, ask: 0.41 },
];

const LADDER = [
  { strike: 1800, bid: 0.71, ask: 0.9 },
  { strike: 1820, bid: 0.11, ask: 0.3 },
];

const request = (ex: FakeExchange, extra: object = {}) => ({
  user: 'primary',
  eventTicker: 'ETHTEST',
  conditionSymbol: ex.symbol(1800),
  targetSymbol: ex.symbol(1820),
  stake: 4.23,
  slippageTicks: 0,
  ...extra,
});

test('a clean bet: two fills, stake protected, cash conserved', async () => {
  const { exchange, ledger, deps } = setup(LADDER);
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeConditionalBet(deps, request(exchange));

  assert.equal(bet.status, 'open');
  assert.equal(bet.legs.length, 2);
  // stake 4.23 at 0.4225 per $1 -> 10.01 contracts of the outcome
  assert.equal(bet.legs[0]!.quantityFilled, 10.01);
  assert.equal(bet.legs[0]!.avgPrice, 0.3);
  assert.equal(bet.legs[1]!.outcome, 'no');
  assert.equal(bet.legs[1]!.quantityFilled, 4.23);
  assert.equal(bet.payoffs!.hedged, true);
  assert.ok(bet.payoffs!.ifConditionFails! >= 0 && bet.payoffs!.ifConditionFails! < 0.01);
  near(bet.cost, 10.01 * 0.3 + 4.23 * 0.29);
  near(await exchange.cash(), 1000 - bet.cost); // every dollar accounted for

  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true);
  assert.equal(rec.mismatches.length, 0);
  near(rec.cashDifference!, 0);
});

test('book thins out after sizing: only what filled on the outcome is hedged', async () => {
  const { exchange, deps } = setup([
    { strike: 1800, bid: 0.71, ask: 0.9 },
    { strike: 1820, bid: 0.11, ask: 0.3, askSize: 1 }, // only 1 contract offered, as seen in the sandbox
  ]);
  pretendDeep(exchange, 1820); // the depth read saw plenty; it was gone by the time the order arrived
  const bet = await placeConditionalBet(deps, request(exchange));
  assert.equal(bet.status, 'open');
  assert.equal(bet.legs[0]!.quantityFilled, 1);
  assert.equal(bet.legs[0]!.status, 'partial');
  assert.equal(bet.legs[1]!.quantityFilled, 0.43); // 0.30 / 0.71 = 0.4225 -> 0.43, NOT the 4.23 originally planned
  assert.equal(bet.payoffs!.hedged, true);
});

test('hedge leg cannot fill: the position is sold back and nothing is left open', async () => {
  const { exchange, ledger, deps } = setup([
    { strike: 1800, bid: 0.71, ask: 0.9, bidSize: 0 }, // nobody to sell us NO on the condition
    { strike: 1820, bid: 0.11, ask: 0.3 },
  ]);
  pretendDeep(exchange, 1800); // it was there when the bet was sized, and gone a moment later
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeConditionalBet(deps, request(exchange));

  assert.equal(bet.status, 'unwound');
  assert.equal(bet.legs.filter((l) => l.role === 'hedge').length, 3); // retried up to the cap, then gave up
  assert.equal(netHolding(bet, exchange.symbol(1820), 'yes').quantity, 0);
  assert.equal(netHolding(bet, exchange.symbol(1800), 'no').quantity, 0);
  assert.equal(exchange.positions.get(`${exchange.symbol(1820)}|yes`), 0);
  // bought at 0.30, sold at the 0.11 bid: the loss is the spread, and it is recorded
  near(bet.cost, 10.01 * (0.3 - 0.11));
  near(await exchange.cash(), 1000 - bet.cost);
  assert.equal((await reconcile(exchange, ledger, 'primary')).ok, true);
});

test('hedge leg cannot fill and the user chose to keep the position: flagged unhedged', async () => {
  const { exchange, deps } = setup([
    { strike: 1800, bid: 0.71, ask: 0.9, bidSize: 0 },
    { strike: 1820, bid: 0.11, ask: 0.3 },
  ]);
  pretendDeep(exchange, 1800);
  const bet = await placeConditionalBet(deps, request(exchange, { onHedgeFail: 'leave' }));
  assert.equal(bet.status, 'unhedged');
  assert.equal(bet.payoffs!.hedged, false);
  assert.match(bet.note!, /NOT fully protected/);
  assert.equal(bet.legs.some((l) => l.role === 'unwind'), false);
});

test('partial hedge is topped up on the next attempt', async () => {
  const { exchange, deps } = setup([
    { strike: 1800, bid: 0.71, ask: 0.9, bidSize: 2 },
    { strike: 1820, bid: 0.11, ask: 0.3 },
  ]);
  pretendDeep(exchange, 1800);
  const original = exchange.placeOrder.bind(exchange);
  exchange.placeOrder = async (req) => {
    const res = await original(req);
    if (req.clientOrderId.endsWith('-a1')) exchange.setBook(1800, { bidSize: 100 }); // liquidity returns
    return res;
  };
  const bet = await placeConditionalBet(deps, request(exchange));
  assert.equal(bet.status, 'open');
  const hedges = bet.legs.filter((l) => l.role === 'hedge');
  assert.deepEqual(hedges.map((l) => l.quantityFilled), [2, 2.23]);
  assert.equal(bet.payoffs!.hedged, true);
});

test('nothing fills on the outcome: no bet, no hedge, no money moved', async () => {
  const { exchange, deps } = setup([
    { strike: 1800, bid: 0.71, ask: 0.9 },
    { strike: 1820, bid: 0.11, ask: 0.3, askSize: 0 },
  ]);
  pretendDeep(exchange, 1820);
  const bet = await placeConditionalBet(deps, request(exchange));
  assert.equal(bet.status, 'failed');
  assert.equal(bet.legs.length, 1);
  assert.equal(await exchange.cash(), 1000);
});

test('refuses before trading when the price is above the limit, or the request is invalid', async () => {
  const { exchange, ledger, deps } = setup(LADDER);
  await assert.rejects(placeConditionalBet(deps, request(exchange, { maxPrice: 0.4 })), /above your limit/);
  await assert.rejects(placeConditionalBet(deps, request(exchange, { stake: 0 })), /positive/);
  await assert.rejects(placeConditionalBet(deps, request(exchange, { stake: 0.001 })), /too small/);
  // condition and outcome swapped: not a linked pair
  await assert.rejects(
    placeConditionalBet(deps, request(exchange, { conditionSymbol: exchange.symbol(1820), targetSymbol: exchange.symbol(1800) })),
    /not a linked pair/,
  );
  assert.equal(exchange.sent.length, 0);
  assert.equal(ledger.data.bets.length, 0);
});

test('the price limit also caps the hedge leg', async () => {
  const { exchange, deps } = setup(LADDER);
  const original = exchange.placeOrder.bind(exchange);
  exchange.placeOrder = async (req) => {
    const res = await original(req);
    if (req.clientOrderId.endsWith('-b')) exchange.setBook(1800, { bid: 0.5 }); // condition got much cheaper to bet against... i.e. NO now costs 0.50
    return res;
  };
  const bet = await placeConditionalBet(deps, request(exchange, { maxPrice: 0.45 }));
  // hedging at NO=0.50 would make the bet cost 0.60 per $1, above the 0.45 limit -> no hedge order is sent
  assert.equal(bet.legs.filter((l) => l.role === 'hedge').length, 0);
  assert.equal(bet.status, 'unwound');
});

for (const [name, aSide, bSide, expected] of [
  ['condition fails -> stake comes back', 'no', 'no', 'refund'],
  ['both hit -> pays $1 per contract', 'yes', 'yes', 'win'],
  ['condition holds, outcome misses -> stake lost', 'yes', 'no', 'lose'],
] as const) {
  test(`settlement: ${name}`, async () => {
    const { exchange, ledger, deps } = setup(LADDER);
    await ensureBaseline(exchange, ledger, 'primary');
    const bet = await placeConditionalBet(deps, request(exchange));
    const predicted = bet.payoffs!;

    assert.equal((await settleBets(deps)).settled.length, 0); // not resolved yet
    exchange.resolve(1800, aSide);
    exchange.resolve(1820, bSide);
    const done = await settleBets(deps);
    assert.equal(done.settled.length, 1);
    assert.equal(done.needsReview.length, 0);
    assert.equal(isScorable(bet), true);
    assert.equal(bet.status, 'settled');

    const pnl = bet.settlement!.pnl;
    if (expected === 'refund') near(pnl, predicted.ifConditionFails!);
    if (expected === 'win') near(pnl, predicted.ifBothHit);
    if (expected === 'lose') near(pnl, predicted.ifConditionOnly);
    near(await exchange.cash(), 1000 + pnl); // the venue's cash agrees with the ledger's result
    assert.equal((await reconcile(exchange, ledger, 'primary')).ok, true);

    assert.equal((await settleBets(deps)).settled.length, 0); // settling twice changes nothing
    near(await exchange.cash(), 1000 + pnl);
  });
}

test('interrupted mid-bet: recovery finds the order by its tag instead of resending', async () => {
  const { exchange, ledger, deps } = setup(LADDER);
  exchange.failAfterSend = 'gv-t1-b'; // the outcome order reaches the venue, then the connection dies
  const lookup = exchange.findOrder.bind(exchange);
  exchange.findOrder = async () => {
    throw new Error('fetch failed'); // and Gemini cannot be asked about it either, so the answer stays lost
  };
  const bet = await placeConditionalBet({ ...deps, lookupWaitsMs: [0, 0] }, request(exchange));
  exchange.findOrder = lookup;
  assert.equal(bet.status, 'unhedged'); // we could not confirm it, so the bet says so and sends nothing more...
  assert.equal(bet.legs[0]!.status, 'unknown');
  assert.equal(bet.legs.length, 1);
  assert.equal(exchange.orders.get('gv-t1-b')!.filledQuantity, 10.01); // ...but it did fill

  // Simulate the crash state a restart would see: order recorded as sent, bet still placing.
  bet.legs[0]!.status = 'sent';
  bet.status = 'placing';
  ledger.save();

  const reloaded = new Ledger(ledger.path);
  const fixed = await recoverBets({ ...deps, ledger: reloaded });
  assert.equal(fixed, 1);
  const recovered = reloaded.bet('t1')!;
  assert.equal(recovered.legs[0]!.quantityFilled, 10.01);
  assert.equal(recovered.status, 'unhedged'); // the truth: outcome bought, hedge never sent
  assert.equal(exchange.sent.filter((o) => o.clientOrderId === 'gv-t1-b').length, 1); // never sent twice
});

test('reconcile catches a ledger that disagrees with the venue', async () => {
  const { exchange, ledger, deps } = setup(LADDER);
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeConditionalBet(deps, request(exchange));
  bet.legs[1]!.quantityFilled = 9; // corrupt the record
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, false);
  assert.equal(rec.mismatches.length, 1);
  assert.equal(rec.mismatches[0]!.clientOrderId, 'gv-t1-a1');
});

test('reconcile accounts for orders placed outside the service after the baseline', async () => {
  const { exchange, ledger, deps } = setup(LADDER);
  await ensureBaseline(exchange, ledger, 'primary', () => new Date('2026-11-17T23:00:00Z'));
  await placeConditionalBet(deps, request(exchange));
  // Someone trades by hand on the same account: buys 1 YES at 0.30, sells it at 0.11.
  await exchange.placeOrder({ symbol: exchange.symbol(1820), side: 'buy', outcome: 'yes', limitPrice: 0.3, quantity: 1, tif: 'IOC', clientOrderId: 'manual-1' });
  await exchange.placeOrder({ symbol: exchange.symbol(1820), side: 'sell', outcome: 'yes', limitPrice: 0.11, quantity: 1, tif: 'IOC', clientOrderId: 'manual-2' });
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.untrackedOrders, 2);
  near(rec.untrackedCashFlow, -0.19);
  near(rec.cashDifference!, 0);
  assert.equal(rec.ok, true);
});

test('fees: with the right fee model the stake still comes back when the condition fails', async () => {
  const { exchange, ledger, deps } = setup(LADDER);
  exchange.feeCoef = 0.07; // venue charges Gemini's production taker fee
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeConditionalBet({ ...deps, feeCoef: 0.07 }, request(exchange, { stake: 100 }));

  assert.equal(bet.status, 'open');
  assert.ok(bet.legs.every((l) => l.fee > 0));
  near(bet.quotedPrice, 0.452424, 1e-5); // fee-inclusive quote, not the fee-free 0.4225
  assert.equal(bet.payoffs!.hedged, true);
  near(await exchange.cash(), 1000 - bet.cost); // cost includes both fees

  exchange.resolve(1800, 'no');
  exchange.resolve(1820, 'no');
  await settleBets({ ...deps, feeCoef: 0.07 });
  assert.ok(bet.settlement!.pnl >= 0 && bet.settlement!.pnl < 0.05, `refund result was ${bet.settlement!.pnl}`);
  near(await exchange.cash(), 1000 + bet.settlement!.pnl);
  assert.equal((await reconcile(exchange, ledger, 'primary')).ok, true);
});

test('fees: a wrong fee model (the original bug) is caught by reconcile, not hidden', async () => {
  const { exchange, ledger, deps } = setup(LADDER);
  exchange.feeCoef = 0.07; // venue charges fees...
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeConditionalBet(deps, request(exchange, { stake: 100 })); // ...but we size as if it were free
  assert.equal(bet.payoffs!.hedged, true); // the ledger believes it is protected
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, false); // and the cash check exposes the gap
  assert.ok(rec.cashDifference! < -3, `expected several dollars of unmodelled fees, got ${rec.cashDifference}`);
});

// ---------------------------------------------------------------- offer rule at the point of trade

test('offer rule: a fair-value pair is placed with the rule fully enforced, and its numbers are kept', async () => {
  const { exchange, ledger, deps } = setup(TIGHT, { waiveMarkup: false });
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeConditionalBet(deps, request(exchange, { stake: 10 }));
  assert.equal(bet.status, 'open');
  assert.equal(bet.offer!.verdict, 'ok');
  assert.equal(bet.offer!.overridden, false);
  near(bet.offer!.fairPrice!, 0.5);
  near(bet.offer!.pricePaid!, 0.5125); // 0.41 / 0.80
  assert.equal(bet.stakeReduced, undefined);
  assert.equal((await reconcile(exchange, ledger, 'primary')).ok, true);
});

test('offer rule: a poor-value pair is refused before any order, with the reason and the numbers', async () => {
  const { exchange, ledger, deps } = setup(LADDER, { waiveMarkup: false });
  await assert.rejects(placeConditionalBet(deps, request(exchange)), (err: unknown) => {
    assert.ok(err instanceof BetRefused);
    assert.equal(err.code, 'offer_refused');
    assert.match(err.message, /more than the fair price/);
    assert.match(err.message, /No order was sent/);
    assert.equal(err.quote!.verdict, 'refuse');
    assert.deepEqual(err.quote!.reasons.map((r) => r.code), ['markup_too_high']);
    return true;
  });
  assert.equal(exchange.sent.length, 0);
  assert.equal(ledger.data.bets.length, 0);
});

test('offer rule: the sandbox waiver lets a markup-only refusal through and records that it did', async () => {
  const { exchange, deps } = setup(LADDER, { waiveMarkup: true });
  const bet = await placeConditionalBet(deps, request(exchange));
  assert.equal(bet.status, 'open');
  assert.equal(bet.offer!.verdict, 'refuse');
  assert.equal(bet.offer!.overridden, true);
});

test('offer rule: the waiver never covers a one-sided book or an out-of-order ladder', async () => {
  const oneSided = setup(
    [
      { strike: 1800, bid: 0.8, ask: null },
      { strike: 1820, bid: 0.4, ask: 0.41 },
    ],
    { waiveMarkup: true },
  );
  await assert.rejects(placeConditionalBet(oneSided.deps, request(oneSided.exchange)), /two-sided/);
  assert.equal(oneSided.exchange.sent.length, 0);

  const inverted = setup([...TIGHT, { strike: 1840, bid: 0.03, ask: 0.2 }, { strike: 1860, bid: 0.03, ask: 0.21 }], { waiveMarkup: true });
  await assert.rejects(placeConditionalBet(inverted.deps, request(inverted.exchange)), /out of order/);
  assert.equal(inverted.exchange.sent.length, 0);
});

// ---------------------------------------------------------------- market state

test('market state: a paused contract is refused, naming what Gemini reports', async () => {
  const { exchange, ledger, deps } = setup(TIGHT, { waiveMarkup: false });
  exchange.setMarketState(1800, 'post_only');
  await assert.rejects(placeConditionalBet(deps, request(exchange)), (err: unknown) => {
    assert.ok(err instanceof BetRefused);
    assert.equal(err.code, 'market_closed');
    assert.match(err.message, /post_only/);
    return true;
  });
  assert.equal(exchange.sent.length, 0);
  assert.equal(ledger.data.bets.length, 0);
});

test('market state: checked again immediately before trading, not only at the first look', async () => {
  const { exchange, deps } = setup(TIGHT, { waiveMarkup: false });
  const original = exchange.getEvent.bind(exchange);
  let reads = 0;
  exchange.getEvent = async (ticker) => {
    const event = await original(ticker);
    if (++reads === 1) exchange.setMarketState(1820, 'closed'); // the market closes right after the first read
    return event;
  };
  await assert.rejects(placeConditionalBet(deps, request(exchange)), /not open for trading/);
  assert.ok(reads >= 2);
  assert.equal(exchange.sent.length, 0);
});

// ---------------------------------------------------------------- depth guard

test('depth guard: a thin outcome book reduces the stake, and the caller is told', async () => {
  const { exchange, ledger, deps } = setup(
    [
      { strike: 1800, bid: 0.8, ask: 0.82 },
      { strike: 1820, bid: 0.4, ask: 0.41, askSize: 5 }, // only 5 contracts on offer
    ],
    { waiveMarkup: false },
  );
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeConditionalBet(deps, request(exchange, { stake: 10 })); // $10 would want 19.51 contracts

  assert.equal(bet.status, 'open');
  assert.equal(bet.legs[0]!.quantityRequested, 5); // asked only for what was there
  assert.equal(bet.legs[0]!.status, 'filled'); // so nothing was left hanging as a partial fill
  assert.equal(bet.legs[1]!.quantityFilled, 2.57); // 5 * 0.41 = 2.05 -> 2.05 / 0.80 = 2.5625 -> 2.57
  assert.equal(bet.requestedStake, 10);
  assert.equal(bet.stakeReduced!.requested, 10);
  assert.equal(bet.stakeReduced!.reducedTo, 2.56); // 2.05 + 2.57 * 0.20 = 2.564
  assert.equal(bet.stakeReduced!.outcomeAvailable, 5);
  assert.match(bet.stakeReduced!.reason, /reduced from \$10\.00 to about \$2\.56/);
  near(bet.cost, 2.564);
  assert.equal(bet.payoffs!.hedged, true);
  assert.equal((await reconcile(exchange, ledger, 'primary')).ok, true);
});

test('depth guard: a thin CONDITION book reduces the stake so the hedge still fits whole', async () => {
  const { exchange, deps } = setup(
    [
      { strike: 1800, bid: 0.8, ask: 0.82, bidSize: 2 }, // only 2 contracts to hedge against
      { strike: 1820, bid: 0.4, ask: 0.41 },
    ],
    { waiveMarkup: false },
  );
  const bet = await placeConditionalBet(deps, request(exchange, { stake: 10 }));
  assert.equal(bet.status, 'open');
  assert.equal(bet.legs.length, 2); // one outcome order, one hedge order: no retries, no unwind
  assert.equal(bet.legs[0]!.quantityFilled, 3.9); // 3.90 * 0.41 = 1.599 -> hedge 1.99875 -> 2.00, which is all there is
  assert.equal(bet.legs[1]!.quantityFilled, 2);
  assert.equal(bet.legs[1]!.status, 'filled');
  assert.equal(bet.payoffs!.hedged, true);
  assert.equal(bet.stakeReduced!.conditionAvailable, 2);
});

test('depth guard: nothing resting, a book that moved away, or no depth at all -> refused, no order sent', async () => {
  const empty = setup(
    [
      { strike: 1800, bid: 0.8, ask: 0.82, bidSize: 0 },
      { strike: 1820, bid: 0.4, ask: 0.41 },
    ],
    { waiveMarkup: false },
  );
  await assert.rejects(placeConditionalBet(empty.deps, request(empty.exchange)), (err: unknown) => {
    assert.ok(err instanceof BetRefused);
    assert.equal(err.code, 'insufficient_depth');
    return true;
  });
  assert.equal(empty.exchange.sent.length, 0);
  assert.equal(empty.ledger.data.bets.length, 0);

  // Depth shows the best offer is now dearer than the quoted price: that size does not count.
  const moved = setup(TIGHT, { waiveMarkup: false });
  moved.exchange.reportedDepth.set(moved.exchange.symbol(1820), { ask: 0.45, askSize: 500 });
  await assert.rejects(placeConditionalBet(moved.deps, request(moved.exchange)), /Not enough is on offer/);
  assert.equal(moved.exchange.sent.length, 0);

  // The depth read itself fails: never trade blind.
  const blind = setup(TIGHT, { waiveMarkup: false });
  blind.exchange.depthUnavailable = true;
  await assert.rejects(placeConditionalBet(blind.deps, request(blind.exchange)), (err: unknown) => {
    assert.ok(err instanceof BetRefused);
    assert.equal(err.code, 'no_depth');
    assert.match(err.message, /no order was sent/);
    return true;
  });
  assert.equal(blind.exchange.sent.length, 0);
});

// ---------------------------------------------------------------- settlement that cannot hang

test('settlement: a void or fractional result becomes needs_review instead of staying open forever', async () => {
  const { exchange, ledger, deps } = setup(TIGHT, { waiveMarkup: false });
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeConditionalBet(deps, request(exchange, { stake: 10 }));
  assert.equal(bet.status, 'open');

  // Gemini settles the condition at a "last fair price" of 60 cents instead of yes/no; the outcome settles "no".
  exchange.settleUnclear(1800, { resolutionSide: null, settlementValue: '1799.99' }, 0.6);
  exchange.resolve(1820, 'no');

  // Within a minute of expiry the result may simply be late, so the bet is left alone...
  const early = await settleBets({ ...deps, now: () => new Date('2026-11-18T00:00:20Z') });
  assert.deepEqual([early.settled.length, early.needsReview.length], [0, 0]);
  assert.equal(bet.status, 'open');

  // ...after that it is flagged, with exactly what Gemini reported.
  const later = { ...deps, now: () => new Date('2026-11-18T00:02:00Z') };
  const done = await settleBets(later);
  assert.equal(done.settled.length, 0);
  assert.equal(done.needsReview.length, 1);
  assert.equal(bet.status, 'needs_review');
  assert.equal(bet.settlement, undefined); // no payout is guessed
  assert.equal(isScorable(bet), false); // excluded from scoring
  assert.match(bet.review!.reason, /without a clean yes\/no/);
  assert.equal(bet.review!.condition!.resolutionSide, null);
  assert.equal(bet.review!.condition!.status, 'settled');
  assert.equal(bet.review!.condition!.settlementValue, '1799.99');
  assert.equal(bet.review!.target!.resolutionSide, 'no');

  // It survives a restart, and settling again neither changes nor re-reports it.
  assert.equal(new Ledger(ledger.path).bet(bet.id)!.status, 'needs_review');
  const again = await settleBets(later);
  assert.deepEqual([again.settled.length, again.needsReview.length], [0, 0]);

  // Reconcile names the bet, and does not pretend the cash ties out.
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.deepEqual(rec.betsNeedingReview, [bet.id]);
  assert.equal(rec.ok, false);
  near(rec.cashDifference!, bet.legs[1]!.quantityFilled * 0.6, 1e-6); // the fractional payout Given could not know
});

test('settlement: Gemini reporting an unknown word (e.g. UNSPECIFIED) is also flagged, and a later clean result promotes it', async () => {
  const { exchange, ledger, deps } = setup(TIGHT, { waiveMarkup: false });
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeConditionalBet(deps, request(exchange, { stake: 10 }));
  exchange.settleUnclear(1800, { resolutionSide: 'UNSPECIFIED' });
  exchange.settleUnclear(1820, { resolutionSide: 'UNSPECIFIED' });
  const later = { ...deps, now: () => new Date('2026-11-18T00:05:00Z') };
  assert.equal((await settleBets(later)).needsReview.length, 1);
  assert.equal(bet.status, 'needs_review');
  assert.equal(bet.review!.condition!.resolutionSide, 'UNSPECIFIED');

  // Gemini later publishes a clean result: the bet settles normally and becomes scorable.
  exchange.resolve(1800, 'yes');
  exchange.resolve(1820, 'no');
  const done = await settleBets(later);
  assert.equal(done.settled.length, 1);
  assert.equal(bet.status, 'settled');
  assert.equal(bet.settlement!.conditionResolved, 'yes');
  assert.equal(isScorable(bet), true);
});

test('settlement: an event that has not settled yet is left open, however late it is', async () => {
  const { exchange, deps } = setup(TIGHT, { waiveMarkup: false });
  const bet = await placeConditionalBet(deps, request(exchange, { stake: 10 }));
  exchange.resolve(1820, 'no'); // only one of the two contracts has settled
  const done = await settleBets({ ...deps, now: () => new Date('2026-11-19T00:00:00Z') });
  assert.deepEqual([done.settled.length, done.needsReview.length], [0, 0]);
  assert.equal(bet.status, 'open');
});

test('settlement: an event marked settled is enough, even if a voided contract carries some other status', async () => {
  const { exchange, deps } = setup(TIGHT, { waiveMarkup: false });
  const bet = await placeConditionalBet(deps, request(exchange, { stake: 10 }));
  exchange.setContractStatus(1800, 'voided'); // not "settled", no result, no resolvedAt
  exchange.resolve(1820, 'no');
  const later = { ...deps, now: () => new Date('2026-11-18T00:05:00Z') };

  // While the event is still active, one unsettled-looking contract means "not settled yet".
  assert.equal((await settleBets(later)).needsReview.length, 0);
  assert.equal(bet.status, 'open');

  // Once Gemini marks the event settled, the bet must not stay open.
  exchange.setEventStatus('settled');
  const done = await settleBets(later);
  assert.equal(done.needsReview.length, 1);
  assert.equal(bet.status, 'needs_review');
  assert.equal(bet.review!.eventStatus, 'settled');
  assert.equal(bet.review!.condition!.status, 'voided');
  assert.equal(isScorable(bet), false);
});

/**
 * Seen on Gemini's sandbox on 2026-11-18: a bet holding 1 YES on "$1,800 or above" (its target) and a second bet
 * holding 3.52 NO on the same market (its condition) left one position of 2.52 NO and $1.00 more cash than the ledger
 * expected. Gemini nets YES against NO at once and pays $1 a pair. The reconcile must count that, before and after
 * settlement, or the proof page shows a difference for any two bets that share a strike.
 */
const SHARED_STRIKE = [
  { strike: 1780, bid: 0.85, ask: 0.87 },
  { strike: 1800, bid: 0.5, ask: 0.52 },
  { strike: 1820, bid: 0.2, ask: 0.22 },
];

for (const [name, finish] of [
  ['price ends between the strikes', { 1780: 'yes', 1800: 'no', 1820: 'no' }],
  ['price ends above them all', { 1780: 'yes', 1800: 'yes', 1820: 'yes' }],
  ['price ends below them all', { 1780: 'no', 1800: 'no', 1820: 'no' }],
] as const) {
  test(`two bets sharing a strike: Gemini's YES/NO netting still reconciles (${name})`, async () => {
    const { exchange, ledger, deps } = setup(SHARED_STRIKE);
    await ensureBaseline(exchange, ledger, 'primary');

    // Bet 1 buys YES on 1800 (its target). Bet 2 buys NO on 1800 (its condition).
    const first = await placeConditionalBet(deps, request(exchange, { conditionSymbol: exchange.symbol(1780), targetSymbol: exchange.symbol(1800), stake: 5 }));
    const second = await placeConditionalBet(deps, request(exchange, { conditionSymbol: exchange.symbol(1800), targetSymbol: exchange.symbol(1820), stake: 5 }));
    const yes = netHolding(first, exchange.symbol(1800), 'yes').quantity;
    const no = netHolding(second, exchange.symbol(1800), 'no').quantity;
    const pairs = Math.min(yes, no);
    assert.ok(pairs > 0, 'the two bets really do hold opposite sides of one market');

    // The exchange holds only the net position and has already paid out the pairs.
    near(exchange.positions.get(`${exchange.symbol(1800)}|yes`)!, yes - pairs);
    near(exchange.positions.get(`${exchange.symbol(1800)}|no`)!, no - pairs);
    near(await exchange.cash(), 1000 - first.cost - second.cost + pairs);

    const open = await reconcile(exchange, ledger, 'primary');
    near(open.nettedContracts, pairs);
    near(open.nettedCash, pairs);
    near(open.cashDifference!, 0);
    assert.equal(open.ok, true);

    for (const [strike, side] of Object.entries(finish)) exchange.resolve(Number(strike), side);
    const done = await settleBets(deps);
    assert.equal(done.settled.length, 2);
    assert.equal(done.needsReview.length, 0);

    // After settlement the bets' own payouts cover the same money, so nothing is counted twice.
    const closed = await reconcile(exchange, ledger, 'primary');
    assert.equal(closed.nettedContracts, 0);
    near(closed.cashDifference!, 0);
    assert.equal(closed.ok, true);
  });
}
