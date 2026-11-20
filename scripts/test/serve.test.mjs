/**
 * The hosted-demo server, started for real (fake mode, random ports): what the public can and cannot reach, and that a
 * bet and its Solana record work end to end through the one public port.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = 'http://demo.example';

const freePort = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

let proc;
let base;
let log = '';

before(async () => {
  const dist = mkdtempSync(join(tmpdir(), 'given-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><title>Given</title><body><div id="root"></div></body></html>');
  writeFileSync(join(dist, 'assets', 'app-abc.js'), 'x'.repeat(5000));
  const [port, ex, ch] = [await freePort(), await freePort(), await freePort()];
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', GIVEN_MODE: 'fake', GIVEN_INTERNAL_EXECUTOR_PORT: String(ex), GIVEN_INTERNAL_CHAIN_PORT: String(ch), GIVEN_WEB_DIST: dist, GIVEN_PUBLIC_URL: PUBLIC, GIVEN_RATE_LIMIT_PER_MIN: '6', GIVEN_DATA_ROOT: mkdtempSync(join(tmpdir(), 'given-data-')) };
  delete env.GEMINI_API_KEY;
  delete env.GEMINI_API_SECRET;
  delete env.GIVEN_PROGRAM_ID;
  delete env.GIVEN_EDGE_TRUST_PROXY;
  proc = spawn('node', ['scripts/serve.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const end = Date.now() + 40_000;
  while (!/Given is up/.test(log)) {
    if (proc.exitCode !== null) throw new Error(`serve exited early:\n${log}`);
    if (Date.now() > end) throw new Error(`serve did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(async () => {
  if (!proc) return;
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 4000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
});

const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('the public side', () => {
  it('serves the app, its client-side routes, and caches assets for a year', async () => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<div id="root">/);
    assert.equal(home.headers.get('cache-control'), 'no-cache');
    const deep = await fetch(`${base}/bets`);
    assert.equal(deep.status, 200);
    assert.match(deep.headers.get('content-type') ?? '', /html/);
    const asset = await fetch(`${base}/assets/app-abc.js`, { headers: { 'accept-encoding': 'gzip' } });
    assert.match(asset.headers.get('cache-control') ?? '', /immutable/);
    assert.equal((await asset.text()).length, 5000, 'decoded body is intact');
    assert.equal((await fetch(`${base}/assets/gone.js`)).status, 404);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.equal((await fetch(base, { method: 'DELETE' })).status, 405);
    assert.ok(gzipSync('x').length > 0);
  });

  it('reports health for the host', async () => {
    const h = await (await fetch(`${base}/healthz`)).json();
    assert.deepEqual({ ok: h.ok, mode: h.mode, executor: h.executor, chain: h.chain }, { ok: true, mode: 'fake', executor: true, chain: true });
  });

  it('forwards the pages the app needs', async () => {
    assert.equal((await (await fetch(`${base}/api/health`)).json()).service, 'given-executor');
    const markets = await (await fetch(`${base}/api/markets`)).json();
    assert.ok(markets.events.length > 0);
    assert.equal((await (await fetch(`${base}/chain/health`)).json()).service, 'given-chain');
    assert.equal((await fetch(`${base}/chain/leaderboard`)).status, 200);
  });

  it('does not forward dev, admin or unlisted routes, or the wrong method', async () => {
    for (const [m, p] of [
      ['POST', '/api/dev/reset'],
      ['POST', '/api/dev/churn'],
      ['POST', '/chain/admin/backfill'],
      ['POST', '/api/review'],
      ['GET', '/api/'],
      ['PUT', '/api/bets'],
      ['GET', '/chain/calls/x/reveal'],
    ]) {
      const r = await fetch(base + p, { method: m });
      assert.equal(r.status, 404, `${m} ${p}`);
      assert.equal((await r.json()).code, 'not_found');
    }
  });

  it('refuses a bet from another site and accepts the demo\'s own address', async () => {
    const evil = await post('/api/bets', {}, { origin: 'http://evil.example' });
    assert.equal(evil.status, 403);
    const own = await post('/api/bets', {}, { origin: PUBLIC });
    assert.ok([400, 422].includes(own.status), `own origin got ${own.status}`);
  });

  it('streams live updates through the proxy', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream?topics=markets,bets`, { signal: ctrl.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /event-stream/);
    const reader = res.body.getReader();
    const first = await Promise.race([reader.read(), new Promise((_, no) => setTimeout(() => no(new Error('no event within 3s')), 3000))]);
    assert.match(new TextDecoder().decode(first.value), /event: hello/);
    ctrl.abort();
  });

  it('places a bet and records its call on the chain, all through the one public port', async () => {
    const markets = await (await fetch(`${base}/api/markets`)).json();
    const ev = markets.events[0];
    const pair = ev.pairs.find((p) => p.quote.offerable);
    assert.ok(pair, 'the test ladder has an offerable pair');
    const res = await post('/api/bets', { event: ev.ticker, condition: pair.condition.symbol, target: pair.target.symbol, stake: 5 }, { origin: PUBLIC });
    assert.equal(res.status, 201, await res.clone().text());
    const { bet } = await res.json();
    assert.equal(bet.status, 'open');
    const call = await (await post('/chain/calls', { betId: bet.id }, { origin: PUBLIC })).json();
    assert.equal(call.state, 'committed');
    assert.equal((await (await fetch(`${base}/chain/calls`)).json()).calls.length, 1);
  });

  it('limits a client by its real address, whatever X-Forwarded-For claims', async () => {
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await post('/api/settle', undefined, { 'x-forwarded-for': `6.6.6.${i}` })).status);
    assert.ok(codes.includes(429), `expected a 429 among ${codes.join(',')}`);
  });

  it('stops when asked', async () => {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
    assert.notEqual(code, 'timeout');
  });
});

describe('the liquidity seeder switch (GIVEN_SEEDER=1)', () => {
  /** Starts the server with these settings and waits for it to stop on its own. It must refuse before starting anything. */
  const refusal = (extra) =>
    new Promise((done) => {
      const data = mkdtempSync(join(tmpdir(), 'given-seed-'));
      // Its own stand-in for the built app, so the test does not depend on `npm run build` having been run.
      const dist = mkdtempSync(join(tmpdir(), 'given-seed-dist-'));
      writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Given</title>');
      const env = { ...process.env, PORT: '0', HOST: '127.0.0.1', GIVEN_DATA_ROOT: data, GIVEN_WEB_DIST: dist, GIVEN_SEEDER: '1', ...extra };
      for (const k of ['GEMINI_API_KEY', 'GEMINI_API_SECRET', 'GEMINI_USER_SEEDER_KEY', 'GEMINI_USER_SEEDER_SECRET', 'GEMINI_BASE_URL']) if (!(k in extra)) delete env[k];
      const p = spawn('node', ['scripts/serve.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      const timer = setTimeout(() => p.kill('SIGKILL'), 15_000);
      p.on('exit', (code) => {
        clearTimeout(timer);
        done({ code, out });
      });
    });
  const live = { GIVEN_MODE: 'live', GEMINI_API_KEY: 'account-main', GEMINI_API_SECRET: 'main-secret', GIVEN_AUTHORITY_KEY: JSON.stringify(Array.from({ length: 64 }, (_, i) => i)) };

  it('is refused outside live mode: there is nothing to rest orders on', async () => {
    const r = await refusal({ GIVEN_MODE: 'fake' });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /only makes sense in live mode/);
  });

  it('is refused without a second account\'s keys', async () => {
    const r = await refusal(live);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /GEMINI_USER_SEEDER_KEY and GEMINI_USER_SEEDER_SECRET/);
  });

  it('is refused when the seeder would be the account that bets', async () => {
    const r = await refusal({ ...live, GEMINI_USER_SEEDER_KEY: 'account-main', GEMINI_USER_SEEDER_SECRET: 'main-secret' });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /different sandbox account/);
  });
});
