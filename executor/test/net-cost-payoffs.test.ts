/**
 * A bet's stored `payoffs` are what every page shows for it before it settles, so they must say what the account will
 * really net. They used to be rebuilt from each leg's average price, which drops a leg that has been sold back: an unwound
 * bet showed a stake of zero (and every figure zero) while the account was down by what it had lost.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { holdings, legMap, placeConditionalBet, refreshTotals } from '../src/bets.ts';
import { cashOutBet } from '../src/cashout.ts';
import type { BetRecord, LegRecord } from '../src/ledger.ts';
import { Ledger } from '../src/ledger.ts';
import { clean, payoffs, takerFee } from '../src/pricing.ts';
import { ensureBaseline } from '../src/reconcile.ts';
import { FakeExchange } from './fake.ts';

const near = (actual: number, expected: number, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);

const LADDER = [
  { strike: 1800, bid: 0.71, ask: 0.9 },
  { strike: 1820, bid: 0.11, ask: 0.3 },
];

function setup(strikes: ConstructorParameters<typeof FakeExchange>[1] = LADDER) {
  const exchange = new FakeExchange('ETHTEST', strikes);
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-netcost-')), 'ledger.json'));
  let n = 0;
  const deps = { exchange, ledger, newId: () => `t${++n}`, now: () => new Date('2026-11-17T23:10:00Z'), waiveMarkup: true };
  return { exchange, ledger, deps };
}
const request = (ex: FakeExchange, extra: object = {}) => ({ user: 'primary', eventTicker: 'ETHTEST', conditionSymbol: ex.symbol(1800), targetSymbol: ex.symbol(1820), stake: 10, slippageTicks: 0, ...extra });

/**
 * What the account would be worth (cash plus what its contracts pay, less where it started) if the market ended each way.
 * This is the venue's own number, read from the fake exchange, not anything the ledger computed.
 */
function accountNets(exchange: FakeExchange, bet: BetRecord, start: number) {
  const m = legMap(bet);
  const cash = exchange.cashBalance;
  const held = (symbol: string, outcome: 'yes' | 'no') => exchange.positions.get(`${symbol}|${outcome}`) ?? 0;
  const outcomePays = held(m.outcome.symbol, m.outcome.side);
  const hedgePays = held(m.hedge.symbol, m.hedge.side);
  return {
    ifBothHit: clean(cash + outcomePays - start),
    ifConditionFails: clean(cash + hedgePays - start),
    ifConditionOnly: clean(cash - start),
  };
}

function assertStoredFiguresAreTheAccounts(exchange: FakeExchange, bet: BetRecord, start: number): void {
  const nets = accountNets(exchange, bet, start);
  const p = bet.payoffs!;
  near(p.stake, bet.cost);
  near(p.ifBothHit, nets.ifBothHit);
  near(p.ifConditionFails!, nets.ifConditionFails);
  near(p.ifConditionOnly, nets.ifConditionOnly);
}

test('an unwound bet shows what it lost: the stake is its net cost, not zero, and each figure is what the account really nets', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  const real = exchange.placeOrder.bind(exchange);
  exchange.placeOrder = async (req) => {
    const res = await real(req);
    if (req.clientOrderId.endsWith('-b')) exchange.setBook(1800, { bid: 0.5 }); // the hedge now costs too much: the bet is sold back
    return res;
  };
  const bet = await placeConditionalBet(deps, request(exchange, { maxPrice: 0.45 }));
  assert.equal(bet.status, 'unwound');
  assert.ok(bet.cost > 0.1, `it lost real money, ${bet.cost}`);
  assert.equal(holdings(bet).outcome.quantity, 0);

  const p = bet.payoffs!;
  near(p.stake, bet.cost);
  assert.ok(p.stake > 0, 'not reported as zero');
  assert.equal(p.hedged, false);
  assert.equal(p.conditionalPrice, null);
  assertStoredFiguresAreTheAccounts(exchange, bet, 1000);
  near(p.ifBothHit, exchange.cashBalance - 1000); // the account holds nothing now: every region is the cash it lost
});

