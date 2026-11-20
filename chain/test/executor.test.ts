import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ExecutorClient, ServiceError } from '../src/executor.ts';

async function serve(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof ServiceError ? e.code : `other:${String(e)}`;
  }
};

test('assertExecutor accepts the Given executor', async () => {
  const s = await serve((_req, res) => res.end(JSON.stringify({ ok: true, service: 'given-executor' })));
  try {
    assert.equal(await codeOf(new ExecutorClient(s.url).assertExecutor()), 'ok');
  } finally {
    await s.close();
  }
});

test('assertExecutor refuses another project on the same port (JSON, 404 and HTML alike)', async () => {
  for (const reply of [
    (_q: unknown, r: any) => r.end(JSON.stringify({ ok: true, service: 'near-api' })), // eslint-disable-line @typescript-eslint/no-explicit-any
    (_q: unknown, r: any) => { r.statusCode = 404; r.end(JSON.stringify({ error: 'not found' })); }, // eslint-disable-line @typescript-eslint/no-explicit-any
    (_q: unknown, r: any) => r.end('<html>hello</html>'), // eslint-disable-line @typescript-eslint/no-explicit-any
  ]) {
    const s = await serve(reply as never);
    try {
      assert.equal(await codeOf(new ExecutorClient(s.url).assertExecutor()), 'not_the_executor');
    } finally {
      await s.close();
    }
  }
});

test('assertExecutor treats nothing listening as unreachable (transient), not as the wrong server', async () => {
  assert.equal(await codeOf(new ExecutorClient('http://127.0.0.1:9').assertExecutor()), 'executor_unreachable');
});

test('getBet finds a bet by id and returns null for a missing one', async () => {
  const s = await serve((_q, r) => r.end(JSON.stringify({ bets: [{ id: 'a' }, { id: 'b' }] })));
  try {
    const c = new ExecutorClient(s.url);
    assert.equal((await c.getBet('b'))?.id, 'b');
    assert.equal(await c.getBet('zzz'), null);
  } finally {
    await s.close();
  }
});

test('getBet reports an executor outage plainly', async () => {
  const s = await serve((_q, r) => { r.statusCode = 500; r.end('boom'); });
  try {
    assert.equal(await codeOf(new ExecutorClient(s.url).getBet('a')), 'executor_error');
  } finally {
    await s.close();
  }
});
