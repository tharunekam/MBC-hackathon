/**
 * The seeder through the REAL Gemini client (signing, the WebSocket session, depth reads, good-till-cancelled orders,
 * the active-orders call, cancels) against the local stand-in that speaks Gemini's wire protocol. It shows the pieces
 * fit together; it cannot show that Gemini's sandbox treats a resting order the way the stand-in does.
 */
import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import type { Config } from '../src/config.ts';
import { GeminiExchange } from '../src/exchange.ts';
import { geminiVenue } from '../src/seeder-venue.ts';
import { Seeder, TAG_PREFIX } from '../src/seeder.ts';
import { FakeExchange } from './fake.ts';
import { startFakeGemini } from './fake-gemini.ts';

const KEY = 'account-seeder-key';
const SECRET = 'seeder-secret-not-a-real-one';
let gem: Awaited<ReturnType<typeof startFakeGemini>>;
let exchange: GeminiExchange;

before(async () => {
  // Three rungs with the sandbox's kind of book: about 19 cents wide.
  const ladder = [
    { strike: 100, bid: 0.72, ask: 0.9 },
    { strike: 110, bid: 0.4, ask: 0.6 },
    { strike: 120, bid: 0.12, ask: 0.3 },
  ];
  const fake = new FakeExchange('SEEDW', ladder);
  gem = await startFakeGemini({
    apiKey: KEY,
    apiSecret: SECRET,
    events: [await fake.getEvent('SEEDW')],
    books: new Map(ladder.map((r) => [fake.symbol(r.strike), { bid: r.bid, bidSize: 2, ask: r.ask, askSize: 2 }])),
    cash: 5000,
  });
  exchange = new GeminiExchange({ baseUrl: gem.baseUrl, wsUrl: gem.wsUrl } as Config, { user: 'seeder', apiKey: KEY, apiSecret: SECRET });
});
after(async () => {
  exchange.close();
  await gem.close();
});

it('one pass rests tight two-sided quotes through the real client, and a cancel sweep reaches every one of them', async () => {
  const seeder = new Seeder(geminiVenue(exchange), { runId: 'wire01', now: () => Date.now() - 10 * 365 * 86_400_000 });
  assert.equal(await seeder.cycle('SEEDW'), 'quoting');

  const sent = gem.orders.filter((o) => (o.clientOrderId ?? '').startsWith(`${TAG_PREFIX}wire01-`));
  assert.equal(sent.length, 6, 'a bid and an ask on each of three rungs');
  assert.ok(sent.every((o) => o.status === 'open' && o.side === 'buy' && o.timeInForce === 'GTC'), 'all resting, all buys, all good till cancelled');
  const by = (strike: number, outcome: 'yes' | 'no') => sent.find((o) => o.symbol.endsWith(`HI${strike}`) && o.outcome === outcome)!;
  // middle of 0.72/0.90 is 0.81: bid 0.79 for YES, and an ask of 0.83 placed as a NO bid at 0.17
  assert.equal(by(100, 'yes').price, '0.79');
  assert.equal(by(100, 'no').price, '0.17');
  assert.equal(by(110, 'yes').price, '0.48');
  assert.equal(by(110, 'no').price, '0.48');
  assert.equal(by(120, 'yes').price, '0.19');
  assert.equal(by(120, 'no').price, '0.77');
  assert.ok(sent.every((o) => o.quantity === '40.00'));
  assert.equal(seeder.resting().length, 6);
  assert.ok(seeder.resting().every((r) => /^\d{18}$/.test(r.orderId)), 'order ids kept exact, as text');

  const cancelled = await seeder.cancelAll();
  assert.ok(cancelled >= 6, `sent ${cancelled} cancels`);
  assert.deepEqual(seeder.resting(), []);
  assert.equal(seeder.stats.errors, 0);
});
