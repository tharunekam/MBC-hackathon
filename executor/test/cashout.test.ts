import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { holdings, isScorable, placeConditionalBet, settleBets } from '../src/bets.ts';
import { CashOutRefused, cashOutBet, nettedAgainst, quoteCashOut } from '../src/cashout.ts';
import { betFlow } from '../src/flow.ts';
import { Ledger } from '../src/ledger.ts';
import { placeRangeBet } from '../src/range-bet.ts';
import { ensureBaseline, reconcile } from '../src/reconcile.ts';
import { start } from './api-harness.ts';
import { FakeExchange } from './fake.ts';

const near = (actual: number, expected: number, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);

/** A tight four-strike ladder. */
const LADDER = [
  { strike: 1780, bid: 0.88, ask: 0.9 },
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.6, ask: 0.62 },
  { strike: 1840, bid: 0.4, ask: 0.42 },
];

async function setup(feeCoef = 0) {
  const exchange = new FakeExchange('ETHTEST', LADDER);
  exchange.feeCoef = feeCoef;
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-cashout-')), 'ledger.json'));
  let n = 0;
  const deps = { exchange, ledger, feeCoef, newId: () => `t${++n}`, now: () => new Date('2026-11-17T23:10:00Z'), waiveMarkup: true }; // these tests are about leaving a bet, not about which bets are on offer
  await ensureBaseline(exchange, ledger, 'primary');
  const rising = () =>
    placeConditionalBet(deps, { user: 'primary', eventTicker: 'ETHTEST', conditionSymbol: exchange.symbol(1800), targetSymbol: exchange.symbol(1820), stake: 10 });
  const falling = () =>
    placeConditionalBet(deps, { user: 'primary', eventTicker: 'ETHTEST', direction: 'down', conditionSymbol: exchange.symbol(1820), targetSymbol: exchange.symbol(1800), stake: 10 });
  const range = () => placeRangeBet(deps, { user: 'primary', eventTicker: 'ETHTEST', lowSymbol: exchange.symbol(1800), highSymbol: exchange.symbol(1820), stake: 4 });
  const tiedOut = async () => {
    const rec = await reconcile(exchange, ledger, 'primary');
    assert.deepEqual(rec.mismatches, []);
    near(rec.cashDifference!, 0);
    assert.equal(rec.ok, true);
  };
  const refused = async (bet: Parameters<typeof cashOutBet>[1], req?: Parameters<typeof cashOutBet>[2]): Promise<CashOutRefused> => {
    try {
      await cashOutBet(deps, bet, req);
    } catch (err) {
      assert.ok(err instanceof CashOutRefused, `expected a refusal, got ${String(err)}`);
      return err;
    }
    assert.fail('expected the cash-out to be refused');
  };
  return { exchange, ledger, deps, rising, falling, range, tiedOut, refused };
}

const positionsHeld = (ex: FakeExchange) => [...ex.positions.values()].filter((q) => Math.abs(q) > 1e-9).length;

// ------------------------------------------------------------------ the sale

