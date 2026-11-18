/**
 * The real executor API (over the in-memory test exchange) and the real chain service, talking over real HTTP,
 * exactly as they do in the running stack. Only Gemini and Solana are replaced by in-memory stand-ins.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApi } from '../../executor/src/api.ts';
import { Ledger } from '../../executor/src/ledger.ts';
import { FakeExchange } from '../../executor/test/fake.ts';
import { FakeChain } from '../src/chain.ts';
import { ExecutorClient } from '../src/executor.ts';
import { createHandler } from '../src/http.ts';
import { parseMemo } from '../src/memo.ts';
import { ChainService } from '../src/service.ts';
import { Store } from '../src/store.ts';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const LADDER = [
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.4, ask: 0.41 },
];

const listen = async (handler: Parameters<typeof createServer>[1]) => {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
};

async function stack() {
  const exchange = new FakeExchange('ETHTEST', LADDER);
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-e2e-')), 'ledger.json'));
  let n = 0;
  const executor = await listen(
    createApi({
      ledger,
      users: ['primary'],
      exchangeFor: () => exchange,
      markets: { listEvents: () => exchange.listEvents(), getEvent: (t) => exchange.getEvent(t) },
      isSandbox: true,
      venueName: 'Local test exchange',
      feeCoef: 0,
      waiveMarkup: false,
      marketsCacheMs: 0,
      pinnedUser: 'primary',
      newId: () => `e${++n}`,
    }),
  );
  const chain = new FakeChain();
  const client = new ExecutorClient(executor.base);
  await client.assertExecutor();
  const service = new ChainService({ chain, store: new Store(null, () => 'e2e-secret'), bets: client, selfIngest: true });
  const chainSrv = await listen(createHandler({ service, user: 'primary', hook: { token: 't' } }));
  const call = async (base: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
  };
  const ex = (m: string, p: string, b?: unknown) => call(executor.base, m, p, b);
  const ch = (m: string, p: string, b?: unknown) => call(chainSrv.base, m, p, b);
  const placeBet = async () =>
    ex('POST', '/bets', { user: 'primary', event: 'ETHTEST', condition: exchange.symbol(1800), target: exchange.symbol(1820), stake: 10, slippageTicks: 0 });
  return { exchange, chain, service, ex, ch, placeBet, close: async () => { await executor.close(); await chainSrv.close(); } };
}

test('win: place a real bet, commit it, settle, reveal, and see it on the board', async () => {
  const s = await stack();
  try {
    const placed = await s.placeBet();
    assert.equal(placed.status, 201, JSON.stringify(placed.json));
    const bet = placed.json.bet;
    assert.equal(bet.status, 'open');

    // The chain service reads the executor's real bet record.
    const call = await s.ch('POST', '/calls', { betId: bet.id });
    assert.equal(call.status, 201, JSON.stringify(call.json));
    assert.equal(call.json.state, 'committed');
    const commit = parseMemo(s.chain.txs[0]!.memo)!;
    assert.equal(commit.t, 'c');

    // Gemini settles both contracts yes; the executor records it.
    s.exchange.resolve(1800, 'yes');
    s.exchange.resolve(1820, 'yes');
    const settled = await s.ex('POST', '/settle');
    assert.equal(settled.json.settled.length, 1);
    assert.equal(settled.json.settled[0].settlement.targetResolved, 'yes');

    const revealed = await s.ch('POST', `/calls/${call.json.id}/reveal`);
    assert.equal(revealed.status, 200, JSON.stringify(revealed.json));
    assert.equal(revealed.json.state, 'revealed');
    const fair = bet.offer.fairPrice as number;
    assert.ok(fair > 0.45 && fair < 0.55, `the fair price committed is the executor's own: ${fair}`);
    assert.equal(revealed.json.reveal.fairPriceAtEntry, Math.round(fair * 1e6) / 1e6);
    assert.equal(revealed.json.reveal.edge, Math.round((1 - revealed.json.reveal.fairPriceAtEntry) * 1e4) / 1e4);

    const board = await s.ch('GET', '/leaderboard');
    assert.equal(board.json.rows.length, 1);
    assert.equal(board.json.rows[0].hitRate, 1);
    assert.equal((await s.ch('GET', `/calls/${call.json.id}/verify`)).json.matches, true);
  } finally {
    await s.close();
  }
});

test('refund: the condition fails, the stake comes back, and the call is void and never reaches the board', async () => {
  const s = await stack();
  try {
    const bet = (await s.placeBet()).json.bet;
    const call = (await s.ch('POST', '/calls', { betId: bet.id })).json;
    s.exchange.resolve(1800, 'no');
    s.exchange.resolve(1820, 'no');
    const settled = (await s.ex('POST', '/settle')).json.settled[0];
    assert.equal(settled.settlement.conditionResolved, 'no');
    assert.ok(Math.abs(settled.settlement.pnl) < 0.05, `stake came back: pnl ${settled.settlement.pnl}`);

    const r = await s.ch('POST', `/calls/${call.id}/reveal`);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'void_call');
    assert.deepEqual((await s.ch('GET', '/leaderboard')).json.rows, []);
    assert.equal((await s.ch('GET', '/calls')).json.calls[0].state, 'void');
  } finally {
    await s.close();
  }
});

test('loss: the condition holds and the target misses, which scores minus the fair price', async () => {
  const s = await stack();
  try {
    const bet = (await s.placeBet()).json.bet;
    const call = (await s.ch('POST', '/calls', { betId: bet.id })).json;
    s.exchange.resolve(1800, 'yes');
    s.exchange.resolve(1820, 'no');
    await s.ex('POST', '/settle');
    const r = await s.ch('POST', `/calls/${call.id}/reveal`);
    assert.equal(r.json.reveal.outcome, 0);
    assert.ok(r.json.reveal.edge < 0);
    assert.equal((await s.ch('GET', '/leaderboard')).json.rows[0].hitRate, 0);
  } finally {
    await s.close();
  }
});

test('a bet the executor does not know, or has not filled, cannot be recorded', async () => {
  const s = await stack();
  try {
    assert.equal((await s.ch('POST', '/calls', { betId: 'made-up' })).status, 404);
    // The hedge cannot be completed: the condition book has nothing to sell into, so the executor unwinds the bet.
    s.exchange.setBook(1800, { bid: null, bidSize: 0 });
    const refused = await s.placeBet();
    assert.notEqual(refused.status, 201);
    assert.equal(s.chain.txs.length, 0);
  } finally {
    await s.close();
  }
});

test('the executor stays the source of truth: a second commit for the same bet reuses the first', async () => {
  const s = await stack();
  try {
    const bet = (await s.placeBet()).json.bet;
    const a = (await s.ch('POST', '/calls', { betId: bet.id })).json;
    const b = (await s.ch('POST', '/calls', { betId: bet.id })).json;
    assert.equal(a.commitSignature, b.commitSignature);
    assert.equal(s.chain.txs.length, 1);
  } finally {
    await s.close();
  }
});
