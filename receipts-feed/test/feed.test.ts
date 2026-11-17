import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { signQuickNode, verifyQuickNode } from '../src/qn.ts';
import { collectTxs, extractProgramData } from '../src/logs.ts';
import { ReceiptStore } from '../src/store.ts';
import { createFeedServer } from '../src/server.ts';

const PROGRAM = 'Rcpt111111111111111111111111111111111111111';
const OTHER = 'Othr111111111111111111111111111111111111111';
const TOKEN = 'test-security-token-0123456789abcdef';

const b64 = (s: string) => Buffer.from(s).toString('base64');

test('signature: accepts valid, rejects tampered, stale and missing', () => {
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const sig = signQuickNode(TOKEN, 'n1', ts, '{"a":1}');
  const base = { token: TOKEN, nonce: 'n1', timestamp: ts, signature: sig, payload: '{"a":1}', nowMs: now };
  assert.equal(verifyQuickNode(base), true);
  assert.equal(verifyQuickNode({ ...base, payload: '{"a":2}' }), false);
  assert.equal(verifyQuickNode({ ...base, token: 'wrong' }), false);
  assert.equal(verifyQuickNode({ ...base, nowMs: now + 301_000 }), false);
  assert.equal(verifyQuickNode({ ...base, signature: undefined }), false);
  assert.equal(verifyQuickNode({ ...base, signature: 'zz' }), false);
});

test('logs: attributes Program data to the emitting program across CPI', () => {
  const logs = [
    `Program ${OTHER} invoke [1]`,
    `Program data: ${b64('outer-before')}`,
    `Program ${PROGRAM} invoke [2]`,
    'Program log: Instruction: RecordCall',
    `Program data: ${b64('ours-1')}`,
    `Program ${PROGRAM} consumed 5000 of 200000 compute units`,
    `Program ${PROGRAM} success`,
    `Program data: ${b64('outer-after')}`,
    `Program ${OTHER} success`,
    `Program ${PROGRAM} invoke [1]`,
    `Program data: ${b64('ours-2')}`,
    `Program ${PROGRAM} success`,
  ];
  assert.deepEqual(
    extractProgramData(logs, PROGRAM).map((b) => b.toString()),
    ['ours-1', 'ours-2'],
  );
});

test('logs: finds transactions at any nesting and skips failed ones', () => {
  const tx = (signature: string, success = true) => ({ signature, slot: 5, blockTime: 9, logs: ['x'], success });
  assert.deepEqual(
    collectTxs({ data: [[tx('a'), tx('b', false)]], metadata: {} }).map((t) => t.signature),
    ['a'],
  );
  assert.deepEqual(collectTxs({ txs: [tx('c')] }).map((t) => t.signature), ['c']);
});

test('webhook: verifies, ingests, dedupes redelivery, serves the feed', async (t) => {
  const store = new ReceiptStore();
  const server = createFeedServer({
    programId: PROGRAM,
    securityToken: TOKEN,
    store,
    decode: (raw) => ({ text: raw.toString() }),
    score: (rs) => ({ count: rs.length }),
  }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const payload = JSON.stringify({
    data: [[{
      signature: 'sig1', slot: 10, blockTime: 1_800_000_000, success: true,
      logs: [`Program ${PROGRAM} invoke [1]`, `Program data: ${b64('call')}`, `Program ${PROGRAM} success`],
    }]],
  });
  const post = (body: string | Buffer, sigPayload: string, extra: Record<string, string> = {}) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return fetch(`${base}/webhooks/quicknode`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qn-nonce': 'nonce',
        'x-qn-timestamp': ts,
        'x-qn-signature': signQuickNode(TOKEN, 'nonce', ts, sigPayload),
        ...extra,
      },
      body: typeof body === 'string' ? body : new Uint8Array(body),
    });
  };

  const bad = await post(payload, payload + 'x');
  assert.equal(bad.status, 401);
  assert.equal(store.size, 0);

  const first = await post(payload, payload);
  assert.deepEqual([first.status, await first.json()], [200, { ingested: 1 }]);

  // Redelivery, gzip-compressed: signature covers the decompressed JSON.
  const again = await post(gzipSync(payload), payload, { 'content-encoding': 'gzip' });
  assert.deepEqual([again.status, await again.json()], [200, { ingested: 0 }]);

  const receipts = (await (await fetch(`${base}/receipts`)).json()) as Array<Record<string, unknown>>;
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0], {
    id: 'sig1:0', signature: 'sig1', slot: 10, blockTime: 1_800_000_000,
    data: b64('call'), decoded: { text: 'call' },
  });
  assert.deepEqual(await (await fetch(`${base}/leaderboard`)).json(), { count: 1 });
});

test('quicknode filter: keeps only successful txs invoking the program, else null', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const src = readFileSync(new URL('../quicknode/filter.js', import.meta.url), 'utf8').replaceAll('__PROGRAM_ID__', PROGRAM);
  // JSON round-trip: values built inside the vm context have foreign prototypes.
  const run = runInNewContext(`${src}; main`) as (s: unknown) => unknown;
  const main = (s: unknown) => JSON.parse(JSON.stringify(run(s))) as { txs: Array<{ signature: string }> } | null;
  const tx = (signature: string, program: string, success = true) => ({
    signature, slot: 1, blockTime: 2, success, programInvocations: [],
    logs: [`Program ${program} invoke [1]`, `Program ${program} success`],
  });
  const out = main({ data: [[tx('keep', PROGRAM), tx('other', OTHER), tx('failed', PROGRAM, false)]], metadata: {} });
  assert.deepEqual(out?.txs.map((t) => t.signature), ['keep']);
  assert.equal(main({ data: [[tx('other', OTHER)]], metadata: {} }), null);
  // The filter's output is what the webhook receives; the receiver must accept it.
  assert.deepEqual(collectTxs(out).map((t) => t.signature), ['keep']);
});
