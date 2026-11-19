import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createHandler } from '../src/http.ts';
import type { HttpDeps } from '../src/http.ts';
import { hookAuthentic, signaturesIn } from '../src/webhook.ts';
import { setup } from './helpers.ts';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function start(extra: Partial<HttpDeps> = {}, over: Parameters<typeof setup>[0] = {}) {
  const s = setup(over);
  const server = createServer(createHandler({ service: s.service, user: 'primary', hook: { token: 'hook-secret' }, adminToken: 'admin-secret', ...extra }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      // Bytes (a gzipped delivery) go out as they are; fetch accepts them, though its types here do not say so.
      body: body === undefined ? undefined : typeof body === 'string' ? body : body instanceof Uint8Array ? (body as unknown as string) : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : null) as Json };
  };
  return { ...s, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('the whole call lifecycle over HTTP, in the shapes the web app reads', async () => {
  const s = await start({}, { selfIngest: true });
  try {
    s.bets.add();
    const made = await s.call('POST', '/calls', { betId: 'b1' });
    assert.equal(made.status, 201);
    assert.deepEqual(Object.keys(made.json).sort(), ['betId', 'commitHash', 'commitSignature', 'committedAt', 'handle', 'id', 'network', 'state']);
    assert.equal(made.json.state, 'committed');

    assert.equal((await s.call('GET', '/calls')).json.calls.length, 1);
    assert.equal((await s.call('POST', `/calls/${made.json.id}/reveal`)).status, 409, 'not settled yet');
    assert.equal((await s.call('POST', `/calls/${made.json.id}/reveal`)).json.code, 'not_settled');

    s.bets.settle('b1', 'yes', 'yes');
    const rev = await s.call('POST', `/calls/${made.json.id}/reveal`);
    assert.equal(rev.status, 200);
    assert.equal(rev.json.state, 'revealed');
    assert.equal(rev.json.reveal.edge, 0.59);
    assert.equal(rev.json.reveal.conditionLabel, '$62,500 or above');

    const board = await s.call('GET', '/leaderboard');
    assert.equal(board.json.rows[0].handle, made.json.handle);
    assert.equal(board.json.rows[0].rank, 1);

    const proof = await s.call('GET', `/calls/${made.json.id}/verify`);
    assert.equal(proof.json.matches, true);
  } finally {
    await s.close();
  }
});

test('errors are plain sentences with a code', async () => {
  const s = await start();
  try {
    assert.deepEqual((await s.call('POST', '/calls', {})).json.code, 'missing_field');
    assert.equal((await s.call('POST', '/calls', 'not json')).json.code, 'invalid_json');
    assert.equal((await s.call('POST', '/calls', { betId: 'ghost' })).status, 404);
    assert.equal((await s.call('POST', '/calls/nope/reveal')).status, 404);
    assert.equal((await s.call('GET', '/nowhere')).status, 404);
    assert.equal((await s.call('DELETE', '/calls/x/reveal')).status, 405);
  } finally {
    await s.close();
  }
});

test('index-only mode accepts webhooks but cannot write calls or reveal salts', async () => {
  const s = await start({ indexOnly: true });
  try {
    s.bets.add();
    assert.equal((await s.call('GET', '/health')).json.indexOnly, true);
    assert.equal((await s.call('POST', '/calls', { betId: 'b1' })).json.code, 'chain_index_only');
    assert.equal((await s.call('POST', '/calls/existing/reveal')).json.code, 'chain_index_only');
    assert.equal((await s.call('POST', '/hooks/quicknode', [], { Authorization: 'Bearer hook-secret' })).status, 202);
    assert.equal(s.chain.txs.length, 0);
  } finally {
    await s.close();
  }
});

test('browsers from other sites are refused; the webhook is judged by its secret, not its origin', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('GET', '/calls', undefined, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await s.call('GET', '/calls', undefined, { Origin: 'http://localhost:5173' })).status, 200);
    const hook = await s.call('POST', '/hooks/quicknode', [], { Origin: 'https://evil.example', Authorization: 'Bearer hook-secret' });
    assert.equal(hook.status, 202);
  } finally {
    await s.close();
  }
});