test('a rising parlay cashes out as two sells at the bids, and the cash ties out', async () => {
  const { exchange, deps, rising, tiedOut } = await setup();
  const bet = await rising();
  assert.equal(bet.status, 'open');
  near(bet.cost, 9.9946); // 12.83 YES on 1820 at 0.62, 10.2 NO on 1800 at 0.20: never more than the $10 asked for

  const quote = await quoteCashOut(deps, bet);
  assert.equal(quote.available, true);
  assert.equal(quote.code, null);
  assert.deepEqual(
    quote.legs.map((l) => [l.role, l.symbol, l.outcome, l.quantity, l.price]),
    [
      ['outcome', exchange.symbol(1820), 'yes', 12.83, 0.6],
      ['hedge', exchange.symbol(1800), 'no', 10.2, 0.18], // a NO seller gets 1 minus the YES ask of 0.82
    ],
  );
  near(quote.proceeds!, 9.53); // 12.83 x 0.60 + 10.20 x 0.18 = 9.534, to the cent
  near(quote.pnl!, 9.53 - 9.9946, 0.006);
  assert.equal(exchange.sent.length, 2, 'a quote sends nothing');

  const done = await cashOutBet(deps, bet);
  assert.equal(done.status, 'cashed_out');
  assert.deepEqual(
    exchange.sent.slice(2).map((o) => [o.side, o.outcome, o.symbol, o.quantity, o.tif, o.clientOrderId]),
    [
      ['sell', 'yes', exchange.symbol(1820), 12.83, 'IOC', 'gv-t1-cb1'],
      ['sell', 'no', exchange.symbol(1800), 10.2, 'IOC', 'gv-t1-ca1'],
    ],
  );
  assert.equal(done.cashOut?.complete, true);
  near(done.cashOut!.stake, 9.9946);
  near(done.cashOut!.proceeds, 9.534);
  near(done.cashOut!.pnl, -0.4606);
  assert.equal(positionsHeld(exchange), 0, 'nothing is left on the account');
  near(exchange.cashBalance, 1000 - 0.4606);
  assert.equal(betFlow(done).ordersFilled, 4, 'the sells are order flow too');
  await tiedOut();
});

test('a falling parlay sells the real sides it holds: NO on the target, YES on the condition', async () => {
  const { exchange, deps, falling, tiedOut } = await setup();
  const bet = await falling();
  assert.equal(bet.status, 'open');
  const h = holdings(bet);

  const quote = await quoteCashOut(deps, bet);
  assert.equal(quote.available, true);
  assert.deepEqual(
    quote.legs.map((l) => [l.role, l.symbol, l.outcome, l.price]),
    [
      ['outcome', exchange.symbol(1800), 'no', 0.18], // NO on 1800 sells at 1 minus its ask of 0.82
      ['hedge', exchange.symbol(1820), 'yes', 0.6], //   YES on 1820 sells at its bid
    ],
  );
  near(quote.proceeds!, Math.round((h.outcome.quantity * 0.18 + h.hedge.quantity * 0.6) * 100) / 100);

  const done = await cashOutBet(deps, bet);
  assert.equal(done.status, 'cashed_out');
  assert.deepEqual(
    exchange.sent.slice(2).map((o) => [o.side, o.outcome, o.symbol]),
    [
      ['sell', 'no', exchange.symbol(1800)],
      ['sell', 'yes', exchange.symbol(1820)],
    ],
  );
  assert.equal(positionsHeld(exchange), 0);
  await tiedOut();
});

test('a range cashes out: YES on the lower strike and NO on the higher are both sold', async () => {
  const { exchange, deps, range, tiedOut } = await setup();
  const bet = await range();
  assert.equal(bet.status, 'open');
  const h = holdings(bet);
  assert.equal(h.outcome.quantity, h.hedge.quantity);

  const done = await cashOutBet(deps, bet);
  assert.equal(done.status, 'cashed_out');
  assert.deepEqual(
    exchange.sent.slice(2).map((o) => [o.side, o.outcome, o.symbol, o.quantity]),
    [
      ['sell', 'yes', exchange.symbol(1800), h.outcome.quantity],
      ['sell', 'no', exchange.symbol(1820), h.hedge.quantity],
    ],
  );
  // YES on 1800 sells at 0.80, NO on 1820 at 1 - 0.62 = 0.38.
  near(done.cashOut!.proceeds, h.outcome.quantity * 0.8 + h.hedge.quantity * 0.38);
  assert.equal(positionsHeld(exchange), 0);
  await tiedOut();
});

