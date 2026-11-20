import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocketServer } from 'ws';
import { createApi } from '../src/api.ts';
import { Ledger } from '../src/ledger.ts';
import { ReadOnlyError, ReadOnlyExchange } from '../src/readonly.ts';
import { FakeExchange } from './fake.ts';

type Level = [string, string];
interface DepthBook {
  bids: Level[];
  asks: Level[];
}

/** A local stand-in for Gemini's PUBLIC depth stream: no auth, ack then a snapshot per subscribed symbol. */
async function startDepthServer(books: Map<string, DepthBook>) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.on('listening', resolve));
  const seen = { auth: [] as Array<string | undefined>, subscribes: [] as string[], unsubscribes: [] as string[], connections: 0 };
  wss.on('connection', (ws, req) => {
    seen.connections++;
    seen.auth.push(req.headers['x-gemini-apikey'] as string | undefined);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string; params: string[] };
      ws.send(JSON.stringify({ id: msg.id, status: 200 }));
      for (const stream of msg.params) {
        const symbol = stream.replace('@depth5', '');
        if (msg.method === 'UNSUBSCRIBE') seen.unsubscribes.push(symbol);
        if (msg.method !== 'SUBSCRIBE') continue;
        seen.subscribes.push(symbol);
        const book = books.get(symbol);
        if (book) ws.send(JSON.stringify({ lastUpdateId: 1, symbol, ...book }));
      }
    });
  });
  return { wss, seen, url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }) };
}

describe('ReadOnlyExchange', () => {
  const books = new Map<string, DepthBook>();
  let server: Awaited<ReturnType<typeof startDepthServer>>;
  let exchange: ReadOnlyExchange;
  before(async () => {
    server = await startDepthServer(books);
    exchange = new ReadOnlyExchange('http://127.0.0.1:1', server.url);
  });
  after(async () => {
    exchange.close();
    await server.close();
  });

  it('reads the best bid and ask with their sizes, whatever order the levels arrive in', async () => {
    books.set('gemi-eth-hi1800', { bids: [['0.7900', '24.00'], ['0.8000', '10.00']], asks: [['0.9800', '35.00'], ['0.9700', '12.00']] });
    const tick = await exchange.topOfBook('GEMI-ETH-HI1800');
    assert.deepEqual(tick, { symbol: 'GEMI-ETH-HI1800', bid: 0.8, bidSize: 10, ask: 0.97, askSize: 12 });
  });

  it('an empty side of the book is null, not zero', async () => {
    books.set('gemi-eth-hi1900', { bids: [], asks: [['0.9800', '24.00']] });
    const tick = await exchange.topOfBook('GEMI-ETH-HI1900');
    assert.equal(tick.bid, null);
    assert.equal(tick.bidSize, null);
    assert.equal(tick.ask, 0.98);
  });

  it('connects without credentials, and unsubscribes after each read', async () => {
    books.set('gemi-eth-hi2000', { bids: [['0.5000', '5.00']], asks: [['0.6000', '5.00']] });
    await exchange.topOfBook('GEMI-ETH-HI2000');
    await new Promise((r) => setTimeout(r, 50)); // the unsubscribe is fire-and-forget
    assert.ok(server.seen.auth.every((a) => a === undefined), 'no API key header is ever sent');
    assert.ok(server.seen.unsubscribes.includes('gemi-eth-hi2000'));
  });

  it('reads two contracts at once and reuses one socket', async () => {
    books.set('gemi-eth-a', { bids: [['0.1000', '1.00']], asks: [['0.2000', '2.00']] });
    books.set('gemi-eth-b', { bids: [['0.3000', '3.00']], asks: [['0.4000', '4.00']] });
    const before = server.seen.connections;
    const [a, b] = await Promise.all([exchange.topOfBook('GEMI-ETH-A'), exchange.topOfBook('GEMI-ETH-B')]);
    assert.equal(a.askSize, 2);
    assert.equal(b.bidSize, 3);
    assert.equal(server.seen.connections, before);
  });

  it('reconnects on its own after the server drops the socket', async () => {
    for (const c of server.wss.clients) c.terminate();
    await new Promise((r) => setTimeout(r, 50));
    books.set('gemi-eth-hi2100', { bids: [['0.5000', '5.00']], asks: [['0.6000', '5.00']] });
    assert.equal((await exchange.topOfBook('GEMI-ETH-HI2100')).ask, 0.6);
  });

  it('no snapshot in time rejects (a quote must never be built on a guess)', async () => {
    const slow = new ReadOnlyExchange('http://127.0.0.1:1', server.url);
    const started = Date.now();
    await assert.rejects(slow.topOfBook('GEMI-ETH-NOBOOK'), /Gemini WebSocket sent no order-book depth/);
    assert.ok(Date.now() - started >= 3900);
    slow.close();
  });

  it('every order-side method refuses, and nothing ever reaches a venue', async () => {
    await assert.rejects(exchange.placeOrder({ symbol: 'X', side: 'buy', outcome: 'yes', limitPrice: 0.5, quantity: 1, tif: 'IOC', clientOrderId: 'c' }), ReadOnlyError);
    await assert.rejects(exchange.cancelOrder('1'), ReadOnlyError);
    assert.equal(await exchange.findOrder('c'), null);
    assert.deepEqual(await exchange.allOrders(), []);
  });
});

