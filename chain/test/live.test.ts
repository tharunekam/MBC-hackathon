/**
 * Real-time and caching behaviour of the chain service over real HTTP: a page learns about a commit, a reveal or a new
 * leaderboard row without polling, an unchanged answer is a 304, and held-open streams are bounded.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { FakeChain } from '../src/chain.ts';
import { commitHash } from '../src/hash.ts';
import { createHandler } from '../src/http.ts';
import { createLiveHub } from '../src/live.ts';
import { encode } from '../src/memo.ts';
import { setup } from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return;
    await sleep(15);
  }
  assert.fail(`timed out waiting for: ${what}`);
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function rig(opts: { maxClients?: number; maxStreamsPerClient?: number; hub?: boolean } = {}) {
  const s = setup({ selfIngest: true });
  const hub = createLiveHub({ maxClients: opts.maxClients ?? 20, heartbeatMs: 60_000 });
  s.service.onChange((topic) => hub.publish(topic));
  const server = createServer(createHandler({ service: s.service, user: 'primary', hook: { token: 'hook-secret' }, ...(opts.hub === false ? {} : { live: hub }), maxStreamsPerClient: opts.maxStreamsPerClient }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(async () => {
    hub.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { ...s, hub, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function openStream(url: string) {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal });
  const events: string[] = [];
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
            const name = /^event: (.+)$/m.exec(buf.slice(0, i))?.[1];
            buf = buf.slice(i + 2);
            if (name) events.push(name);
          }
        }
      } catch {
        /* aborted */
      }
    })();
  } else await res.text();
  cleanups.push(() => ctrl.abort());
  return { status: res.status, events, close: () => ctrl.abort() };
}

