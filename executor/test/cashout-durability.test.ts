import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { holdings, placeConditionalBet, recoverBets } from '../src/bets.ts';
import { cashOutBet } from '../src/cashout.ts';
import type { Exchange } from '../src/exchange.ts';
import { Ledger } from '../src/ledger.ts';
import { ensureBaseline, reconcile } from '../src/reconcile.ts';
import { FakeExchange } from './fake.ts';

const near = (actual: number, expected: number, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);

const LADDER = [
  { strike: 1780, bid: 0.88, ask: 0.9 },
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.6, ask: 0.62 },
  { strike: 1840, bid: 0.4, ask: 0.42 },
];

async function setup() {
  const exchange = new FakeExchange('ETHTEST', LADDER);
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-cashout-d-')), 'ledger.json'));
  const deps = { exchange: exchange as Exchange, ledger, newId: () => 't1', now: () => new Date('2026-11-17T23:10:00Z'), waiveMarkup: true };
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeConditionalBet(deps, { user: 'primary', eventTicker: 'ETHTEST', conditionSymbol: exchange.symbol(1800), targetSymbol: exchange.symbol(1820), stake: 10 });
  assert.equal(bet.status, 'open'); // 12.9 YES on 1820 and 10.26 NO on 1800, for $10.05
  return { exchange, ledger, deps, bet };
}

test('a sell whose answer never arrives is looked up by its tag, so a sale that did happen is recorded', async () => {
  const { exchange, ledger, deps, bet } = await setup();
  exchange.failAfterSend = 'gv-t1-cb1'; // the outcome sell reaches the venue and fills, then the connection dies
  const done = await cashOutBet(deps, bet);
  assert.equal(done.status, 'cashed_out', 'the sale went through, and the bet says so');
  const first = done.legs.find((l) => l.clientOrderId === 'gv-t1-cb1')!;
  assert.equal(first.status, 'filled');
  assert.equal(first.quantityFilled, 12.9);
  assert.match(first.note ?? '', /found on the exchange by its tag/);
  assert.equal(exchange.sent.filter((o) => o.clientOrderId === 'gv-t1-cb1').length, 1, 'never sent twice');
  near(done.cashOut!.proceeds, 12.9 * 0.6 + 10.26 * 0.18);
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true);
});

test('a sale interrupted between its two orders is finished from the ledger: recovery fills in the order and the bet reads cashed out', async () => {
  const { exchange, ledger, deps, bet } = await setup();
  // The hedge sell reaches the venue and fills, the connection dies, and the lookup by tag fails as well.
  exchange.failAfterSend = 'gv-t1-ca1';
  const realFindOrder = exchange.findOrder.bind(exchange);
  exchange.findOrder = async () => {
    throw new Error('fetch failed');
  };
  const part = await cashOutBet(deps, bet);
  exchange.findOrder = realFindOrder;
  assert.equal(part.cashOut?.complete, false, 'as far as the ledger knows, only the outcome leg was sold');
  assert.notEqual(part.status, 'cashed_out');
  near(part.cashOut!.stake, 10.05);
  near(holdings(part).hedge.quantity, 10.26);
  assert.equal(part.legs.at(-1)!.status, 'error');

  // What a restart sees after a crash at that moment: the order recorded as sent, its result unknown.
  part.legs.at(-1)!.status = 'sent';
  ledger.save();
  const reloaded = new Ledger(ledger.path);
  assert.equal(await recoverBets({ ...deps, ledger: reloaded }), 1);
  const recovered = reloaded.bet('t1')!;
  assert.equal(recovered.status, 'cashed_out');
  assert.equal(recovered.cashOut?.complete, true);
  near(recovered.cashOut!.stake, 10.05);
  near(recovered.cashOut!.proceeds, 12.9 * 0.6 + 10.26 * 0.18);
  assert.equal(exchange.sent.filter((o) => o.clientOrderId === 'gv-t1-ca1').length, 1, 'never sent twice');
  const rec = await reconcile(exchange, reloaded, 'primary');
  assert.equal(rec.ok, true);
  near(rec.cashDifference!, 0);
});

test('a crash before the first sell was answered: if Gemini never had the order, the bet is exactly as it was', async () => {
  const { ledger, deps, bet } = await setup();
  // The record of what the bet cost is written before the order leaves. Pretend the process died right there.
  bet.cashOut = { at: '2026-11-17T23:11:00.000Z', stake: bet.cost, proceeds: 0, pnl: -bet.cost, complete: false };
  bet.legs.push({
    clientOrderId: 'gv-t1-cb1',
    role: 'cashout',
    symbol: bet.target.symbol,
    side: 'sell',
    outcome: 'yes',
    limitPrice: 0.59,
    quantityRequested: 12.9,
    quantityFilled: 0,
    avgPrice: null,
    fee: 0,
    status: 'sent',
    sentAt: '2026-11-17T23:11:00.000Z',
  });
  ledger.save();
  const reloaded = new Ledger(ledger.path);
  assert.equal(await recoverBets({ ...deps, ledger: reloaded }), 1);
  const recovered = reloaded.bet('t1')!;
  assert.equal(recovered.status, 'open');
  assert.equal(recovered.cashOut, undefined);
  assert.equal(recovered.legs.at(-1)!.status, 'unfilled');
  near(recovered.cost, 10.05);
  assert.equal(recovered.payoffs?.hedged, true);
});
