import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { netHolding, placeConditionalBet, recoverBets, settleBets } from '../src/bets.ts';
import { Ledger } from '../src/ledger.ts';
import { ensureBaseline, reconcile } from '../src/reconcile.ts';
import { FakeExchange } from './fake.ts';

const near = (actual: number, expected: number, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);

function setup(strikes: ConstructorParameters<typeof FakeExchange>[1]) {
  const exchange = new FakeExchange('ETHTEST', strikes);
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-')), 'ledger.json'));
  let n = 0;
  const deps = { exchange, ledger, newId: () => `t${++n}`, now: () => new Date('2026-11-17T23:10:00Z') };
  return { exchange, ledger, deps };
}

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
  assert.ok(bet.payoffs!.ifConditionFails >= 0 && bet.payoffs!.ifConditionFails < 0.01);
  near(bet.cost, 10.01 * 0.3 + 4.23 * 0.29);
  near(await exchange.cash(), 1000 - bet.cost); // every dollar accounted for

  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true);
  assert.equal(rec.mismatches.length, 0);
  near(rec.cashDifference!, 0);
});

test('thin book: only what filled on the outcome is hedged', async () => {
  const { exchange, deps } = setup([
    { strike: 1800, bid: 0.71, ask: 0.9 },
    { strike: 1820, bid: 0.11, ask: 0.3, askSize: 1 }, // only 1 contract offered, as seen in the sandbox
  ]);
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

    assert.equal((await settleBets(deps)).length, 0); // not resolved yet
    exchange.resolve(1800, aSide);
    exchange.resolve(1820, bSide);
    const done = await settleBets(deps);
    assert.equal(done.length, 1);
    assert.equal(bet.status, 'settled');

    const pnl = bet.settlement!.pnl;
    if (expected === 'refund') near(pnl, predicted.ifConditionFails);
    if (expected === 'win') near(pnl, predicted.ifBothHit);
    if (expected === 'lose') near(pnl, predicted.ifConditionOnly);
    near(await exchange.cash(), 1000 + pnl); // the venue's cash agrees with the ledger's result
    assert.equal((await reconcile(exchange, ledger, 'primary')).ok, true);

    assert.equal((await settleBets(deps)).length, 0); // settling twice changes nothing
    near(await exchange.cash(), 1000 + pnl);
  });
}

test('interrupted mid-bet: recovery finds the order by its tag instead of resending', async () => {
  const { exchange, ledger, deps } = setup(LADDER);
  exchange.failAfterSend = 'gv-t1-b'; // the outcome order reaches the venue, then the connection dies
  const bet = await placeConditionalBet(deps, request(exchange));
  assert.equal(bet.status, 'failed'); // we could not confirm it...
  assert.equal(bet.legs[0]!.status, 'error');
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