test('a bet that was only partly sold back keeps its remaining contracts and its real cost in every figure', async () => {
  const { exchange, ledger, deps } = setup();
  await ensureBaseline(exchange, ledger, 'primary');
  const real = exchange.placeOrder.bind(exchange);
  exchange.placeOrder = async (req) => {
    const res = await real(req);
    if (req.clientOrderId.endsWith('-b')) {
      exchange.setBook(1800, { bid: 0.5 }); // no affordable hedge
      exchange.setBook(1820, { bidSize: 2 }); // and only 2 contracts can be sold back at the bid
    }
    return res;
  };
  const bet = await placeConditionalBet(deps, request(exchange, { maxPrice: 0.45 }));
  assert.equal(bet.status, 'unhedged');
  const kept = holdings(bet).outcome.quantity;
  const bought = bet.legs.find((l) => l.role === 'outcome')!.quantityFilled;
  assert.ok(kept > 1 && kept < bought, `part of it is still held (${kept} of ${bought})`);
  assert.ok(bet.payoffs!.stake > 0);
  assertStoredFiguresAreTheAccounts(exchange, bet, 1000);
});

test('an unwind that sold only part of the first leg, after the hedge was bought and sold back at a loss, still counts that loss', async () => {
  const { exchange, ledger, deps } = setup([
    { strike: 1800, bid: 0.71, ask: 0.9, bidSize: 2 }, // only 2 hedge contracts can be bought, so the bet cannot be completed
    { strike: 1820, bid: 0.11, ask: 0.3 },
  ]);
  await ensureBaseline(exchange, ledger, 'primary');
  exchange.reportedDepth.set(exchange.symbol(1800), { bidSize: 1000, askSize: 1000 });
  const real = exchange.placeOrder.bind(exchange);
  exchange.placeOrder = async (req) => {
    const res = await real(req);
    if (req.clientOrderId.endsWith('-b')) exchange.setBook(1820, { bidSize: 2 }); // and only 2 of the first leg can be sold back
    return res;
  };
  const bet = await placeConditionalBet(deps, request(exchange));
  assert.equal(bet.status, 'unhedged');
  const h = holdings(bet);
  assert.ok(h.outcome.quantity > 0, 'part of the first leg is still held');
  assert.equal(h.hedge.quantity, 0, 'the hedge was bought and sold back');
  assert.ok(h.hedge.spent > 0.01, `at a loss of ${h.hedge.spent}`);
  assertStoredFiguresAreTheAccounts(exchange, bet, 1000);
});

test('a cash-out whose second sell fills only part: the first leg is gone, and the figures still include what it cost', async () => {
  const { exchange, ledger, deps } = setup([
    { strike: 1800, bid: 0.8, ask: 0.82 },
    { strike: 1820, bid: 0.6, ask: 0.62 },
  ]);
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeConditionalBet(deps, request(exchange, { stake: 20 }));
  exchange.reportedDepth.set(bet.condition.symbol, { bidSize: 1000, askSize: 1000 });
  exchange.setBook(1800, { askSize: 3 }); // the refund leg finds a buyer for only 3 contracts
  const after = await cashOutBet(deps, bet);
  assert.equal(holdings(after).outcome.quantity, 0, 'the first leg was sold');
  assert.ok(holdings(after).hedge.quantity > 0, 'part of the refund leg is left');
  assert.notEqual(holdings(after).outcome.spent, 0, 'and the first leg left a real gain or loss behind');
  assertStoredFiguresAreTheAccounts(exchange, after, 1000);
});

test('a bet part-way through a cash-out: every stored figure is what the account nets in that state', async () => {
  const { exchange, ledger, deps } = setup([
    { strike: 1800, bid: 0.8, ask: 0.82 },
    { strike: 1820, bid: 0.6, ask: 0.62 },
  ]);
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeConditionalBet(deps, request(exchange, { stake: 20 }));
  assert.equal(bet.status, 'open');
  assertStoredFiguresAreTheAccounts(exchange, bet, 1000); // whole, to start with

  // Only part of the first sell finds a buyer: the book thins in the moment between the quote and the order.
  exchange.reportedDepth.set(bet.target.symbol, { bidSize: 1000, askSize: 1000 });
  exchange.setBook(1820, { bidSize: 5 });
  const after = await cashOutBet(deps, bet);
  assert.equal(after.cashOut?.complete, false);
  assert.ok(holdings(after).outcome.quantity > 0 && holdings(after).hedge.quantity > 0, 'still holds both legs, smaller');
  assertStoredFiguresAreTheAccounts(exchange, after, 1000);
});

test('a bet whose first half was sold back keeps the refund leg, and its figures say so', async () => {
  const { exchange, ledger, deps } = setup([
    { strike: 1800, bid: 0.8, ask: 0.82 },
    { strike: 1820, bid: 0.6, ask: 0.62 },
  ]);
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeConditionalBet(deps, request(exchange, { stake: 20 }));
  // The hedge's sell fails to fill at all: the bet is left holding only the refund leg.
  exchange.setBook(1800, { askSize: 0 });
  exchange.reportedDepth.set(bet.condition.symbol, { bid: 0.8, bidSize: 1000, ask: 0.82, askSize: 1000 });
  const after = await cashOutBet(deps, bet);
  assert.equal(holdings(after).outcome.quantity, 0);
  assert.ok(holdings(after).hedge.quantity > 0);
  assertStoredFiguresAreTheAccounts(exchange, after, 1000);
});

