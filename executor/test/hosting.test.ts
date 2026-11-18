import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApi, type ApiDeps } from '../src/api.ts';
import { isLoopback, loadConfig } from '../src/config.ts';
import { Ledger } from '../src/ledger.ts';
import { FakeExchange } from './fake.ts';

const TIGHT = [
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.4, ask: 0.41 },
];

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The real HTTP handler on a spare port, backed by the in-memory exchange, with optional hosted-demo protections. */
async function start(extra: Partial<ApiDeps> = {}) {
  const exchange = new FakeExchange('ETHTEST', TIGHT);
  const other = new FakeExchange('ETHTEST', TIGHT);
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-host-')), 'ledger.json'));
  let n = 0;
  const api = createApi({
    ledger,
    users: ['primary', 'alice'],
    exchangeFor: (user) => (user === 'primary' ? exchange : other),
    markets: { listEvents: () => exchange.listEvents(), getEvent: (t) => exchange.getEvent(t) },
    isSandbox: true,
    feeCoef: 0,
    waiveMarkup: false,
    marketsCacheMs: 0,
    now: () => new Date('2026-11-17T23:10:00Z'),
    newId: () => `h${++n}`,
    ...extra,
  });
  const server = createServer(api);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : null) as Json };
  };
  const bet = (extra: object = {}) => ({
    user: 'primary',
    event: 'ETHTEST',
    condition: exchange.symbol(1800),
    target: exchange.symbol(1820),
    stake: 10,
    slippageTicks: 0,
    ...extra,
  });
  return { exchange, other, ledger, call, bet, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('GET /reconcile: finds every order we sent and ties cash out to the cent', async () => {
  const s = await start();
  try {
    const placed = await s.call('POST', '/bets', s.bet());
    assert.equal(placed.status, 201);
    const r = await s.call('GET', '/reconcile');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.user, 'primary');
    assert.equal(r.json.ordersChecked, 2);
    assert.equal(r.json.ordersMatched, 2);
    assert.deepEqual(r.json.mismatches, []);
    assert.ok(Math.abs(r.json.cashDifference) < 0.005);
  } finally {
    await s.close();
  }
});

test('GET /reconcile: says so when the ledger and Gemini disagree', async () => {
  const s = await start();
  try {
    await s.call('POST', '/bets', s.bet());
    // Gemini quietly loses an order the ledger recorded.
    s.exchange.orders.clear();
    const r = await s.call('GET', '/reconcile');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.ordersChecked, 2);
    assert.equal(r.json.ordersMatched, 0);
    assert.equal(r.json.mismatches.length, 2);
  } finally {
    await s.close();
  }
});

test('pinned user: the browser cannot choose the account', async () => {
  const s = await start({ pinnedUser: 'primary' });
  try {
    const placed = await s.call('POST', '/bets', s.bet({ user: 'alice' }));
    assert.equal(placed.status, 201);
    assert.equal(placed.json.bet.user, 'primary');
    // Asking for alice's bets still returns only the pinned account's.
    const list = await s.call('GET', '/bets?user=alice');
    assert.equal(list.status, 200);
    assert.equal(list.json.count, 1);
    assert.equal(list.json.bets[0].user, 'primary');
    assert.equal(s.other.sent.length, 0, "alice's Gemini account was never touched");
  } finally {
    await s.close();
  }
});

test('stake cap: refuses a bigger bet before touching Gemini, allows one at the cap', async () => {
  const s = await start({ maxStake: 25 });
  try {
    const big = await s.call('POST', '/bets', s.bet({ stake: 26 }));
    assert.equal(big.status, 400);
    assert.equal(big.json.code, 'stake_too_large');
    assert.equal(s.exchange.sent.length, 0);
    const ok = await s.call('POST', '/bets', s.bet({ stake: 10 }));
    assert.equal(ok.status, 201);
  } finally {
    await s.close();
  }
});

test('kill switch: while paused, no bet is placed and the ledger stays empty', async () => {
  let paused = true;
  const s = await start({ isPaused: () => paused });
  try {
    const blocked = await s.call('POST', '/bets', s.bet());
    assert.equal(blocked.status, 503);
    assert.equal(blocked.json.code, 'paused');
    assert.equal(s.exchange.sent.length, 0);
    assert.equal(s.ledger.data.bets.length, 0);
    // Reading still works while paused.
    assert.equal((await s.call('GET', '/health')).status, 200);
    paused = false;
    assert.equal((await s.call('POST', '/bets', s.bet())).status, 201);
  } finally {
    await s.close();
  }
});

test('rate limit: bets beyond the window allowance get 429 with Retry-After; reads are not limited', async () => {
  const s = await start({ rateLimit: { max: 2, windowMs: 60_000 } });
  try {
    assert.equal((await s.call('POST', '/bets', s.bet({ stake: 2 }))).status, 201);
    assert.equal((await s.call('POST', '/bets', s.bet({ stake: 2 }))).status, 201);
    const third = await s.call('POST', '/bets', s.bet({ stake: 2 }));
    assert.equal(third.status, 429);
    assert.equal(third.json.code, 'rate_limited');
    assert.equal(third.headers.get('retry-after'), '60');
    for (let i = 0; i < 5; i++) assert.equal((await s.call('GET', '/health')).status, 200);
  } finally {
    await s.close();
  }
});

test('rate limit: with a trusted proxy, clients are told apart by X-Forwarded-For', async () => {
  const s = await start({ rateLimit: { max: 1, windowMs: 60_000 }, trustProxy: true });
  try {
    assert.equal((await s.call('POST', '/bets', s.bet({ stake: 2 }), { 'X-Forwarded-For': '203.0.113.7' })).status, 201);
    assert.equal((await s.call('POST', '/bets', s.bet({ stake: 2 }), { 'X-Forwarded-For': '203.0.113.7' })).status, 429);
    assert.equal((await s.call('POST', '/bets', s.bet({ stake: 2 }), { 'X-Forwarded-For': '198.51.100.9' })).status, 201);
  } finally {
    await s.close();
  }
});

test('config: loopback is the default, and only loopback counts as local', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('localhost'), true);
  assert.equal(isLoopback('0.0.0.0'), false);
  assert.equal(isLoopback('10.0.0.5'), false);
  const local = loadConfig({});
  assert.equal(local.host, '127.0.0.1');
  assert.equal(local.pinnedUser, null);
  assert.equal(local.maxStake, null);
  const hosted = loadConfig({ GIVEN_HOST: '0.0.0.0', GIVEN_PINNED_USER: 'demo', GIVEN_MAX_STAKE: '25', GIVEN_RATE_LIMIT_PER_MIN: '6', GIVEN_TRUST_PROXY: '1' });
  assert.equal(hosted.host, '0.0.0.0');
  assert.equal(hosted.pinnedUser, 'demo');
  assert.equal(hosted.maxStake, 25);
  assert.equal(hosted.rateLimitPerMin, 6);
  assert.equal(hosted.trustProxy, true);
});