test('webhook: a delivery without the secret is refused, with it the signatures are indexed from the chain', async () => {
  const s = await start({}, { selfIngest: false });
  try {
    s.bets.add();
    const made = await s.call('POST', '/calls', { betId: 'b1' });
    s.bets.settle('b1', 'yes', 'yes');
    const rev = await s.call('POST', `/calls/${made.json.id}/reveal`);
    assert.equal((await s.call('GET', '/leaderboard')).json.rows.length, 0, 'nothing indexed yet');

    const payload = [{ sig: made.json.commitSignature }, { sig: rev.json.reveal.signature }];
    assert.equal((await s.call('POST', '/hooks/quicknode', payload)).status, 401);
    assert.equal((await s.call('POST', '/hooks/quicknode', payload, { Authorization: 'Bearer wrong' })).status, 401);
    const ok = await s.call('POST', '/hooks/quicknode', payload, { Authorization: 'Bearer hook-secret' });
    assert.equal(ok.status, 202);
    assert.equal(ok.json.accepted, 2);
    await s.service.idle();
    const board = (await s.call('GET', '/leaderboard')).json;
    assert.equal(board.rows.length, 1);
    assert.equal(board.source, 'quicknode-stream');
    // The same delivery again changes nothing.
    await s.call('POST', '/hooks/quicknode', payload, { 'X-Given-Token': 'hook-secret' });
    await s.service.idle();
    assert.equal((await s.call('GET', '/leaderboard')).json.rows[0].calls, 1);
  } finally {
    await s.close();
  }
});

test('webhook: a gzipped delivery is inflated first, and QuickNode\'s signature is checked over the inflated JSON', async () => {
  const s = await start({ hook: { qnSecurityToken: 'qn-secret-of-at-least-32-characters' } }, { selfIngest: false });
  try {
    s.bets.add();
    const made = await s.call('POST', '/calls', { betId: 'b1' });
    const json = JSON.stringify([{ sig: made.json.commitSignature, slot: 1 }]);
    const zipped = gzipSync(json);
    const ts = String(Math.floor(Date.now() / 1000));
    const sign = (over: string | Buffer) => createHmac('sha256', 'qn-secret-of-at-least-32-characters').update('n1' + ts).update(over).digest('hex');
    const headers = (signature: string) => ({ 'Content-Encoding': 'gzip', 'X-QN-Nonce': 'n1', 'X-QN-Timestamp': ts, 'X-QN-Signature': signature });

    // Signed the way QuickNode documents it: over the uncompressed payload.
    const ok = await s.call('POST', '/hooks/quicknode', zipped, headers(sign(json)));
    assert.equal(ok.status, 202);
    assert.equal(ok.json.accepted, 1);
    // A signature over the compressed bytes is not QuickNode's, and is refused.
    assert.equal((await s.call('POST', '/hooks/quicknode', zipped, headers(sign(zipped)))).status, 401);
    // The same payload uncompressed still works.
    const plain = { 'X-QN-Nonce': 'n1', 'X-QN-Timestamp': ts, 'X-QN-Signature': sign(json) };
    assert.equal((await s.call('POST', '/hooks/quicknode', json, plain)).status, 202);
  } finally {
    await s.close();
  }
});

test('webhook: a body marked gzip that is not, or that inflates past the cap, is refused cleanly', async () => {
  const s = await start();
  try {
    const auth = { Authorization: 'Bearer hook-secret', 'Content-Encoding': 'gzip' };
    const notGzip = await s.call('POST', '/hooks/quicknode', '[{"sig":"x"}]', auth);
    assert.equal(notGzip.status, 400);
    assert.equal(notGzip.json.code, 'invalid_encoding');
    // 8 MB of zeros is a few kilobytes compressed: small enough to be read, far too large once inflated.
    const bomb = await s.call('POST', '/hooks/quicknode', gzipSync(Buffer.alloc(8 * 1024 * 1024)), auth);
    assert.equal(bomb.status, 413);
    // other routes do not inflate anything
    assert.equal((await s.call('GET', '/health')).status, 200);
  } finally {
    await s.close();
  }
});

test('webhook: a payload cannot make us believe anything the chain does not say', async () => {
  const s = await start();
  try {
    const lie = [{ sig: '2'.repeat(88), handle: 'quiet-otter-42', outcome: 1, edge: 99 }];
    assert.equal((await s.call('POST', '/hooks/quicknode', lie, { Authorization: 'Bearer hook-secret' })).status, 202);
    await s.service.idle();
    assert.deepEqual((await s.call('GET', '/leaderboard')).json.rows, []);
  } finally {
    await s.close();
  }
});

