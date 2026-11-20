/**
 * The new bets over the REAL Gemini client code (signing, WebSocket session, order placement) against the local stand-in:
 * a falling parlay, a range and a breakout, each placed through `GeminiExchange`, so the orders that reach "Gemini" are checked on the
 * wire: the right contract, the right side (YES or NO), the right price, and the tags the ledger records.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { placeConditionalBet } from '../src/bets.ts';
import type { Config } from '../src/config.ts';
import { GeminiExchange } from '../src/exchange.ts';
import { Ledger } from '../src/ledger.ts';
import { placeBreakoutBet } from '../src/breakout-bet.ts';
import { placeRangeBet } from '../src/range-bet.ts';
import { FakeExchange } from './fake.ts';
import { startFakeGemini } from './fake-gemini.ts';

const KEY = 'products-test-key';
const SECRET = 'test-secret-not-a-real-one';
const creds = { user: 'primary', apiKey: KEY, apiSecret: SECRET };
const SYM_LOW = 'GEMI-WIREP-HI100';
const SYM_HIGH = 'GEMI-WIREP-HI110';

let gem: Awaited<ReturnType<typeof startFakeGemini>>;
let exchange: GeminiExchange;
const config = (): Config => ({ baseUrl: gem.baseUrl, wsUrl: gem.wsUrl }) as Config;

before(async () => {
  const fake = new FakeExchange('WIREP', [
    { strike: 100, bid: 0.8, ask: 0.82 },
    { strike: 110, bid: 0.4, ask: 0.42 },
  ]);
  gem = await startFakeGemini({
    apiKey: KEY,
    apiSecret: SECRET,
    events: [await fake.getEvent('WIREP')],
    books: new Map([
      [SYM_LOW, { bid: 0.8, bidSize: 500, ask: 0.82, askSize: 500 }],
      [SYM_HIGH, { bid: 0.4, bidSize: 500, ask: 0.42, askSize: 500 }],
    ]),
    cash: 1000,
  });
  exchange = new GeminiExchange(config(), creds);
});
after(async () => {
  exchange.close();
  await gem.close();
});

const setup = () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-wire-products-')), 'ledger.json'));
  let n = 0;
  return { ledger, deps: { exchange, ledger, newId: () => `w${++n}`, now: () => new Date('2026-11-17T23:10:00Z'), waiveMarkup: false } };
};

describe('the new bets over the real exchange client', () => {
  it('a falling parlay buys a NO on the lower strike and a YES on the higher, at the prices the mirror quoted', async () => {
    const { deps } = setup();
    const bet = await placeConditionalBet(deps, {
      user: 'primary',
      eventTicker: 'WIREP',
      conditionSymbol: SYM_HIGH,
      targetSymbol: SYM_LOW,
      direction: 'down',
      stake: 10,
      slippageTicks: 0,
    });
    assert.equal(bet.status, 'open');
    assert.equal(bet.id, 'dn-w1');
    const [first, second] = bet.legs;
    assert.deepEqual([first!.symbol, first!.outcome, first!.side], [SYM_LOW, 'no', 'buy']);
    assert.deepEqual([second!.symbol, second!.outcome, second!.side], [SYM_HIGH, 'yes', 'buy']);
    assert.ok(Math.abs(first!.avgPrice! - 0.2) < 1e-9); // a NO on the lower strike costs 1 minus its YES bid
    assert.ok(Math.abs(second!.avgPrice! - 0.42) < 1e-9); // a YES on the higher strike costs its ask

    // what reached the stand-in is what the ledger says, with the tags that identify the bet
    const received = gem.orders.filter((o) => o.clientOrderId?.startsWith('gv-dn-w1-'));
    assert.equal(received.length, 2);
    assert.deepEqual(received.map((o) => [o.symbol, o.outcome, o.side]).sort(), [
      [SYM_LOW, 'no', 'buy'],
      [SYM_HIGH, 'yes', 'buy'],
    ]);
    assert.ok(received.every((o) => /^\d{18}$/.test(o.rawId)));
  });

  it('a range buys a YES on the lower strike and a NO on the higher, the same size', async () => {
    const { deps } = setup();
    const bet = await placeRangeBet(deps, { user: 'primary', eventTicker: 'WIREP', lowSymbol: SYM_LOW, highSymbol: SYM_HIGH, stake: 14.2, slippageTicks: 0 });
    assert.equal(bet.status, 'open');
    assert.equal(bet.id, 'rg-w1');
    const [first, second] = bet.legs;
    assert.deepEqual([first!.symbol, first!.outcome, first!.side], [SYM_LOW, 'yes', 'buy']);
    assert.deepEqual([second!.symbol, second!.outcome, second!.side], [SYM_HIGH, 'no', 'buy']);
    assert.equal(first!.quantityFilled, second!.quantityFilled);
    assert.ok(Math.abs(first!.avgPrice! - 0.82) < 1e-9);
    assert.ok(Math.abs(second!.avgPrice! - 0.6) < 1e-9); // a NO on the higher strike costs 1 minus its YES bid
    const received = gem.orders.filter((o) => o.clientOrderId?.startsWith('gv-rg-w1-'));
    assert.deepEqual(received.map((o) => [o.symbol, o.outcome, o.side]).sort(), [
      [SYM_LOW, 'yes', 'buy'],
      [SYM_HIGH, 'no', 'buy'],
    ]);
  });

  it('a breakout buys a YES on the higher strike and a NO on the lower, the same size', async () => {
    const { deps } = setup();
    const bet = await placeBreakoutBet(deps, { user: 'primary', eventTicker: 'WIREP', lowSymbol: SYM_LOW, highSymbol: SYM_HIGH, stake: 12.4, slippageTicks: 0 });
    assert.equal(bet.status, 'open');
    assert.equal(bet.id, 'bo-w1');
    const [first, second] = bet.legs;
    assert.deepEqual([first!.symbol, first!.outcome, first!.side], [SYM_HIGH, 'yes', 'buy']);
    assert.deepEqual([second!.symbol, second!.outcome, second!.side], [SYM_LOW, 'no', 'buy']);
    assert.equal(first!.quantityFilled, 20);
    assert.equal(second!.quantityFilled, 20);
    assert.ok(Math.abs(first!.avgPrice! - 0.42) < 1e-9);
    assert.ok(Math.abs(second!.avgPrice! - 0.2) < 1e-9); // a NO on the lower strike costs 1 minus its YES bid
    const received = gem.orders.filter((o) => o.clientOrderId?.startsWith('gv-bo-w1-'));
    assert.deepEqual(received.map((o) => [o.symbol, o.outcome, o.side]).sort(), [
      [SYM_LOW, 'no', 'buy'],
      [SYM_HIGH, 'yes', 'buy'],
    ]);
  });
});