// ------------------------------------------------------------------ the happy path is the same numbers as before

/** A small deterministic generator, so a failure can be replayed. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function leg(role: LegRecord['role'], symbol: string, outcome: 'yes' | 'no', side: 'buy' | 'sell', quantity: number, price: number, coef: number, tag: string): LegRecord {
  return {
    clientOrderId: tag,
    role,
    symbol,
    side,
    outcome,
    limitPrice: price,
    quantityRequested: quantity,
    quantityFilled: quantity,
    avgPrice: price,
    fee: takerFee(quantity, price, coef),
    status: 'filled',
    sentAt: '2026-11-17T23:10:00.000Z',
  };
}

test('for any bet that holds both legs the stored figures are exactly what the old rule gave: nothing moves on the happy path', () => {
  const rand = seeded(20261120);
  const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
  const round2 = (x: number) => Math.round(x * 100) / 100;
  let checked = 0;
  for (let i = 0; i < 4000; i++) {
    const coef = rand() < 0.5 ? 0 : 0.07;
    const down = rand() < 0.3;
    const bet: BetRecord = {
      id: `r${i}`,
      user: 'primary',
      createdAt: '2026-11-17T23:10:00.000Z',
      eventTicker: 'E',
      eventTitle: 'E',
      expiry: null,
      product: 'parlay',
      ...(down ? { direction: 'down' as const } : {}),
      condition: { symbol: 'C', label: 'c', strike: 1 },
      target: { symbol: 'T', label: 't', strike: 2 },
      requestedStake: 10,
      quotedPrice: 0.5,
      status: 'open',
      legs: [],
      cost: 0,
    };
    const m = legMap(bet);
    const qOut = round2(between(0.5, 400));
    const qHedge = round2(between(0.5, 400));
    bet.legs.push(leg('outcome', m.outcome.symbol, m.outcome.side, 'buy', qOut, round2(between(0.02, 0.95)), coef, 'o'));
    bet.legs.push(leg('hedge', m.hedge.symbol, m.hedge.side, 'buy', qHedge, round2(between(0.02, 0.95)), coef, 'h'));
    if (rand() < 0.4) bet.legs.push(leg('cashout', m.outcome.symbol, m.outcome.side, 'sell', round2(qOut * between(0.05, 0.9)), round2(between(0.02, 0.95)), coef, 'so'));
    if (rand() < 0.4) bet.legs.push(leg('cashout', m.hedge.symbol, m.hedge.side, 'sell', round2(qHedge * between(0.05, 0.9)), round2(between(0.02, 0.95)), coef, 'sh'));

    refreshTotals(bet);
    const h = holdings(bet);
    assert.ok(h.outcome.quantity > 0 && h.hedge.quantity > 0);
    const old = payoffs(
      { quantity: h.outcome.quantity, avgPrice: h.outcome.spent / h.outcome.quantity },
      { quantity: h.hedge.quantity, avgPrice: h.hedge.spent / h.hedge.quantity },
    );
    assert.deepEqual(bet.payoffs, old, `case ${i}`);
    checked++;
  }
  assert.equal(checked, 4000);
});

test('a bet that never bought the hedge leg has the same figures as before too', () => {
  const bet: BetRecord = {
    id: 'solo',
    user: 'primary',
    createdAt: '2026-11-17T23:10:00.000Z',
    eventTicker: 'E',
    eventTitle: 'E',
    expiry: null,
    condition: { symbol: 'C', label: 'c', strike: 1 },
    target: { symbol: 'T', label: 't', strike: 2 },
    requestedStake: 10,
    quotedPrice: 0.5,
    status: 'unhedged',
    legs: [leg('outcome', 'T', 'yes', 'buy', 12.5, 0.4, 0.07, 'o')],
    cost: 0,
  };
  refreshTotals(bet);
  const h = holdings(bet);
  assert.deepEqual(bet.payoffs, payoffs({ quantity: h.outcome.quantity, avgPrice: h.outcome.spent / h.outcome.quantity }, { quantity: 0, avgPrice: 0 }));
  const empty: BetRecord = { ...bet, id: 'none', legs: [] };
  refreshTotals(empty);
  assert.deepEqual(empty.payoffs, payoffs({ quantity: 0, avgPrice: 0 }, { quantity: 0, avgPrice: 0 }));
});