test('with fees charged, the proceeds are net of both sell fees and the cash still ties out', async () => {
  const { exchange, deps, rising, tiedOut } = await setup(0.07);
  const bet = await rising();
  assert.equal(bet.status, 'open');
  const before = exchange.cashBalance;
  const quote = await quoteCashOut(deps, bet);
  const done = await cashOutBet(deps, bet);
  assert.equal(done.status, 'cashed_out');
  near(done.cashOut!.proceeds, quote.proceeds!, 0.011); // the quote is to the cent
  near(exchange.cashBalance - before, done.cashOut!.proceeds);
  const fees = done.legs.filter((l) => l.role === 'cashout').reduce((sum, l) => sum + l.fee, 0);
  assert.ok(fees > 0, 'each sell paid a fee');
  assert.equal(quote.proceedsAtProductionFees, quote.proceeds, 'this venue charges the production rate');
  await tiedOut();
});

// ------------------------------------------------------------------ refusals, each before any order

test('a bet that is not live cannot be cashed out: settled, already cashed out, or failed', async () => {
  const { exchange, deps, rising, refused } = await setup();
  const first = await rising();
  await cashOutBet(deps, first);
  const sentAfterSale = exchange.sent.length;
  const again = await refused(first);
  assert.equal(again.code, 'not_open');
  assert.match(again.message, /already been cashed out/);

  const second = await rising();
  exchange.resolve(1800, 'yes');
  exchange.resolve(1820, 'yes');
  await settleBets(deps);
  assert.equal(second.status, 'settled');
  assert.equal((await refused(second)).code, 'not_open');
  assert.equal(exchange.sent.length, sentAfterSale + 2, 'only the second bet\'s two buys were sent');
});

test('a market that is not taking orders refuses the sale and says which contract', async () => {
  const { exchange, deps, rising, refused } = await setup();
  const bet = await rising();
  exchange.setMarketState(1820, 'post_only');
  const err = await refused(bet);
  assert.equal(err.code, 'market_closed');
  assert.match(err.message, /active\/post_only/);
  assert.equal(err.quote?.available, false);
  assert.equal(exchange.sent.length, 2);
  assert.equal(bet.status, 'open');
});

test('no bid on a leg, or a book that cannot be read, refuses the sale', async () => {
  const { exchange, deps, rising, refused } = await setup();
  const bet = await rising();
  exchange.setBook(1820, { bid: null });
  assert.equal((await refused(bet)).code, 'no_bid');
  exchange.setBook(1820, { bid: 0.6 });
  exchange.depthUnavailable = true;
  const err = await refused(bet);
  assert.equal(err.code, 'no_bid');
  assert.match(err.message, /Could not read the live order book/);
  assert.equal(exchange.sent.length, 2);
});

test('less wanted at the best price than the bet holds refuses the sale, with the price it would have fetched', async () => {
  const { exchange, deps, rising, refused } = await setup();
  const bet = await rising();
  exchange.setBook(1820, { bidSize: 5 }); // the bet holds 12.83
  const err = await refused(bet);
  assert.equal(err.code, 'insufficient_depth');
  assert.match(err.message, /5 of 12.83 contracts/);
  near(err.quote!.proceeds!, 9.53);
  assert.equal(err.quote!.legs[0].available, 5);
  assert.equal(exchange.sent.length, 2);
});

test('a floor on the proceeds is checked against the live quote before anything is sold', async () => {
  const { exchange, deps, rising, refused } = await setup();
  const bet = await rising();
  const err = await refused(bet, { minProceeds: 9.6 });
  assert.equal(err.code, 'below_minimum');
  assert.match(err.message, /\$9\.53, below the \$9\.60/);
  assert.equal(exchange.sent.length, 2);
  const done = await cashOutBet(deps, bet, { minProceeds: 9.53 });
  assert.equal(done.status, 'cashed_out');
  // With a floor each order is limited at the quoted price itself, so the sale cannot come in under what was checked.
  assert.deepEqual(exchange.sent.slice(2).map((o) => o.limitPrice), [0.6, 0.18]);
  assert.ok(done.cashOut!.proceeds >= 9.53 - 0.005);
});

