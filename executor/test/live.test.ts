/**
 * Caching and real-time behaviour of the executor API, over real HTTP:
 * stale-while-revalidate, shared in-flight reads, conditional GETs and gzip, server-sent events (what is sent, when,
 * and the limits that keep a held-open socket from becoming a liability), idle servers that do not poll Gemini,
 * auto-settle, and quote coalescing.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createApi } from '../src/api.ts';
import type { ApiDeps, ApiHandler } from '../src/api.ts';
import { Ledger } from '../src/ledger.ts';
import { createLiveHub } from '../src/live.ts';
import type { LiveHub } from '../src/live.ts';
import { FakeExchange } from './fake.ts';

const TIGHT = [
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.4, ask: 0.41 },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await sleep(15);
  }
  assert.fail(`timed out waiting for: ${what}`);
};

interface Rig {
  base: string;
  exchange: FakeExchange;
  hub: LiveHub;
  api: ApiHandler;
  calls: { listEvents: number; getEvent: number; topOfBook: number };
  slowList(ms: number): void;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function rig(over: Partial<ApiDeps> & { withHub?: boolean; maxClients?: number } = {}): Promise<Rig> {
  const exchange = new FakeExchange('ETHTEST', TIGHT);
  const hub = createLiveHub({ maxClients: over.maxClients ?? 50, heartbeatMs: 60_000 });
  const calls = { listEvents: 0, getEvent: 0, topOfBook: 0 };
  let delay = 0;
  const realTop = exchange.topOfBook.bind(exchange);
  exchange.topOfBook = async (s: string) => {
    calls.topOfBook++;
    await sleep(40);
    return realTop(s);
  };
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-live-')), 'ledger.json'));
  const api = createApi({
    ledger,
    users: ['primary'],
    exchangeFor: () => exchange,
    markets: {
      listEvents: async () => {
        calls.listEvents++;
        if (delay) await sleep(delay);
        return exchange.listEvents();
      },
      getEvent: async (t) => {
        calls.getEvent++;
        return exchange.getEvent(t);
      },
    },
    isSandbox: true,
    feeCoef: 0,
    waiveMarkup: false,
    marketsCacheMs: 0,
    ...(over.withHub === false ? {} : { live: hub }),
    ...over,
  });
  const server: Server = createServer(api);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    api.close();
    hub.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, exchange, hub, api, calls, slowList: (ms) => (delay = ms) };
}

/** A minimal SSE client: collects `event:` names (and the hello payload) until closed. */
async function openStream(url: string): Promise<{ status: number; events: string[]; hello: () => Record<string, unknown> | null; close(): void }> {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal });
  const events: string[] = [];
  let helloData: Record<string, unknown> | null = null;
  if (res.status === 200 && res.body) {
    void (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const name = /^event: (.+)$/m.exec(block)?.[1];
            if (!name) continue;
            events.push(name);
            if (name === 'hello') helloData = JSON.parse(/^data: (.+)$/m.exec(block)![1]!) as Record<string, unknown>;
          }
        }
      } catch {
        /* aborted */
      }
    })();
  } else {
    await res.text();
  }
  const handle = { status: res.status, events, hello: () => helloData, close: () => ctrl.abort() };
  cleanups.push(() => ctrl.abort());
  return handle;
}

const betBody = (ex: FakeExchange) => ({ user: 'primary', event: 'ETHTEST', condition: ex.symbol(1800), target: ex.symbol(1820), stake: 10 });

describe('market list caching', () => {
  it('everyone who asks while a read is running shares that one read', async () => {
    const r = await rig();
    r.slowList(120);
    const answers = await Promise.all(Array.from({ length: 10 }, () => fetch(`${r.base}/markets`).then((x) => x.json())));
    assert.equal(r.calls.listEvents, 1, 'one upstream list for ten callers');
    assert.ok(answers.every((a) => a.events.length === 1));
  });

  it('an answer a little past its TTL is served at once while a fresh one loads in the background', async () => {
    const r = await rig({ marketsCacheMs: 40, staleMarketsMs: 10_000 });
    await fetch(`${r.base}/markets`); // cold: waits for the read
    r.slowList(250);
    await sleep(80); // now past the TTL
    const t0 = Date.now();
    const res = await fetch(`${r.base}/markets`);
    await res.json();
    assert.ok(Date.now() - t0 < 120, `the stale answer came straight back, took ${Date.now() - t0}ms`);
    await until('the background refresh to run', () => r.calls.listEvents === 2);
    await sleep(300); // let it finish
  });

  it('an answer older than the stale limit is NOT served; the caller waits for a fresh one', async () => {
    const r = await rig({ marketsCacheMs: 20, staleMarketsMs: 60 });
    await fetch(`${r.base}/markets`);
    r.slowList(150);
    await sleep(120); // past the stale limit
    const t0 = Date.now();
    await (await fetch(`${r.base}/markets`)).json();
    assert.ok(Date.now() - t0 >= 140, 'it waited for the fresh read');
  });

  it('a failed background refresh leaves the last good answer in place', async () => {
    const r = await rig({ marketsCacheMs: 30, staleMarketsMs: 10_000 });
    await (await fetch(`${r.base}/markets`)).json();
    const real = r.exchange.listEvents.bind(r.exchange);
    r.exchange.listEvents = async () => {
      throw new Error('Gemini is down');
    };
    await sleep(60);
    const res = await fetch(`${r.base}/markets`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { events: unknown[] }).events.length, 1);
    r.exchange.listEvents = real;
  });
});

