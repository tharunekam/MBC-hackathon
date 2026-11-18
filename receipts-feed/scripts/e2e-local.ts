// End-to-end check on a local validator, no QuickNode account needed:
//   executor bets -> POST /calls -> given_receipts program (commit)
//   -> POST /calls/:id/reveal (the program checks the hash and the clock)
//   -> transaction logs -> QuickNode filter -> signed webhook -> leaderboard
// The only simulated pieces are the executor (an in-memory list of bets) and
// QuickNode's delivery: the script wraps the real transaction logs in the
// Programs + Logs payload shape and signs them itself.
//
// Needs `anchor build` in ../receipts-program first. Run: npm run e2e
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import type { Bet } from '../src/bets.ts';
import { CallService, CallStore, type CallView } from '../src/calls.ts';
import { Chain, DEFAULT_PROGRAM_ID } from '../src/chain.ts';
import { decodeStatsAccount } from '../src/codec.ts';
import { signQuickNode } from '../src/qn.ts';
import { buildLeaderboard, decodeReceipt, type LeaderboardResponse } from '../src/receipts.ts';
import { createFeedServer, ingest } from '../src/server.ts';
import { ReceiptStore } from '../src/store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const programSo = resolve(here, '../../receipts-program/target/deploy/given_receipts.so');
const work = resolve(here, '../.e2e');
const RPC_PORT = 18899;
const TOKEN = 'e2e-local-security-token-0123456789';