test('without a floor an order may reach one cent past the best price; with one, never', async () => {
  const { exchange, deps, rising, refused } = await setup();
  const bet = await rising();
  // The depth read still shows a bid of 0.60; the real bid has slipped one cent.
  exchange.reportedDepth.set(exchange.symbol(1820), { bid: 0.6, bidSize: 1000 });
  exchange.setBook(1820, { bid: 0.59 });
  const err = await refused(bet, { minProceeds: 9.5 });
  assert.equal(err.code, 'nothing_sold', 'held to the quoted price, the order does not chase the lower bid');
  assert.equal(bet.status, 'open');
  const done = await cashOutBet(deps, bet);
  assert.equal(done.status, 'cashed_out');
  assert.equal(exchange.sent.at(-2)!.limitPrice, 0.59, 'one cent of reach');
});

test('order tags never repeat, however many part sales a bet goes through', async () => {
  const { exchange, deps, rising, tiedOut } = await setup();
  const bet = await rising();
  // The outcome leg sells whole on the first attempt; the hedge then sells 4, 3 and the rest on three attempts.
  exchange.reportedDepth.set(exchange.symbol(1800), { askSize: 1000 });
  exchange.setBook(1800, { askSize: 4 });
  await cashOutBet(deps, bet);
  exchange.setBook(1800, { askSize: 3 });
  const second = await cashOutBet(deps, bet);
  assert.equal(second.cashOut?.complete, false);
  exchange.reportedDepth.clear();
  exchange.setBook(1800, { askSize: 1000 });
  const done = await cashOutBet(deps, bet);
  assert.equal(done.status, 'cashed_out');
  const tags = done.legs.map((l) => l.clientOrderId);
  assert.equal(new Set(tags).size, tags.length, `a tag was used twice: ${tags.join(', ')}`);
  assert.deepEqual(tags.slice(2), ['gv-t1-cb1', 'gv-t1-ca1', 'gv-t1-ca3', 'gv-t1-ca4']);
  near(done.cashOut!.proceeds, 12.83 * 0.6 + 10.2 * 0.18);
  await tiedOut();
});

test('a bet whose contract another open bet holds the other side of is refused: Gemini has netted it away', async () => {
  const { exchange, deps, ledger, rising, refused, tiedOut } = await setup();
  const first = await rising(); // YES on 1820, NO on 1800
  // A second bet one rung up: its hedge is NO on 1820, the other side of the first bet's outcome.
  const second = await placeConditionalBet(deps, { user: 'primary', eventTicker: 'ETHTEST', conditionSymbol: exchange.symbol(1820), targetSymbol: exchange.symbol(1840), stake: 5 });
  assert.equal(second.status, 'open');
  assert.deepEqual(nettedAgainst(ledger, first), [exchange.symbol(1820)]);
  assert.deepEqual(nettedAgainst(ledger, second), [exchange.symbol(1820)]);
  const sent = exchange.sent.length;
  const err = await refused(first);
  assert.equal(err.code, 'position_netted');
  assert.equal((await refused(second)).code, 'position_netted');
  assert.equal(exchange.sent.length, sent);
  await tiedOut();

  // Once the other bet has settled it no longer counts.
  const { exchange: ex2, deps: deps2, ledger: ledger2, rising: rising2 } = await setup();
  const a = await rising2();
  await cashOutBet(deps2, a);
  const b = await rising2();
  assert.deepEqual(nettedAgainst(ledger2, b), [], 'a cashed-out bet holds nothing, so it nets against nothing');
  assert.equal((await cashOutBet(deps2, b)).status, 'cashed_out');
  assert.equal(positionsHeld(ex2), 0);
});

// ------------------------------------------------------------------ the book moves between the read and the order

