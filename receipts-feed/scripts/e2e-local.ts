// End-to-end check on a local validator, no QuickNode account needed:
//   executor ledger -> recorder -> given_receipts program -> transaction logs
//   -> QuickNode filter -> signed webhook -> feed -> leaderboard
// The only simulated piece is QuickNode's delivery: the script wraps the real
// transaction logs in the Programs + Logs payload shape and signs them itself.
//
// Needs `anchor build` in ../receipts-program first. Run: npm run e2e
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { signQuickNode } from '../src/qn.ts';
import { DEFAULT_PROGRAM_ID, Recorder, readLedgerBets } from '../src/recorder.ts';
import { decodeReceipt, scoreLeaderboard, type Board } from '../src/receipts.ts';
import { createFeedServer } from '../src/server.ts';
import { ReceiptStore } from '../src/store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const programSo = resolve(here, '../../receipts-program/target/deploy/given_receipts.so');
const work = resolve(here, '../.e2e');
const RPC_PORT = 18899;
const TOKEN = 'e2e-local-security-token-0123456789';

if (!existsSync(programSo)) throw new Error(`Missing ${programSo}. Run \`anchor build\` in receipts-program first.`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const leg = (tag: string, symbol: string, outcome: 'yes' | 'no', qty: number, price: number) => ({
  clientOrderId: tag, orderId: `o-${tag}`, role: outcome === 'yes' ? 'outcome' : 'hedge', symbol, side: 'buy', outcome,
  limitPrice: price, quantityRequested: qty, quantityFilled: qty, avgPrice: price, status: 'filled',
  sentAt: '2026-11-17T22:00:00.000Z',
});
const bet = (id: string, user: string, status: string, settlement?: object) => ({
  id, user, createdAt: '2026-11-17T22:00:00.000Z', eventTicker: 'ETH2611180000', eventTitle: 'ETH price',
  expiry: '2026-11-18T00:00:00.000Z',
  condition: { symbol: 'GEMI-ETH2611180000-HI1800', label: '$1,800 or above', strike: 1800 },
  target: { symbol: 'GEMI-ETH2611180000-HI1820', label: '$1,820 or above', strike: 1820 },
  requestedStake: 5, quotedPrice: 0.625, status,
  legs: [
    leg(`gv-${id}-b`, 'GEMI-ETH2611180000-HI1820', 'yes', 8, 0.5),
    leg(`gv-${id}-a`, 'GEMI-ETH2611180000-HI1800', 'no', 5, 0.2),
  ],
  cost: 5,
  payoffs: { stake: 5, ifConditionFails: 0, ifBothHit: 3, ifConditionOnly: -5, conditionalPrice: 0.625, hedged: true },
  settlement,
});
const settled = (c: 'yes' | 'no', t: 'yes' | 'no', payout: number) => ({
  conditionResolved: c, targetResolved: t, payout, pnl: payout - 5, settledAt: '2026-11-18T00:00:05.000Z',
});
const ledgerPath = resolve(work, 'ledger.json');
const writeLedger = (bets: object[]) => writeFileSync(ledgerPath, JSON.stringify({ version: 1, baselines: {}, bets, intents: [] }));

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

  const alice = Keypair.generate().publicKey.toBase58();
  const logLines: string[] = [];
  const recorder = new Recorder({
    connection, programId: new PublicKey(DEFAULT_PROGRAM_ID), recorder: key, wallets: { alice }, log: (l) => logLines.push(l),
  });
  assert.ok(await recorder.initialize(), 'first initialize sends a transaction');
  assert.equal(await recorder.initialize(), null, 'second initialize is a no-op');

  // Pass 1: three placed calls (one still being placed is skipped).
  writeLedger([bet('aaaa0001', 'alice', 'open'), bet('bbbb0001', 'primary', 'open'), bet('aaaa0002', 'alice', 'open'), bet('cccc0001', 'primary', 'failed')]);
  const first = await recorder.sync(readLedgerBets(ledgerPath));
  assert.deepEqual([first.recorded.length, first.settled.length], [3, 0]);
  assert.deepEqual(first.skipped, [{ betId: 'cccc0001', reason: 'status is failed' }]);

  // Pass 2: Gemini resolved them. alice hit one and was refunded one; primary missed.
  writeLedger([
    bet('aaaa0001', 'alice', 'settled', settled('yes', 'yes', 8)),
    bet('bbbb0001', 'primary', 'settled', settled('yes', 'no', 0)),
    bet('aaaa0002', 'alice', 'settled', settled('no', 'no', 5)),
    bet('dddd0001', 'primary', 'open'),
  ]);
  const second = await recorder.sync(readLedgerBets(ledgerPath));
  assert.deepEqual([second.recorded.length, second.settled.length], [1, 3]);

  // Pass 3 with a fresh recorder (as after a restart): nothing is sent twice.
  const restarted = new Recorder({ connection, programId: new PublicKey(DEFAULT_PROGRAM_ID), recorder: key, wallets: { alice } });
  const third = await restarted.sync(readLedgerBets(ledgerPath));
  assert.deepEqual([third.recorded.length, third.settled.length], [0, 0]);
  console.log(`recorder: ${first.recorded.length + second.recorded.length} recorded, ${second.settled.length} settled, restart sent 0`);

  // Deliver the real transactions the way Streams would.
  const store = new ReceiptStore();
  const server = createFeedServer({
    programId: DEFAULT_PROGRAM_ID, securityToken: TOKEN, store, decode: decodeReceipt, score: scoreLeaderboard,
  }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const filterSrc = readFileSync(resolve(here, '../quicknode/filter.js'), 'utf8').replaceAll('__PROGRAM_ID__', DEFAULT_PROGRAM_ID);
  const filter = runInNewContext(`${filterSrc}; main`) as (s: unknown) => unknown;

  const signatures = [airdrop, ...first.recorded, ...second.recorded, ...second.settled].map((s) => (typeof s === 'string' ? s : s.signature));
  const block: object[] = [];
  for (const signature of signatures) {
    const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    assert.ok(tx?.meta?.logMessages, `logs for ${signature}`);
    block.push({ signature, slot: tx.slot, blockTime: tx.blockTime, programInvocations: [], logs: tx.meta.logMessages, success: tx.meta.err === null });
  }
  const filtered = filter({ data: [block], metadata: { network: 'solana-localnet', dataset: 'programs_with_logs' } });
  const payload = JSON.stringify(filtered);
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${base}/webhooks/quicknode`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-qn-nonce': 'e2e', 'x-qn-timestamp': ts,
      'x-qn-signature': signQuickNode(TOKEN, 'e2e', ts, payload),
    },
    body: payload,
  });
  assert.deepEqual([res.status, await res.json()], [200, { ingested: 7 }], 'the airdrop is filtered out; 4 records + 3 settles arrive');

  const board = (await (await fetch(`${base}/leaderboard`)).json()) as Board;
  server.close();
  const me = key.publicKey.toBase58();
  assert.deepEqual(
    board.leaderboard.map((r) => [r.rank, r.handle, r.caller, r.calls, r.open, r.hits, r.misses, r.refunds, r.staked, r.pnl, r.roi, r.hitRate]),
    [
      [1, 'alice', alice, 2, 0, 1, 0, 1, 10, 3, 0.3, 1],
      [2, 'primary', me, 2, 1, 0, 1, 0, 10, -5, -1, 0],
    ],
  );
  assert.deepEqual(board.totals, { calls: 4, open: 1, settled: 3, staked: 20, pnl: -2 });
  console.table(board.leaderboard.map(({ caller, ...row }) => row));
  console.log('e2e ok');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  validator.kill('SIGTERM');
  rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