if (!existsSync(programSo)) throw new Error(`Missing ${programSo}. Run \`anchor build\` in receipts-program first.`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// The event closes 25 seconds from now: long enough to commit, short enough to wait for.
const expiry = new Date(Math.ceil(Date.now() / 1000) * 1000 + 25_000);
const bet = (id: string, user: string, fairPrice: number, status = 'open'): Bet => ({
  id, user, createdAt: new Date().toISOString(), eventTicker: 'ETH2611180000', eventTitle: 'ETH price',
  expiry: expiry.toISOString(),
  condition: { symbol: 'GEMI-ETH2611180000-HI1800', label: '$1,800 or above' },
  target: { symbol: 'GEMI-ETH2611180000-HI1820', label: '$1,820 or above' },
  status,
  legs: [
    { clientOrderId: `gv-${id}-b`, orderId: `o-${id}-b`, symbol: 'GEMI-ETH2611180000-HI1820', side: 'buy', outcome: 'yes', quantityFilled: 8, avgPrice: 0.5 },
    { clientOrderId: `gv-${id}-a`, orderId: `o-${id}-a`, symbol: 'GEMI-ETH2611180000-HI1800', side: 'buy', outcome: 'no', quantityFilled: 5, avgPrice: 0.2 },
  ],
  payoffs: { conditionalPrice: fairPrice + 0.02 },
  offer: { fairPrice },
});
const ledger: { bets: Bet[] } = {
  bets: [
    bet('aaaa0001', 'alice', 0.625), bet('aaaa0002', 'alice', 0.5), bet('aaaa0003', 'alice', 0.4),
    bet('bbbb0001', 'bob', 0.3), bet('bbbb0002', 'bob', 0.8), bet('bbbb0003', 'bob', 0.5),
    bet('cccc0001', 'carol', 0.5),
    bet('dddd0001', 'dave', 0.5, 'failed'),
  ],
};
const settle = (results: Record<string, [condition: 'yes' | 'no', target: 'yes' | 'no']>) => {
  ledger.bets = ledger.bets.map((b) => {
    const r = results[b.id];
    return r ? { ...b, status: 'settled', settlement: { conditionResolved: r[0], targetResolved: r[1] } } : b;
  });
};

const validator = spawn(
  'solana-test-validator',
  ['--reset', '--quiet', '--ledger', resolve(work, 'validator'), '--bind-address', '127.0.0.1',
    '--rpc-port', String(RPC_PORT), '--faucet-port', String(RPC_PORT + 100),
    '--bpf-program', DEFAULT_PROGRAM_ID, programSo],
  { stdio: 'ignore' },
);
let failed = false;
try {
  const connection = new Connection(`http://127.0.0.1:${RPC_PORT}`, 'confirmed');
  for (let i = 0; ; i++) {
    try {
      await connection.getLatestBlockhash();
      break;
    } catch {
      if (i > 120 || validator.exitCode !== null) throw new Error('Local validator did not start.');
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log('validator up');

  const key = Keypair.generate();
  const airdrop = await connection.requestAirdrop(key.publicKey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature: airdrop, ...(await connection.getLatestBlockhash()) });
  const chain = new Chain({ connection, programId: new PublicKey(DEFAULT_PROGRAM_ID), recorder: key });
  assert.ok(await chain.initialize(), 'first initialize sends a transaction');
  assert.equal(await chain.initialize(), null, 'second initialize is a no-op');

  const callsFile = resolve(work, 'calls.json');
  const bets = { list: async () => ledger.bets };
  const store = new ReceiptStore();
  const feed = { programId: DEFAULT_PROGRAM_ID, store, decode: decodeReceipt };
  const server = createFeedServer({
    ...feed, securityToken: TOKEN, score: (r) => buildLeaderboard(r, { minCalls: 2 }),
    calls: new CallService({ store: new CallStore(callsFile), chain, bets }),
  }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const http = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  // 1. Commit every filled bet through the API.
  const calls: Record<string, CallView> = {};
  for (const b of ledger.bets.filter((x) => x.status === 'open')) {
    const res = await http('POST', '/calls', { betId: b.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    calls[b.id] = res.body as unknown as CallView;
  }
  assert.deepEqual((await http('POST', '/calls', { betId: 'dddd0001' })).body.code, 'not_filled');
  const a1 = calls.aaaa0001!;
  // On chain there is only a hash: no bet, no handle, no symbols, no price.
  const hidden = await chain.call(a1.commitHash);
  assert.deepEqual([hidden?.state, hidden?.details.betId, hidden?.details.handle, hidden?.details.targetSymbol, hidden?.details.fairPrice], ['committed', '', '', '', 0]);
  console.log(`committed ${Object.keys(calls).length} calls`);

  // 2. No reveal before the result. First the service refuses (bet not settled), then the program does (event not closed).
  assert.deepEqual((await http('POST', `/calls/${a1.id}/reveal`)).body.code, 'not_settled');
  settle({ aaaa0001: ['yes', 'yes'] });
  const early = await http('POST', `/calls/${a1.id}/reveal`);
  assert.deepEqual([early.status, early.body.code], [409, 'not_settled'], 'the program rejects a reveal before the event closes');
  assert.equal((await chain.call(a1.commitHash))?.state, 'committed');

  // 3. Wait for the chain's own clock to pass the close, then settle and reveal.
  for (let i = 0; ; i++) {
    const t = await connection.getBlockTime(await connection.getSlot('confirmed'));
    if (t !== null && t > expiry.getTime() / 1000) break;
    if (i > 240) throw new Error('The validator clock never reached the event close.');
    await new Promise((r) => setTimeout(r, 500));
  }
  settle({
    aaaa0002: ['yes', 'yes'], aaaa0003: ['yes', 'no'],
    bbbb0001: ['yes', 'no'], bbbb0002: ['yes', 'yes'], bbbb0003: ['no', 'no'],
  });
  for (const id of ['aaaa0001', 'aaaa0002', 'aaaa0003', 'bbbb0001', 'bbbb0002']) {
    const res = await http('POST', `/calls/${calls[id]!.id}/reveal`);
    assert.deepEqual([res.status, res.body.state], [200, 'revealed'], JSON.stringify(res.body));
  }
  assert.deepEqual((await http('POST', `/calls/${calls.bbbb0003!.id}/reveal`)).body.code, 'void_call');
  assert.deepEqual((await http('POST', `/calls/${calls.cccc0001!.id}/reveal`)).body.code, 'not_settled');
  console.log('revealed 5 calls; 1 refunded call and 1 open call stay hidden');

  // 4. A restarted service (same calls file) sends nothing twice.
  const restarted = new CallService({ store: new CallStore(callsFile), chain, bets });
  assert.deepEqual(await restarted.commit('aaaa0001'), (await http('GET', `/calls/${a1.id}`)).body);
  assert.deepEqual(await restarted.sync({ autoCommit: true, autoRevealUsers: new Set(['alice', 'bob', 'carol']) }), { committed: 0, revealed: 0 });

  // 5. Deliver the real transactions the way Streams would.
  const everything = await chain.history(() => false);
  assert.equal(everything.length, 13, 'initialize + 7 commits + 5 reveals');
  const filterSrc = readFileSync(resolve(here, '../quicknode/filter.js'), 'utf8').replaceAll('__PROGRAM_ID__', DEFAULT_PROGRAM_ID);
  const filter = runInNewContext(`${filterSrc}; main`) as (s: unknown) => unknown;
  const airdropTx = await connection.getTransaction(airdrop, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const block = [
    { signature: airdrop, slot: airdropTx!.slot, blockTime: airdropTx!.blockTime, programInvocations: [], logs: airdropTx!.meta!.logMessages, success: true },
    ...everything.map((tx) => ({ ...tx, programInvocations: [], success: true })),
  ];
  const payload = JSON.stringify(filter({ data: [block], metadata: { network: 'solana-localnet', dataset: 'programs_with_logs' } }));
  assert.ok(!payload.includes(airdrop), 'the filter drops transactions that do not touch the program');
  const ts = String(Math.floor(Date.now() / 1000));
  const delivery = await fetch(`${base}/hooks/quicknode`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-qn-nonce': 'e2e', 'x-qn-timestamp': ts,
      'x-qn-signature': signQuickNode(TOKEN, 'e2e', ts, payload),
    },
    body: payload,
  });
  assert.deepEqual([delivery.status, await delivery.json()], [200, { ingested: 12 }], '7 commit events + 5 reveal events');

  // 6. The leaderboard, from the Stream.
  const board = (await http('GET', '/leaderboard')).body as unknown as LeaderboardResponse;
  const alice = calls.aaaa0001!.handle;
  const bob = calls.bbbb0001!.handle;
  assert.deepEqual(
    board.rows.map((r) => [r.rank, r.handle, r.calls, r.edge, r.hitRate]),
    [[1, alice, 3, 0.475, 2 / 3], [2, bob, 2, -0.1, 0.5]],
  );
  assert.deepEqual([board.source, board.totals], ['quicknode-stream', { committed: 7, revealed: 5, handles: 2 }]);

  // 7. The same table rebuilt from RPC alone, and from the program's own accounts.
  const fromRpc = new ReceiptStore();
  ingest({ txs: everything }, { ...feed, store: fromRpc }, 'rpc');
  const rebuilt = buildLeaderboard(fromRpc.all(), { minCalls: 2 });
  assert.deepEqual([rebuilt.rows.map(({ lastRevealedAt: _, ...r }) => r), rebuilt.source], [board.rows.map(({ lastRevealedAt: _, ...r }) => r), 'rpc']);
  const stats = async (handle: string) => {
    const s = decodeStatsAccount((await connection.getAccountInfo(chain.statsAddress(handle)))!.data);
    return [s.handle, s.calls, s.hits, Number(s.edgeSum) / 1e6];
  };
  assert.deepEqual([await stats(alice), await stats(bob)], [[alice, 3, 2, 0.475], [bob, 2, 1, -0.1]]);

  server.close();
  console.table(board.rows);
  console.log('e2e ok');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  validator.kill('SIGTERM');
  rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