test('webhook: QuickNode-style HMAC headers are accepted when correct, rejected when wrong or stale', () => {
  const auth = { qnSecurityToken: 'qn-secret' };
  const body = JSON.stringify([{ sig: 'x' }]);
  const now = Date.now();
  const sign = (nonce: string, ts: string, b: string) => createHmac('sha256', 'qn-secret').update(nonce + ts + b).digest('hex');
  const ts = String(Math.floor(now / 1000));
  const good = { 'x-qn-nonce': 'n1', 'x-qn-timestamp': ts, 'x-qn-signature': sign('n1', ts, body) };
  assert.equal(hookAuthentic(good, body, auth, now), true);
  assert.equal(hookAuthentic({ ...good, 'x-qn-signature': sign('n1', ts, body + ' ') }, body, auth, now), false, 'body altered');
  assert.equal(hookAuthentic({ ...good, 'x-qn-nonce': 'n2' }, body, auth, now), false, 'nonce altered');
  assert.equal(hookAuthentic(good, body, auth, now + 10 * 60_000), false, 'stale: a replay');
  assert.equal(hookAuthentic({}, body, auth, now), false);
  // base64 digests and millisecond timestamps are tolerated
  const tsMs = String(now);
  const b64 = createHmac('sha256', 'qn-secret').update('n1' + tsMs + body).digest('base64');
  assert.equal(hookAuthentic({ 'x-qn-nonce': 'n1', 'x-qn-timestamp': tsMs, 'x-qn-signature': b64 }, body, auth, now), true);
});

test('webhook: with no secret configured everything is refused unless insecure mode is on, and a secret always wins', () => {
  assert.equal(hookAuthentic({}, '[]', {}), false);
  assert.equal(hookAuthentic({}, '[]', { insecure: true }), true);
  assert.equal(hookAuthentic({}, '[]', { insecure: true, token: 'x' }), false, 'insecure mode cannot override a configured secret');
  assert.equal(hookAuthentic({ authorization: 'Bearer x' }, '[]', { token: 'x' }), true);
  assert.equal(hookAuthentic({ authorization: 'Bearer xx' }, '[]', { token: 'x' }), false);
});

test('signaturesIn finds signatures in raw and filtered shapes, and caps the count', () => {
  const a = 'A'.repeat(88);
  const b = 'B'.repeat(87);
  assert.deepEqual(signaturesIn([{ sig: a }, { signature: b }]).sort(), [a, b].sort());
  assert.deepEqual(signaturesIn({ data: [[{ signature: a, logs: ['Program log: Memo'] }]] }), [a]);
  assert.deepEqual(signaturesIn({ sigs: [a, 'short', 5, null] }), [a]);
  // A Webhooks-style delivery: a whole transaction, with the signature nested and 44-character keys and hashes around it.
  const webhook = { data: [{ transaction: { signatures: [a], message: { recentBlockhash: 'B'.repeat(44), accountKeys: ['C'.repeat(44)] } }, meta: { logMessages: ['Program log: Memo (len 5): "hello"'] } }], metadata: { network: 'solana-devnet' } };
  assert.deepEqual(signaturesIn(webhook), [a]);
  assert.deepEqual(signaturesIn('not a payload'), []);
  assert.deepEqual(signaturesIn(null), []);
  const many = Array.from({ length: 500 }, (_, i) => ({ sig: `${i}`.padStart(2, '1').padEnd(88, 'C') }));
  assert.ok(signaturesIn(many).length <= 50);
});

test('webhook: an oversize body is refused', async () => {
  const s = await start();
  try {
    const big = JSON.stringify({ sigs: ['x'.repeat(300_000)] });
    assert.equal((await s.call('POST', '/hooks/quicknode', big, { Authorization: 'Bearer hook-secret' })).status, 413);
  } finally {
    await s.close();
  }
});

