import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BasketRefused, placeBasket } from '../src/basket.ts';
import type { Exchange } from '../src/exchange.ts';
import { Ledger } from '../src/ledger.ts';
import { FakeExchange } from './fake.ts';

const LADDER = [
  { strike: 1780, bid: 0.88, ask: 0.9 },
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.6, ask: 0.62 },
  { strike: 1840, bid: 0.4, ask: 0.42 },
];

/**
 * Seen on the Gemini sandbox on 2026-11-20: every leg passed the check a basket makes first, and a moment later the first
 * leg's own check found nothing resting at the best price. Nothing had been bought, yet the answer was a created basket
 * with a failed leg and no bets in it.
 */
test('a basket whose first leg is turned down before any order is refused whole, not recorded as an empty basket', async () => {
  const fake = new FakeExchange('ETHTEST', LADDER);
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-basket-')), 'ledger.json'));
  // The book empties after the up-front check of both legs (two depth reads each) has passed.
  let reads = 0;
  const exchange: Exchange = {
    getEvent: (t) => fake.getEvent(t),
    placeOrder: (r) => fake.placeOrder(r),
    findOrder: (id) => fake.findOrder(id),
    cancelOrder: () => fake.cancelOrder(),
    cash: () => fake.cash(),
    allOrders: () => fake.allOrders(),
    watchBook: (s, f) => fake.watchBook(s, f),
    topOfBook: async (symbol) => {
      const book = await fake.topOfBook(symbol);
      return ++reads > 4 ? { ...book, bidSize: 0, askSize: 0 } : book;
    },
  };
  const deps = { exchange, ledger, newId: () => 't1', now: () => new Date('2026-11-17T23:10:00Z'), waiveMarkup: true };
  const legs = [
    { product: 'parlay' as const, eventTicker: 'ETHTEST', conditionSymbol: fake.symbol(1800), targetSymbol: fake.symbol(1820), stake: 5 },
    { product: 'parlay' as const, eventTicker: 'ETHTEST', conditionSymbol: fake.symbol(1780), targetSymbol: fake.symbol(1840), stake: 5 },
  ];
  await assert.rejects(
    () => placeBasket(deps, { user: 'primary', legs }),
    (err: unknown) => err instanceof BasketRefused && err.index === 0 && err.code === 'insufficient_depth',
  );
  assert.equal(fake.sent.length, 0, 'no order was sent');
  assert.equal(ledger.data.bets.length, 0, 'and nothing was recorded');
});