test('if the first sell fills nothing the bet is left exactly as it was', async () => {
  const { exchange, deps, rising, refused, tiedOut } = await setup();
  const bet = await rising();
  // The depth read still shows the old bid; the real one has dropped 5 cents, past the 1 cent the order may reach.
  exchange.reportedDepth.set(exchange.symbol(1820), { bid: 0.6, bidSize: 1000 });
  exchange.setBook(1820, { bid: 0.55 });
  const err = await refused(bet);
  assert.equal(err.code, 'nothing_sold');
  assert.equal(bet.status, 'open');
  assert.equal(bet.cashOut, undefined);
  near(bet.cost, 9.9946);
  assert.equal(bet.payoffs?.hedged, true);
  assert.equal(exchange.sent.length, 3, 'the hedge was not sold after the outcome sell missed');
  assert.equal(bet.legs.at(-1)?.status, 'unfilled');
  await tiedOut();

  // The next attempt uses fresh order tags and goes through.
  exchange.reportedDepth.clear();
  const done = await cashOutBet(deps, bet);
  assert.equal(done.status, 'cashed_out');
  assert.deepEqual(exchange.sent.slice(3).map((o) => o.clientOrderId), ['gv-t1-cb2', 'gv-t1-ca2']);
  await tiedOut();
});

test('if only the outcome leg sells, the refund leg stays in place and a second cash-out finishes the job', async () => {
  const { exchange, deps, rising, tiedOut } = await setup();
  const bet = await rising();
  // The hedge's book thins out after the depth read: only 4 of its 10.2 contracts are wanted.
  exchange.reportedDepth.set(exchange.symbol(1800), { askSize: 1000 });
  exchange.setBook(1800, { askSize: 4 });
  const part = await cashOutBet(deps, bet);
  assert.equal(part.cashOut?.complete, false);
  assert.notEqual(part.status, 'cashed_out');
  assert.match(part.note ?? '', /pays the stake back if the condition fails/);
  near(part.cashOut!.proceeds, 12.83 * 0.6 + 4 * 0.18);
  const h = holdings(part);
  near(h.outcome.quantity, 0);
  near(h.hedge.quantity, 6.2);
  await tiedOut();

  exchange.reportedDepth.clear();
  exchange.setBook(1800, { askSize: 1000 });
  const done = await cashOutBet(deps, bet);
  assert.equal(done.status, 'cashed_out');
  assert.equal(done.cashOut?.complete, true);
  near(done.cashOut!.stake, 9.9946); // still what the bet cost before the first sale
  near(done.cashOut!.proceeds, 9.534);
  near(done.cashOut!.pnl, -0.4606);
  assert.equal(positionsHeld(exchange), 0);
  await tiedOut();
});

test('a bet sold back whole is never settled or paid, but how its call turned out is recorded once the market has a clean result', async () => {
  const { exchange, deps, rising, tiedOut } = await setup();
  const bet = await rising(); // given 1800, will it reach 1820
  await cashOutBet(deps, bet);
  assert.equal(bet.status, 'cashed_out');
  assert.equal(isScorable(bet), false); // the market is still open: nothing to score yet
  const cashBefore = await exchange.cash();

  const early = await settleBets(deps);
  assert.deepEqual([early.settled.length, early.called.length], [0, 0]);
  assert.equal(bet.called, undefined);

  exchange.resolve(1800, 'yes', 1833.5);
  exchange.resolve(1820, 'yes', 1833.5);
  const done = await settleBets(deps);
  assert.deepEqual([done.settled.length, done.called.length], [0, 1]);
  assert.equal(bet.status, 'cashed_out'); // still sold back: it holds nothing, so nothing settles
  assert.equal(bet.settlement, undefined);
  assert.deepEqual({ ...bet.called!, at: undefined }, { conditionResolved: 'yes', targetResolved: 'yes', at: undefined, finishedAt: 1833.5 });
  assert.equal(isScorable(bet), true);
  near(await exchange.cash(), cashBefore); // no payout: the money was the sale
  assert.equal((await settleBets(deps)).called.length, 0); // recorded once
  await tiedOut();
});

