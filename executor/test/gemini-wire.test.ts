/**
 * The REAL Gemini client code (signing, WebSocket session, order placement, history paging) against a local stand-in
 * that enforces Gemini's auth rules. These are the failures a first run with real keys can hit.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.ts';
import { GeminiExchange } from '../src/exchange.ts';
import { GeminiApiError, GeminiPublic, GeminiRest } from '../src/gemini/rest.ts';
import { GeminiWs } from '../src/gemini/ws.ts';
import { FakeExchange } from './fake.ts';
import { startFakeGemini } from './fake-gemini.ts';

const KEY = 'account-test-key';
const SECRET = 'test-secret-not-a-real-one';
const creds = { user: 'primary', apiKey: KEY, apiSecret: SECRET };
const SYM_A = 'GEMI-WIRE-HI100';
const SYM_B = 'GEMI-WIRE-HI110';

let gem: Awaited<ReturnType<typeof startFakeGemini>>;
let exchange: GeminiExchange;
const config = (): Config => ({ baseUrl: gem.baseUrl, wsUrl: gem.wsUrl }) as Config;

before(async () => {
  const fake = new FakeExchange('WIRE', [
    { strike: 100, bid: 0.8, ask: 0.82 },
    { strike: 110, bid: 0.4, ask: 0.41 },
  ]);
  const events = [await fake.getEvent('WIRE')];
  gem = await startFakeGemini({
    apiKey: KEY,
    apiSecret: SECRET,
    events,
    books: new Map([
      [SYM_A, { bid: 0.8, bidSize: 100, ask: 0.82, askSize: 100 }],
      [SYM_B, { bid: 0.4, bidSize: 100, ask: 0.41, askSize: 5 }],
    ]),
    cash: 1234.5,
  });
  exchange = new GeminiExchange(config(), creds);
});
after(async () => {
  exchange.close();
  await gem.close();
});

describe('public data', () => {
  it('lists and fetches events with no key', async () => {
    const pub = new GeminiPublic(gem.baseUrl);
    assert.equal((await pub.listEvents()).length, 1);
    assert.equal((await pub.getEvent('WIRE')).ticker, 'WIRE');
    await assert.rejects(pub.getEvent('NOPE'), (e: GeminiApiError) => e.status === 404);
  });
});

describe('signed REST', () => {
  it('a correct key reads the balance and the terms status', async () => {
    const rest = new GeminiRest(creds, gem.baseUrl, 0);
    assert.equal(await rest.usdBalance(), 1234.5);
    assert.equal(await rest.termsAccepted(), true);
  });

  it('a wrong secret is refused as InvalidSignature', async () => {
    const rest = new GeminiRest({ ...creds, apiSecret: 'wrong' }, gem.baseUrl, 0);
    await assert.rejects(rest.usdBalance(), (e: GeminiApiError) => e.status === 400 && /InvalidSignature/.test(e.body));
  });

  it('a wrong key is refused', async () => {
    const rest = new GeminiRest({ ...creds, apiKey: 'nope' }, gem.baseUrl, 0);
    await assert.rejects(rest.usdBalance(), (e: GeminiApiError) => /InvalidApiKey/.test(e.body));
  });

  it('a clock more than 30 seconds off is refused as InvalidNonce', async () => {
    gem.state.nowOffsetSec = 120;
    try {
      await assert.rejects(new GeminiRest(creds, gem.baseUrl, 0).usdBalance(), (e: GeminiApiError) => /InvalidNonce/.test(e.body));
    } finally {
      gem.state.nowOffsetSec = 0;
    }
  });
});

describe('the WebSocket session', () => {
  it('a bad key is refused at the upgrade with HTTP 401', async () => {
    const ws = new GeminiWs({ ...creds, apiSecret: 'wrong' }, gem.wsUrl);
    await assert.rejects(ws.connect(), /refused the connection: HTTP 401/);
    ws.close();
  });

  it('a good key connects and waits for the orders@account acknowledgement', async () => {
    const ws = new GeminiWs(creds, gem.wsUrl);
    await ws.connect();
    assert.ok(ws.isOpen);
    ws.close();
  });
});

describe('placing orders over the real exchange client', () => {
  it('a full IOC fill returns the exact order id (all 18 digits), the fill and the average price', async () => {
    const r = await exchange.placeOrder({ symbol: SYM_A, side: 'buy', outcome: 'yes', limitPrice: 0.82, quantity: 10, tif: 'IOC', clientOrderId: 'wire-full-1' });
    assert.equal(r.filledQuantity, 10);
    assert.equal(r.avgPrice, 0.82);
    assert.equal(r.open, false);
    const sent = gem.orders.find((o) => o.clientOrderId === 'wire-full-1')!;
    assert.equal(r.orderId, sent.rawId, 'no rounding of the 18-digit id');
    assert.match(r.orderId, /^\d{18}$/);
  });

  it('a NO leg is priced in NO space and fills against the YES bid', async () => {
    const r = await exchange.placeOrder({ symbol: SYM_A, side: 'buy', outcome: 'no', limitPrice: 0.2, quantity: 10, tif: 'IOC', clientOrderId: 'wire-no-1' });
    assert.equal(r.filledQuantity, 10);
    assert.ok(Math.abs((r.avgPrice ?? 0) - 0.2) < 1e-9);
  });

  it('a thin book fills only what is there; the rest of an IOC is cancelled', async () => {
    const r = await exchange.placeOrder({ symbol: SYM_B, side: 'buy', outcome: 'yes', limitPrice: 0.41, quantity: 8, tif: 'IOC', clientOrderId: 'wire-part-1' });
    assert.equal(r.filledQuantity, 5);
    assert.equal(r.open, false);
  });

  it('a price the book will not meet fills nothing', async () => {
    const r = await exchange.placeOrder({ symbol: SYM_B, side: 'buy', outcome: 'yes', limitPrice: 0.3, quantity: 2, tif: 'IOC', clientOrderId: 'wire-none-1' });
    assert.equal(r.filledQuantity, 0);
    assert.equal(r.avgPrice, null);
  });

  it('a rejected order surfaces Gemini’s reason', async () => {
    gem.state.rejectNext = 'market is closed';
    await assert.rejects(exchange.placeOrder({ symbol: SYM_A, side: 'buy', outcome: 'yes', limitPrice: 0.82, quantity: 1, tif: 'IOC', clientOrderId: 'wire-rej-1' }), /Gemini rejected the request.*market is closed/);
    assert.equal(await exchange.findOrder('wire-rej-1'), null, 'a rejected order leaves no record to find');
  });

  it('if the socket drops after the order is accepted, the fill is recovered from the venue’s own record', async () => {
    gem.state.dropAfterPlace = true;
    const started = Date.now();
    // No terminal event can arrive on a dead socket, so the client waits out its 8s window and then reads the order
    // back over REST by its tag. It must come back correct, never as a failure and never as a second order.
    const r = await exchange.placeOrder({ symbol: SYM_A, side: 'buy', outcome: 'yes', limitPrice: 0.82, quantity: 3, tif: 'IOC', clientOrderId: 'wire-drop-1' });
    assert.equal(r.filledQuantity, 3);
    assert.equal(gem.orders.filter((o) => o.clientOrderId === 'wire-drop-1').length, 1, 'exactly one order');
    assert.ok(Date.now() - started >= 7500, 'known cost: a dropped socket stalls the bet for the 8s terminal-event window');
    // and the session heals itself for the next order
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const next = await exchange.placeOrder({ symbol: SYM_A, side: 'buy', outcome: 'yes', limitPrice: 0.82, quantity: 1, tif: 'IOC', clientOrderId: 'wire-after-drop' });
    assert.equal(next.filledQuantity, 1);
  });

  it('reads the live book with sizes over the signed session', async () => {
    const t = await exchange.topOfBook(SYM_B);
    assert.deepEqual({ bid: t.bid, ask: t.ask, askSize: t.askSize }, { bid: 0.4, ask: 0.41, askSize: 5 });
  });

  it('cash and the full order list come from the venue, and paging reaches the end of a long history', async () => {
    assert.equal(await exchange.cash(), 1234.5);
    gem.seedHistory(130);
    const all = await exchange.allOrders();
    assert.ok(all.length >= 130 + 6, `expected every order, got ${all.length}`);
    assert.ok(all.some((o) => o.clientOrderId === 'old-0'), 'the oldest order is reached');
    assert.ok(new Set(all.map((o) => o.orderId)).size === all.length, 'every id is distinct (no rounding collisions)');
  });
});

describe('preflight against the stand-in', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const preflight = (env: Record<string, string>) =>
    new Promise<string>((done) => {
      const child = spawn(process.execPath, [resolve(root, 'scripts/preflight.mjs')], {
        env: { ...process.env, GEMINI_BASE_URL: gem.baseUrl, GEMINI_WS_URL: gem.wsUrl, GIVEN_ALLOW_PRODUCTION: '1', SOLANA_RPC_URL: 'http://127.0.0.1:1', ...env },
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', () => done(out));
    });

  it('good keys pass every Gemini check, and no secret is printed', async () => {
    const out = await preflight({ GEMINI_API_KEY: KEY, GEMINI_API_SECRET: SECRET });
    for (const name of ['Keys accepted', 'Prediction-market terms accepted', 'Order session opens']) assert.match(out, new RegExp(`\\[  ok  \\] ${name}`));
    assert.doesNotMatch(out, new RegExp(SECRET));
    assert.doesNotMatch(out, new RegExp(KEY));
  });

  it('a wrong secret fails with a fix a person can act on', async () => {
    const out = await preflight({ GEMINI_API_KEY: KEY, GEMINI_API_SECRET: 'wrong-secret' });
    assert.match(out, /\[ FAIL \] Keys accepted/);
    assert.match(out, /secret|signature/i);
  });

  it('a skewed clock is diagnosed as a nonce problem', async () => {
    gem.state.nowOffsetSec = 300;
    try {
      const out = await preflight({ GEMINI_API_KEY: KEY, GEMINI_API_SECRET: SECRET });
      assert.match(out, /nonce|clock|time-based/i);
    } finally {
      gem.state.nowOffsetSec = 0;
    }
  });
});
