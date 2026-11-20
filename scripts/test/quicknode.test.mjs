/**
 * QuickNode Streams: the Stream we ask for, the filter against the payload shape QuickNode documents, and a signed delivery
 * going through the real hosted server (edge proxy and chain webhook) the way QuickNode would send it.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addMissing, buildStreamBody, creditEstimate, destinationUrl, pointsElsewhere, filterResult, mentions, needsFreshStream, sampleDelivery, signDelivery, testFilterBody, validStreamId } from '../lib/quicknode.mjs';
import { hookAuthentic } from '../../chain/src/webhook.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const filterSource = readFileSync(resolve(ROOT, 'chain/quicknode/filter.js'), 'utf8');
const HOOK = 'h'.repeat(32);
const QN = 'q'.repeat(40);
const URL_OK = 'https://given.example.com/chain/hooks/quicknode';
const base = { webhookUrl: URL_OK, filterSource, hookToken: HOOK, securityToken: QN };

describe('the Stream we ask QuickNode for', () => {
  it('uses the configured slugs and dataset batch limit, no compression, and starts paused', () => {
    const b = buildStreamBody(base);
    assert.equal(b.network, 'solana-devnet');
    assert.equal(b.dataset, 'programs_with_logs');
    assert.equal(b.dataset_batch_size, 1, 'QuickNode reported a maximum batch size of 1 for this dataset');
    assert.equal(b.destination, 'webhook');
    assert.equal(b.destination_attributes.compression, 'none');
    assert.equal(b.status, 'paused');
    assert.equal(buildStreamBody({ ...base, active: true }).status, 'active');
    assert.equal(b.destination_attributes.headers.Authorization, `Bearer ${HOOK}`);
    assert.equal(b.destination_attributes.security_token, QN);
    assert.equal(Buffer.from(b.filter_function, 'base64').toString(), filterSource, 'the filter is sent unchanged');
  });

  it('refuses a plain-http URL, a webhook path that is not ours, weak tokens and a filter without main()', () => {
    assert.throws(() => buildStreamBody({ ...base, webhookUrl: 'http://given.example.com/chain/hooks/quicknode' }), /https/);
    assert.throws(() => buildStreamBody({ ...base, webhookUrl: 'https://given.example.com/' }), /hooks\/quicknode/);
    assert.throws(() => buildStreamBody({ ...base, securityToken: 'short' }), /32/);
    assert.throws(() => buildStreamBody({ ...base, hookToken: '' }), /GIVEN_HOOK_TOKEN/);
    assert.throws(() => buildStreamBody({ ...base, filterSource: 'const x = 1' }), /main/);
  });

  it('estimates what an always-on Stream costs', () => {
    const { blocks, credits } = creditEstimate(24);
    // Devnet measured at 4.17 slots a second on 2026-11-18, not the 2.5 a 400 ms slot would give.
    assert.equal(blocks, 360_000);
    assert.equal(credits, 10_800_000);
    assert.ok(credits > 10_000_000, 'a day of running is more than the whole free trial');
  });

  it('asks for enough retries that a restart of the service does not pause the Stream', () => {
    const d = buildStreamBody({ webhookUrl: 'https://given.example.com/chain/hooks/quicknode', filterSource: 'function main(stream) { return null; }', hookToken: 'h'.repeat(32), securityToken: 's'.repeat(32) }).destination_attributes;
    assert.ok(d.max_retry * d.retry_interval_sec >= 30, `${d.max_retry} tries ${d.retry_interval_sec}s apart`);
  });

  it('a stream id must be a full id: an empty one would address every stream on the account', () => {
    assert.equal(validStreamId('3f2a9c1e-7b4d-4e2a-9c1f-0a1b2c3d4e5f'), true);
    for (const bad of ['', ' ', '..', 'abc', '3f2a9c1e-7b4d-4e2a-9c1f-0a1b2c3d4e5f/', undefined, null, 7]) assert.equal(validStreamId(bad), false, String(bad));
  });

  it('a filter test names the network and dataset, sends the filter as base64 and the block as text', () => {
    const body = testFilterBody('function main() {}', 523513407);
    assert.deepEqual(body, { network: 'solana-devnet', dataset: 'programs_with_logs', filter_function: Buffer.from('function main() {}').toString('base64'), block: '523513407' });
    assert.throws(() => testFilterBody('x', -1));
    assert.throws(() => testFilterBody('x', 1.5));
  });

  it('a filter test answer is read whether QuickNode returns JSON text or a value, and searched for our record', () => {
    assert.deepEqual(filterResult({ logs: [], result: '[{"sig":"abc","slot":5}]' }), [{ sig: 'abc', slot: 5 }]);
    assert.deepEqual(filterResult({ logs: [], result: [{ sig: 'abc' }] }), [{ sig: 'abc' }]);
    assert.equal(filterResult({ logs: [], result: 'null' }), null);
    assert.equal(filterResult({ logs: [] }), null);
    assert.equal(mentions([{ sig: 'abc', slot: 5 }], 'abc'), true);
    assert.equal(mentions({ data: [[{ sig: 'abc' }]] }, 'abc'), true);
    assert.equal(mentions([{ sig: 'abcd' }], 'abc'), false);
    assert.equal(mentions(null, 'abc'), false);
  });

  it('recognises the free-plan refusal to resume a Stream that fell behind, and nothing else', () => {
    const msg = 'Your account is on the free plan. Please upgrade to a paid plan to backfill more than 100 blocks for solana-devnet';
    assert.equal(needsFreshStream(422, msg), true);
    assert.equal(needsFreshStream(500, msg), false);
    assert.equal(needsFreshStream(422, 'dataset batch size is greater than max'), false);
    assert.equal(needsFreshStream(200, ''), false);
  });

  it('adds only the keys that are missing and leaves existing values alone', () => {
    const r = addMissing('A=1\nGIVEN_HOOK_TOKEN=keepme\nQN_SECURITY_TOKEN=\n', { GIVEN_HOOK_TOKEN: 'new', QN_SECURITY_TOKEN: 'fresh' });
    assert.deepEqual(r.added, ['QN_SECURITY_TOKEN']);
    assert.match(r.text, /GIVEN_HOOK_TOKEN=keepme/);
    assert.match(r.text, /QN_SECURITY_TOKEN=fresh/);
    assert.doesNotMatch(r.text, /QN_SECURITY_TOKEN=\n/);
  });
});

describe('a Stream left pointing at an address that has gone', () => {
  const stream = (url) => ({ destination_attributes: url === undefined ? {} : { url } });
  it('is told apart from one that delivers here, ignoring a trailing slash', () => {
    assert.equal(pointsElsewhere(stream('https://old.example/chain/hooks/quicknode'), 'https://new.example/chain/hooks/quicknode'), true);
    assert.equal(pointsElsewhere(stream('https://new.example/chain/hooks/quicknode/'), 'https://new.example/chain/hooks/quicknode'), false);
  });
  it('is not guessed at when QuickNode does not say where it delivers', () => {
    assert.equal(destinationUrl(stream()), null);
    assert.equal(pointsElsewhere(stream(), 'https://new.example/chain/hooks/quicknode'), false);
    assert.equal(pointsElsewhere(undefined, 'https://new.example/x'), false);
  });
});

describe('the filter on the payload QuickNode documents', () => {
  const main = new Function(`${filterSource}; return main;`)();
  const SIG = 'S'.repeat(88);

  it('keeps our memo transaction from a programs_with_logs batch (data is an array of arrays) and drops the rest', () => {
    const stream = JSON.parse(sampleDelivery(SIG, 7));
    stream.data[0].push({ signature: 'T'.repeat(88), slot: 7, success: true, logs: ['Program 9H6tua7j invoke [1]', 'Program 9H6tua7j consumed 143 of 594 compute units'] });
    assert.deepEqual(main(stream), [{ sig: SIG, slot: 7 }]);
  });
});

describe('QuickNode signature headers', () => {
  it('a signature made the way QuickNode documents is accepted, and a changed body, key or age is refused', () => {
    const payload = sampleDelivery('S'.repeat(88));
    const auth = { qnSecurityToken: QN };
    const now = Date.now();
    const h = signDelivery(payload, QN);
    assert.equal(hookAuthentic(h, payload, auth, now), true);
    assert.equal(hookAuthentic(h, payload + ' ', auth, now), false);
    assert.equal(hookAuthentic(h, payload, { qnSecurityToken: 'z'.repeat(40) }, now), false);
    assert.equal(hookAuthentic(h, payload, auth, now + 10 * 60_000), false, 'a replay after the window');
  });
});

const freePort = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

describe('a delivery through the hosted server', () => {
  let proc;
  let url;
  let log = '';

  before(async () => {
    const dist = mkdtempSync(join(tmpdir(), 'given-dist-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Given</title>');
    const [port, ex, ch] = [await freePort(), await freePort(), await freePort()];
    url = `http://127.0.0.1:${port}/chain/hooks/quicknode`;
    const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', GIVEN_MODE: 'fake', GIVEN_INTERNAL_EXECUTOR_PORT: String(ex), GIVEN_INTERNAL_CHAIN_PORT: String(ch), GIVEN_WEB_DIST: dist, GIVEN_PUBLIC_URL: 'http://demo.example', GIVEN_DATA_ROOT: mkdtempSync(join(tmpdir(), 'given-data-')), GIVEN_HOOK_TOKEN: HOOK, QN_SECURITY_TOKEN: QN };
    delete env.GEMINI_API_KEY;
    delete env.GEMINI_API_SECRET;
    delete env.GIVEN_PROGRAM_ID;
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

  const send = (payload, headers) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload });

  it('accepts a QuickNode-signed delivery and a shared-token delivery, answers at once, and refuses the rest', async () => {
    const payload = sampleDelivery('S'.repeat(88));
    const signed = await send(payload, signDelivery(payload, QN));
    assert.equal(signed.status, 202);
    assert.deepEqual(await signed.json(), { accepted: 1 });
    assert.equal((await send(payload, { authorization: `Bearer ${HOOK}` })).status, 202);
    assert.equal((await send(payload, {})).status, 401, 'no credentials');
    assert.equal((await send(payload, { authorization: 'Bearer wrong' })).status, 401, 'wrong token');
    assert.equal((await send(payload + ' ', signDelivery(payload, QN))).status, 401, 'a body changed after signing');
  });
});