test('admin backfill needs its token and fills in what the Stream missed', async () => {
  const s = await start({}, { selfIngest: false });
  try {
    s.bets.add();
    const made = await s.call('POST', '/calls', { betId: 'b1' });
    s.bets.settle('b1', 'yes', 'yes');
    await s.call('POST', `/calls/${made.json.id}/reveal`);
    assert.equal((await s.call('POST', '/admin/backfill')).status, 401);
    assert.equal((await s.call('POST', '/admin/backfill', undefined, { 'X-Admin-Token': 'wrong' })).status, 401);
    const r = await s.call('POST', '/admin/backfill', undefined, { 'X-Admin-Token': 'admin-secret' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { scanned: 2, added: 1 }, 'our own commit was already known; only the reveal was new');
    assert.equal((await s.call('GET', '/leaderboard')).json.rows.length, 1, 'and it is now on the board');
  } finally {
    await s.close();
  }
});

test('the admin endpoint is closed when no admin token is configured', async () => {
  const s = await start({ adminToken: undefined });
  try {
    assert.equal((await s.call('POST', '/admin/backfill', undefined, { 'X-Admin-Token': '' })).status, 401);
  } finally {
    await s.close();
  }
});

test('rate limit: spending on-chain fees is limited per client; reads are not', async () => {
  const s = await start({ rateLimit: { max: 2, windowMs: 60_000 } });
  try {
    s.bets.add({ id: 'r1' });
    s.bets.add({ id: 'r2' });
    s.bets.add({ id: 'r3' });
    assert.equal((await s.call('POST', '/calls', { betId: 'r1' })).status, 201);
    assert.equal((await s.call('POST', '/calls', { betId: 'r2' })).status, 201);
    const third = await s.call('POST', '/calls', { betId: 'r3' });
    assert.equal(third.status, 429);
    assert.equal(third.headers.get('retry-after'), '60');
    assert.equal(s.chain.txs.length, 2, 'the third never reached Solana');
    for (let i = 0; i < 5; i++) assert.equal((await s.call('GET', '/leaderboard')).status, 200);
  } finally {
    await s.close();
  }
});

test('a revealed call has a public page: plaintext and result, never the salt or an account', async () => {
  const s = await start({}, { selfIngest: true });
  try {
    s.bets.add();
    const made = await s.call('POST', '/calls', { betId: 'b1' });
    s.bets.settle('b1', 'yes', 'yes');
    const rev = (await s.call('POST', `/calls/${made.json.id}/reveal`)).json;
    const pub = await s.call('GET', `/reveals/${rev.reveal.signature}`);
    assert.equal(pub.status, 200);
    assert.equal(pub.json.handle, made.json.handle);
    assert.equal(pub.json.condition, 'GEMI-BTC2611190100-HI62500');
    assert.equal(pub.json.outcome, 1);
    assert.equal(pub.json.edge, 0.59);
    assert.equal(pub.json.commitSignature, made.json.commitSignature);
    assert.equal(pub.json.authority, s.chain.authority);
    const text = JSON.stringify(pub.json);
    assert.ok(!text.includes(s.service.store.data.calls[0]!.salt), 'the salt is not served');
    assert.ok(!text.includes('primary'), 'no account name');
    // a commit signature, an unknown signature and a malformed one are all 404 (the commit alone reveals nothing)
    assert.equal((await s.call('GET', `/reveals/${made.json.commitSignature}`)).status, 404);
    assert.equal((await s.call('GET', `/reveals/${'3'.repeat(88)}`)).status, 404);
    assert.equal((await s.call('GET', '/reveals/short')).status, 404);
  } finally {
    await s.close();
  }
});

test('an unverified reveal is never served publicly', async () => {
  const s = await start({}, { selfIngest: false });
  try {
    s.bets.add();
    const made = await s.call('POST', '/calls', { betId: 'b1' });
    s.bets.settle('b1', 'yes', 'yes');
    const rev = (await s.call('POST', `/calls/${made.json.id}/reveal`)).json;
    // Not indexed yet (no Stream, no backfill): not public either.
    assert.equal((await s.call('GET', `/reveals/${rev.reveal.signature}`)).status, 404);
    await s.service.backfill();
    assert.equal((await s.call('GET', `/reveals/${rev.reveal.signature}`)).status, 200);
  } finally {
    await s.close();
  }
});

test('health reports the network, the authority and counts, never a key', async () => {
  const s = await start({ balance: async () => 2_500_000_000 });
  try {
    const h = (await s.call('GET', '/health')).json;
    assert.equal(h.service, 'given-chain');
    assert.equal(h.network, 'fake');
    assert.equal(h.balanceSol, 2.5);
    assert.equal(h.authority, s.chain.authority);
    assert.ok(!JSON.stringify(h).toLowerCase().includes('secret'));
  } finally {
    await s.close();
  }
});