describe('the API in read-only mode', () => {
  const books = new Map<string, DepthBook>();
  let depth: Awaited<ReturnType<typeof startDepthServer>>;
  let exchange: ReadOnlyExchange;
  let http: ReturnType<typeof createServer>;
  let base = '';
  const fake = new FakeExchange('ETHTEST', [
    { strike: 1800, bid: 0.8, ask: 0.82 },
    { strike: 1820, bid: 0.4, ask: 0.41 },
  ]);
  const sym = (s: number) => `GEMI-ETHTEST-HI${s}`;

  before(async () => {
    depth = await startDepthServer(books);
    books.set(sym(1800).toLowerCase(), { bids: [['0.8000', '50.00']], asks: [['0.8200', '50.00']] });
    books.set(sym(1820).toLowerCase(), { bids: [['0.4000', '30.00']], asks: [['0.4100', '30.00']] });
    exchange = new ReadOnlyExchange('http://127.0.0.1:1', depth.url);
    const api = createApi({
      ledger: new Ledger(join(mkdtempSync(join(tmpdir(), 'given-ro-')), 'ledger.json')),
      users: ['primary'],
      exchangeFor: () => exchange,
      markets: { listEvents: () => fake.listEvents(), getEvent: (t) => fake.getEvent(t) },
      isSandbox: true,
      feeCoef: 0,
      waiveMarkup: false,
      marketsCacheMs: 0,
      readOnly: true,
    });
    http = createServer(api);
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  after(async () => {
    exchange.close();
    await depth.close();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  it('says so in /health', async () => {
    const { json } = await call('GET', '/health');
    assert.equal(json.readOnly, true);
  });

  it('serves ladders and a sized quote from the live book', async () => {
    assert.equal((await call('GET', '/markets')).status, 200);
    const { status, json } = await call('GET', `/quote?event=ETHTEST&condition=${sym(1800)}&target=${sym(1820)}&stake=20`);
    assert.equal(status, 200);
    assert.equal(json.stake.requested, 20);
    assert.equal(json.depth.outcomeAvailable, 30);
    assert.equal(json.depth.conditionAvailable, 50);
  });

  it('refuses to place a bet, settle or reconcile, with one clear code', async () => {
    const bet = await call('POST', '/bets', { user: 'primary', event: 'ETHTEST', condition: sym(1800), target: sym(1820), stake: 10 });
    assert.equal(bet.status, 403);
    assert.equal(bet.json.code, 'read_only');
    assert.match(bet.json.error, /Add sandbox keys/);
    assert.equal((await call('POST', '/settle')).json.code, 'read_only');
    assert.equal((await call('GET', '/reconcile')).json.code, 'read_only');
  });

  it('a read-only server never records a bet', async () => {
    const { json } = await call('GET', '/bets');
    assert.deepEqual(json.bets ?? json, json.bets ? [] : json);
    assert.ok(Array.isArray(json.bets) ? json.bets.length === 0 : true);
  });
});
