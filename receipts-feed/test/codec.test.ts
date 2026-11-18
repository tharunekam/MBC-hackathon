// Checks the TypeScript wire format against bytes captured from the real
// program (written by `WRITE_LOG_FIXTURE=... cargo test` in receipts-program).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { decodeBase58, encodeBase58 } from '../src/base58.ts';
import {
  commitHash, decodeCallAccount, decodeEvent, decodeStatsAccount, encodeCommitCall, encodeInitialize,
  encodeRevealCall, type CallDetails,
} from '../src/codec.ts';
import { extractProgramData } from '../src/logs.ts';
import { ReceiptStore } from '../src/store.ts';
import { ingest } from '../src/server.ts';
import { buildLeaderboard, decodeReceipt } from '../src/receipts.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/program-logs.json', import.meta.url), 'utf8')) as {
  programId: string; recorder: string;
  initializeIx: string; commitIx: string; revealIx: string;
  commit: string; salt: string;
  callPda: string; callAccount: string; statsPda: string; statsAccount: string;
  committed: string[]; revealed: string[];
};

// Mirrors sample("a1b2c3d4", "brisk-otter-42") in receipts-program's tests.
const EXPIRY = 1_794_960_000n;
const sample: CallDetails = {
  betId: 'a1b2c3d4',
  handle: 'brisk-otter-42',
  eventTicker: 'ETH2611180000',
  conditionSymbol: 'GEMI-ETH2611180000-HI1800',
  targetSymbol: 'GEMI-ETH2611180000-HI1820',
  fairPrice: 625_000,
  placedAt: EXPIRY - 7_200n,
  expiry: EXPIRY,
  evidence: '07'.repeat(32),
};

test('base58 round-trips addresses', () => {
  for (const address of [fx.programId, fx.recorder, '11111111111111111111111111111111']) {
    assert.equal(encodeBase58(decodeBase58(address)), address);
  }
});

test('the commitment computed here is the one the program accepted', () => {
  assert.equal(commitHash(sample, fx.salt), fx.commit);
  assert.notEqual(commitHash({ ...sample, fairPrice: 624_999 }, fx.salt), fx.commit);
  assert.notEqual(commitHash(sample, '08'.repeat(32)), fx.commit);
});

test('instructions encode to the bytes the program accepted', () => {
  assert.equal(encodeInitialize(fx.recorder).toString('hex'), fx.initializeIx);
  assert.equal(encodeCommitCall(fx.commit).toString('hex'), fx.commitIx);
  assert.equal(encodeRevealCall({ details: sample, salt: fx.salt, targetHit: true }).toString('hex'), fx.revealIx);
});

test('record addresses derive from the commitment and the handle', () => {
  const program = new PublicKey(fx.programId);
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0].toBase58();
  assert.equal(pda(Buffer.from('call'), Buffer.from(fx.commit, 'hex')), fx.callPda);
  assert.equal(pda(Buffer.from('caller'), Buffer.from(sample.handle)), fx.statsPda);
});

test('events emitted by the program decode', () => {
  const [committed] = extractProgramData(fx.committed, fx.programId);
  const [revealed] = extractProgramData(fx.revealed, fx.programId);
  assert.ok(committed && revealed);
  // A commitment publishes a number, a hash and a time: nothing about the call.
  assert.deepEqual(decodeEvent(committed), { type: 'CallCommitted', seq: 0n, commit: fx.commit, committedAt: EXPIRY - 7_196n });
  assert.deepEqual(decodeEvent(revealed), {
    type: 'CallRevealed',
    seq: 0n,
    commit: fx.commit,
    committedAt: EXPIRY - 7_196n,
    revealedAt: EXPIRY + 300n,
    targetHit: true,
    edge: 375_000n,
    details: sample,
  });
  assert.equal(decodeEvent(Buffer.from('not an event at all')), null);
});

test('accounts decode as stored', () => {
  assert.deepEqual(decodeCallAccount(Buffer.from(fx.callAccount, 'hex')), {
    seq: 0n,
    commit: fx.commit,
    committedAt: EXPIRY - 7_196n,
    state: 'revealed',
    revealedAt: EXPIRY + 300n,
    targetHit: true,
    edge: 375_000n,
    details: sample,
  });
  assert.deepEqual(decodeStatsAccount(Buffer.from(fx.statsAccount, 'hex')), {
    handle: 'brisk-otter-42', calls: 1, hits: 1, edgeSum: 375_000n, lastRevealedAt: EXPIRY + 300n,
  });
  assert.throws(() => decodeCallAccount(Buffer.from(fx.statsAccount, 'hex')), /Not a CallRecord/);
});

test('real program logs become a leaderboard row', () => {
  const store = new ReceiptStore();
  const opts = { programId: fx.programId, store, decode: decodeReceipt };
  const tx = (signature: string, slot: number, logs: string[]) => ({ signature, slot, blockTime: null, logs, success: true });
  assert.equal(ingest({ data: [[tx('commitSig', 10, fx.committed), tx('revealSig', 20, fx.revealed)]] }, opts), 2);

  const board = buildLeaderboard(store.all(), { minCalls: 1, now: () => new Date('2026-11-18T01:00:00Z') });
  assert.deepEqual(board, {
    asOf: '2026-11-18T01:00:00.000Z',
    minCalls: 1,
    source: 'quicknode-stream',
    rows: [{ rank: 1, handle: 'brisk-otter-42', calls: 1, edge: 0.375, hitRate: 1, lastRevealedAt: '2026-11-18T00:05:00.000Z' }],
    totals: { committed: 1, revealed: 1, handles: 1 },
  });
  // The default bar is three revealed calls.
  assert.deepEqual(buildLeaderboard(store.all()).rows, []);
});