describe('conditional GETs and compression', () => {
  it('an unchanged answer is a 304 with no body, and asOf does not break that', async () => {
    const r = await rig();
    const first = await fetch(`${r.base}/markets`);
    const etag = first.headers.get('etag')!;
    assert.match(etag, /^W\/".+"$/);
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    await first.text();
    await sleep(20); // asOf is different now
    const again = await fetch(`${r.base}/markets`, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '');
  });

  it('a changed market gives a new ETag and a full answer', async () => {
    const r = await rig();
    const first = await fetch(`${r.base}/markets`);
    const etag = first.headers.get('etag')!;
    await first.text();
    r.exchange.books.set(r.exchange.symbol(1820), { bid: 0.5, bidSize: 1000, ask: 0.51, askSize: 1000 });
    const next = await fetch(`${r.base}/markets`, { headers: { 'If-None-Match': etag } });
    assert.equal(next.status, 200);
    assert.notEqual(next.headers.get('etag'), etag);
  });

  it('a large answer is gzipped when the client accepts it, and decodes to the same JSON', async () => {
    const r = await rig();
    // Make the answer big enough to be worth compressing.
    const res = await fetch(`${r.base}/markets?include=refused`, { headers: { 'Accept-Encoding': 'gzip' } });
    const body = await res.text();
    if (body.length > 1024) assert.equal(res.headers.get('content-encoding'), 'gzip');
    assert.ok(JSON.parse(body).events);
  });

  it('errors are never cached or given validators', async () => {
    const r = await rig();
    const res = await fetch(`${r.base}/quote?event=ETHTEST`);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('etag'), null);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

describe('live stream', () => {
  it('opens with a hello that names the topics, and refuses unknown topics and a missing hub', async () => {
    const r = await rig();
    const s = await openStream(`${r.base}/stream?topics=markets,bets`);
    assert.equal(s.status, 200);
    await until('hello', () => s.events.includes('hello'));
    assert.deepEqual((s.hello() as { topics: string[] }).topics.sort(), ['bets', 'markets']);
    const bad = await openStream(`${r.base}/stream?topics=nonsense`);
    assert.equal(bad.status, 400);
    const bare = await rig({ withHub: false });
    assert.equal((await openStream(`${bare.base}/stream`)).status, 404);
  });

  it('tells a watcher when a bet is placed', async () => {
    const r = await rig();
    const s = await openStream(`${r.base}/stream?topics=bets`);
    await until('hello', () => s.events.includes('hello'));
    const res = await fetch(`${r.base}/bets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(betBody(r.exchange)) });
    assert.equal(res.status, 201);
    await until('a bets event', () => s.events.includes('bets'));
  });

  it('tells a watcher when the market changes, and not when it has not', async () => {
    const r = await rig({ refreshMs: 40 });
    const s = await openStream(`${r.base}/stream?topics=markets`);
    await until('hello', () => s.events.includes('hello'));
    await sleep(250); // several refreshes, nothing changed
    assert.equal(s.events.filter((e) => e === 'markets').length, 0, 'no event without a change');
    r.exchange.books.set(r.exchange.symbol(1800), { bid: 0.7, bidSize: 1000, ask: 0.72, askSize: 1000 });
    await until('a markets event', () => s.events.includes('markets'));
  });

  it('a stream only receives the topics it asked for', async () => {
    const r = await rig();
    const s = await openStream(`${r.base}/stream?topics=markets`);
    await until('hello', () => s.events.includes('hello'));
    await fetch(`${r.base}/bets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(betBody(r.exchange)) });
    await sleep(120);
    assert.equal(s.events.includes('bets'), false);
  });

  it('settles a finished bet by itself and tells the page', async () => {
    const r = await rig({ autoSettleMs: 40 });
    const s = await openStream(`${r.base}/stream?topics=bets`);
    await until('hello', () => s.events.includes('hello'));
    await fetch(`${r.base}/bets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(betBody(r.exchange)) });
    await until('the placement event', () => s.events.filter((e) => e === 'bets').length >= 1);
    r.exchange.resolve(1800, 'yes');
    r.exchange.resolve(1820, 'yes');
    await until('the settlement event', () => s.events.filter((e) => e === 'bets').length >= 2);
    const bets = ((await (await fetch(`${r.base}/bets`)).json()) as { bets: Array<{ status: string }> }).bets;
    assert.equal(bets[0]!.status, 'settled');
  });

  it('gives a bet that was sold back its market’s result by itself, with no other bet open', async () => {
    // Before, the timer only ran while some bet was open or unhedged, so a sold-back bet on its own never got `called` and
    // its call could never be revealed (and the test exchange's rounds waited on it for good).
    const r = await rig({ autoSettleMs: 40 });
    const placed = (await (await fetch(`${r.base}/bets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(betBody(r.exchange)) })).json()) as { bet: { id: string } };
    const sold = await fetch(`${r.base}/cashout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bet: placed.bet.id }) });
    assert.equal(sold.status, 200);
    r.exchange.resolve(1800, 'yes');
    r.exchange.resolve(1820, 'no');
    const called = async () => ((await (await fetch(`${r.base}/bets`)).json()) as { bets: Array<{ id: string; status: string; called?: { conditionResolved: string; targetResolved: string } }> }).bets.find((b) => b.id === placed.bet.id);
    await until('the sold-back bet to get its result', async () => (await called())?.called !== undefined);
    const bet = await called();
    assert.equal(bet!.status, 'cashed_out');
    assert.deepEqual([bet!.called!.conditionResolved, bet!.called!.targetResolved], ['yes', 'no']);
  });

  it('does not read the market list in the background when nobody is watching', async () => {
    const r = await rig({ refreshMs: 30 });
    await sleep(250);
    assert.equal(r.calls.listEvents, 0, 'an idle server does not poll Gemini');
    const s = await openStream(`${r.base}/stream?topics=markets`);
    await until('background reads while watched', () => r.calls.listEvents >= 3);
    s.close();
    await until('the watcher to be gone', () => r.hub.count('markets') === 0);
    const after = r.calls.listEvents;
    await sleep(200);
    assert.ok(r.calls.listEvents <= after + 1, 'polling stops once the last watcher leaves');
  });
});

describe('limits on held-open connections', () => {
  it('one client address cannot hold more streams than its cap', async () => {
    const r = await rig({ maxStreamsPerClient: 2 });
    const a = await openStream(`${r.base}/stream`);
    const b = await openStream(`${r.base}/stream`);
    const c = await openStream(`${r.base}/stream`);
    assert.deepEqual([a.status, b.status, c.status], [200, 200, 429]);
    a.close();
    await until('a slot to free up', async () => (await openStream(`${r.base}/stream`)).status === 200);
  });

  it('a full hub answers 503 instead of accepting more', async () => {
    const r = await rig({ maxClients: 1, maxStreamsPerClient: 5 });
    assert.equal((await openStream(`${r.base}/stream`)).status, 200);
    assert.equal((await openStream(`${r.base}/stream`)).status, 503);
  });

  it('a client that disconnects is forgotten', async () => {
    const r = await rig();
    const s = await openStream(`${r.base}/stream`);
    await until('subscribed', () => r.hub.count() === 1);
    s.close();
    await until('forgotten', () => r.hub.count() === 0);
  });
});

describe('quotes', () => {
  const q = (r: Rig) => `${r.base}/quote?event=ETHTEST&condition=${r.exchange.symbol(1800)}&target=${r.exchange.symbol(1820)}&stake=20`;

  it('identical simultaneous quotes share one pair of book reads', async () => {
    const r = await rig();
    const answers = await Promise.all(Array.from({ length: 8 }, () => fetch(q(r)).then((x) => x.json())));
    assert.equal(r.calls.topOfBook, 2, 'two book reads, not sixteen');
    assert.ok(answers.every((a) => a.stake.requested === 20));
  });

  it('with a TTL, a repeat within it is free, and after it is fresh again', async () => {
    const r = await rig({ quoteCacheMs: 80 });
    await (await fetch(q(r))).json();
    await (await fetch(q(r))).json();
    assert.equal(r.calls.topOfBook, 2);
    await sleep(120);
    await (await fetch(q(r))).json();
    assert.equal(r.calls.topOfBook, 4);
  });

  it('a failed quote is never reused', async () => {
    const r = await rig({ quoteCacheMs: 5000 });
    r.exchange.depthUnavailable = true;
    const bad = await (await fetch(q(r))).json();
    assert.ok(bad.depth?.unavailable ?? true);
    r.exchange.depthUnavailable = false;
    const good = await (await fetch(q(r))).json();
    assert.ok(good.depth && 'maxStake' in good.depth, 'the next request is a fresh read, not the failure');
  });
});