test('a sold-back falling parlay and a sold-back range read their call in their own terms, and an unclear result leaves it unscored', async () => {
  const fall = await setup();
  const down = await fall.falling(); // given it stays under 1820, will it fall below 1800
  await cashOutBet(fall.deps, down);
  fall.exchange.resolve(1820, 'no');
  fall.exchange.resolve(1800, 'yes'); // stayed under 1820, did not fall below 1800: the first half held, the second missed
  await settleBets(fall.deps);
  assert.deepEqual([down.called!.conditionResolved, down.called!.targetResolved], ['yes', 'no']);

  const box = await setup();
  const inside = await box.range(); // between 1800 and 1820
  await cashOutBet(box.deps, inside);
  box.exchange.resolve(1800, 'yes');
  box.exchange.resolve(1820, 'no');
  await settleBets(box.deps);
  assert.deepEqual([inside.called!.conditionResolved, inside.called!.targetResolved], ['yes', 'yes']);

  const murky = await setup();
  const bet = await murky.rising();
  await cashOutBet(murky.deps, bet);
  murky.exchange.settleUnclear(1800, { resolutionSide: null, settlementValue: null });
  murky.exchange.resolve(1820, 'yes');
  const done = await settleBets(murky.deps);
  assert.equal(done.called.length, 0);
  assert.equal(done.needsReview.length, 0); // nothing is held, so there is no payout to be unsure of
  assert.equal(bet.called, undefined);
  assert.equal(isScorable(bet), false);
});

test('if only part of the first leg sells, only the matching share of the refund leg is sold, so what is left is still a hedged bet', async () => {
  const { exchange, deps, rising, tiedOut } = await setup();
  const bet = await rising(); // 12.83 YES on 1820, 10.2 NO on 1800
  // The outcome's book thins out after the depth read: only 5 of its 12.83 contracts are wanted.
  exchange.reportedDepth.set(exchange.symbol(1820), { bidSize: 1000 });
  exchange.setBook(1820, { bidSize: 5 });
  const part = await cashOutBet(deps, bet);
  const h = holdings(part);
  near(h.outcome.quantity, 7.83);
  // Not the whole 10.2: that would leave 7.83 contracts that lose everything if 1800 fails. And a little under the plain
  // share (3.97), because selling at the bid gave up some of the stake and the refund must still cover what is left.
  assert.ok(h.hedge.quantity > 6.2 && h.hedge.quantity < 6.5, `kept ${h.hedge.quantity} refund contracts`);
  assert.equal(part.cashOut?.complete, false);
  assert.equal(part.status, 'open'); // still a whole bet, only smaller
  assert.equal(part.payoffs!.hedged, true);
  assert.ok(part.payoffs!.ifConditionFails! >= -0.005, `the refund is short by ${part.payoffs!.ifConditionFails}`);
  assert.match(part.note ?? '', /Only part of this bet could be sold back/);
  await tiedOut();

  // The rest can be sold when the book is back, and nothing is left behind.
  exchange.reportedDepth.clear();
  exchange.setBook(1820, { bidSize: 1000 });
  const done = await cashOutBet(deps, bet);
  assert.equal(done.status, 'cashed_out');
  near(done.cashOut!.proceeds, 12.83 * 0.6 + 10.2 * 0.18);
  assert.equal(positionsHeld(exchange), 0);
  await tiedOut();
});

test('a range sold in part keeps its two legs the same size', async () => {
  const { exchange, deps, range, tiedOut } = await setup();
  const bet = await range(); // YES on 1800 and NO on 1820, the same number of each
  const before = holdings(bet);
  exchange.reportedDepth.set(exchange.symbol(1800), { bidSize: 1000 });
  exchange.setBook(1800, { bidSize: 1 });
  const part = await cashOutBet(deps, bet);
  const h = holdings(part);
  near(h.outcome.quantity, before.outcome.quantity - 1);
  near(h.hedge.quantity, before.hedge.quantity - 1);
  assert.equal(part.payoffs!.hedged, true);
  assert.equal(part.status, 'open');
  await tiedOut();
});