const post = (url: string, body?: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('live stream', () => {
  it('tells a page when a call is committed and when it is revealed', async () => {
    const r = await rig();
    r.bets.add();
    const s = await openStream(`${r.base}/events?topics=calls`);
    await until('hello', () => s.events.includes('hello'));
    const made = (await (await post(`${r.base}/calls`, { betId: 'b1' })).json()) as { id: string };
    await until('a calls event for the commit', () => s.events.filter((e) => e === 'calls').length >= 1);
    r.bets.settle('b1', 'yes', 'yes');
    await post(`${r.base}/calls/${made.id}/reveal`);
    await until('a calls event for the reveal', () => s.events.filter((e) => e === 'calls').length >= 2);
  });

  it('tells a leaderboard watcher when a verified reveal lands, including one the Stream delivered', async () => {
    const r = await rig();
    const s = await openStream(`${r.base}/events?topics=leaderboard`);
    await until('hello', () => s.events.includes('hello'));
    // someone else's record arrives through the ingestion path (as a Stream delivery would)
    const f = { betId: 'x1', event: 'BTC2611190100', condition: 'GEMI-BTC2611190100-HI62500', target: 'GEMI-BTC2611190100-HI63500', entryPrice: 0.44, fairPrice: 0.41, at: 1763433000 };
    const salt = 'ab'.repeat(16);
    const c = r.chain.forge(encode({ g: 1, t: 'c', h: commitHash(f, salt), u: 'quiet-otter-42', at: f.at }), r.chain.authority);
    const rv = r.chain.forge(encode({ g: 1, t: 'r', c: c.signature, u: 'quiet-otter-42', b: f.betId, e: f.event, k: f.condition, x: f.target, p: f.entryPrice, f: f.fairPrice, at: f.at, s: salt, o: 1 }), r.chain.authority);
    await r.service.ingest(c.signature, 'stream');
    await sleep(60);
    assert.equal(s.events.includes('leaderboard'), false, 'a commit alone does not change the board');
    await r.service.ingest(rv.signature, 'stream');
    await until('a leaderboard event', () => s.events.includes('leaderboard'));
  });

  it('a forged or unverified reveal does not wake the leaderboard', async () => {
    const r = await rig();
    const s = await openStream(`${r.base}/events?topics=leaderboard`);
    await until('hello', () => s.events.includes('hello'));
    const f = { betId: 'x2', event: 'BTC2611190100', condition: 'GEMI-BTC2611190100-HI62500', target: 'GEMI-BTC2611190100-HI63500', entryPrice: 0.44, fairPrice: 0.41, at: 1763433000 };
    const c = r.chain.forge(encode({ g: 1, t: 'c', h: commitHash(f, 'cd'.repeat(16)), u: 'quiet-otter-42', at: f.at }), r.chain.authority);
    // a reveal whose salt does not reproduce the commit
    const bad = r.chain.forge(encode({ g: 1, t: 'r', c: c.signature, u: 'quiet-otter-42', b: f.betId, e: f.event, k: f.condition, x: f.target, p: f.entryPrice, f: f.fairPrice, at: f.at, s: 'ee'.repeat(16), o: 1 }), r.chain.authority);
    await r.service.ingest(c.signature, 'rpc');
    assert.equal(await r.service.ingest(bad.signature, 'rpc'), 'unverified');
    await sleep(80);
    assert.equal(s.events.includes('leaderboard'), false);
  });

  it('only sends the topics asked for, and refuses unknown topics or a missing hub', async () => {
    const r = await rig();
    r.bets.add();
    const lb = await openStream(`${r.base}/events?topics=leaderboard`);
    await until('hello', () => lb.events.includes('hello'));
    await post(`${r.base}/calls`, { betId: 'b1' });
    await sleep(100);
    assert.equal(lb.events.includes('calls'), false);
    assert.equal((await openStream(`${r.base}/events?topics=bogus`)).status, 400);
    const bare = await rig({ hub: false });
    assert.equal((await openStream(`${bare.base}/events`)).status, 404);
  });

  it('bounds held-open connections per client and in total, and forgets a client that leaves', async () => {
    const r = await rig({ maxStreamsPerClient: 2, maxClients: 3 });
    const a = await openStream(`${r.base}/events`);
    const b = await openStream(`${r.base}/events`);
    assert.equal((await openStream(`${r.base}/events`)).status, 429);
    a.close();
    b.close();
    await until('both gone', () => r.hub.count() === 0);

    const full = await rig({ maxStreamsPerClient: 10, maxClients: 1 });
    assert.equal((await openStream(`${full.base}/events`)).status, 200);
    assert.equal((await openStream(`${full.base}/events`)).status, 503);
  });
});

describe('conditional GETs', () => {
  it('the leaderboard and the call list are 304 when unchanged, and change when a call does', async () => {
    const r = await rig();
    r.bets.add();
    const board = await fetch(`${r.base}/leaderboard`);
    const etag = board.headers.get('etag')!;
    await board.text();
    assert.equal(board.headers.get('cache-control'), 'no-cache');
    await sleep(15);
    assert.equal((await fetch(`${r.base}/leaderboard`, { headers: { 'If-None-Match': etag } })).status, 304);

    const calls0 = await fetch(`${r.base}/calls`);
    const callsTag = calls0.headers.get('etag')!;
    await calls0.text();
    await post(`${r.base}/calls`, { betId: 'b1' });
    const calls1 = await fetch(`${r.base}/calls`, { headers: { 'If-None-Match': callsTag } });
    assert.equal(calls1.status, 200, 'a new call means a new answer');
    assert.notEqual(calls1.headers.get('etag'), callsTag);
  });

  it('errors carry no validator and are never cached', async () => {
    const r = await rig();
    const res = await fetch(`${r.base}/calls/nope/verify`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('etag'), null);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

describe('a listener that throws', () => {
  it('cannot break the commit it was told about', async () => {
    const s = setup({ selfIngest: true });
    s.service.onChange(() => {
      throw new Error('listener bug');
    });
    s.bets.add();
    const call = await s.service.commitCall('b1', 'primary');
    assert.equal(call.state, 'committed');
    assert.ok(s.chain instanceof FakeChain);
  });
});