test('a bet left half sold still settles on what it holds', async () => {
  const { exchange, deps, rising, tiedOut } = await setup();
  const bet = await rising();
  exchange.reportedDepth.set(exchange.symbol(1800), { askSize: 1000 });
  exchange.setBook(1800, { askSize: 4 });
  await cashOutBet(deps, bet); // sells all 12.83 of the outcome and 4 of the 10.2 hedge contracts
  exchange.resolve(1800, 'no'); // the condition fails: the 6.2 NO contracts still held pay $1 each
  exchange.resolve(1820, 'no');
  const { settled } = await settleBets(deps);
  assert.equal(settled.length, 1);
  assert.equal(bet.status, 'settled');
  near(bet.settlement!.payout, 6.2);
  await tiedOut();
});

// ------------------------------------------------------------------ over HTTP

test('GET /cashout quotes and POST /cashout sells; the bet list shows it and settle leaves it alone', async () => {
  const s = await start(LADDER);
  try {
    const placed = await s.call('POST', '/bets', s.betBody());
    assert.equal(placed.status, 201);
    const id = placed.json.bet.id as string;

    const quote = await s.call('GET', `/cashout?bet=${id}`);
    assert.equal(quote.status, 200);
    assert.equal(quote.json.available, true);
    assert.equal(quote.json.betId, id);
    assert.ok(quote.headers.get('etag'), 'a quote can be revalidated like any other GET');
    const proceeds = quote.json.proceeds as number;

    const tooMuch = await s.call('POST', '/cashout', { bet: id, minProceeds: proceeds + 1 });
    assert.equal(tooMuch.status, 422);
    assert.equal(tooMuch.json.code, 'below_minimum');
    assert.equal(tooMuch.json.quote.proceeds, proceeds);

    const done = await s.call('POST', '/cashout', { bet: id, minProceeds: proceeds });
    assert.equal(done.status, 200);
    assert.equal(done.json.bet.status, 'cashed_out');
    assert.equal(done.json.cashOut.complete, true);
    near(done.json.cashOut.proceeds, proceeds, 0.011);
    assert.equal(done.json.bet.scorable, false);

    const again = await s.call('POST', '/cashout', { bet: id });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'not_open');
    const after = await s.call('GET', `/cashout?bet=${id}`);
    assert.equal(after.json.available, false);
    assert.equal(after.json.code, 'not_open');

    const list = await s.call('GET', '/bets?user=primary');
    assert.equal(list.json.bets[0].status, 'cashed_out');
    s.exchange.resolve(1800, 'yes');
    s.exchange.resolve(1820, 'yes');
    const settled = await s.call('POST', '/settle');
    assert.equal(settled.json.settled.length, 0);
    assert.equal(settled.json.stillOpen, 0);

    const rec = await s.call('GET', '/reconcile?user=primary');
    assert.equal(rec.json.ok, true);
    assert.equal(rec.json.ordersChecked, 4);
  } finally {
    await s.close();
  }
});

test('POST /cashout: an unknown bet is 404, a missing one 400, a bad floor 400', async () => {
  const s = await start(LADDER);
  try {
    assert.equal((await s.call('POST', '/cashout', { bet: 'nope' })).status, 404);
    assert.equal((await s.call('GET', '/cashout?bet=nope')).json.code, 'unknown_bet');
    assert.equal((await s.call('POST', '/cashout', {})).json.code, 'missing_field');
    const placed = await s.call('POST', '/bets', s.betBody());
    const bad = await s.call('POST', '/cashout', { bet: placed.json.bet.id, minProceeds: -1 });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'invalid_min_proceeds');
    assert.equal(s.exchange.sent.length, 2);
  } finally {
    await s.close();
  }
});
