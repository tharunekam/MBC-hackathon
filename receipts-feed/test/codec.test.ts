// Checks the TypeScript wire format against bytes captured from the real
// program (written by `WRITE_LOG_FIXTURE=... cargo test` in receipts-program).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeBase58, encodeBase58 } from '../src/base58.ts';
import {
  decodeEvent, decodeReceiptAccount, encodeInitialize, encodeRecordCall, encodeSettleCall,
  type RecordCallArgs,
} from '../src/codec.ts';
import { extractProgramData } from '../src/logs.ts';
import { ReceiptStore } from '../src/store.ts';
import { ingest } from '../src/server.ts';
import { decodeReceipt, scoreLeaderboard } from '../src/receipts.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/program-logs.json', import.meta.url), 'utf8')) as {
  programId: string; caller: string; recorder: string;
  initializeIx: string; recordIx: string; settleIx: string;
  receiptPda: string; receiptAccount: string;
  recorded: string[]; settled: string[];
};

// Mirrors sample("a1b2c3d4", caller) in receipts-program's tests.
const sample: RecordCallArgs = {
  betId: 'a1b2c3d4',
  caller: fx.caller,
  handle: 'primary',
  eventTicker: 'ETH2611180000',
  conditionSymbol: 'GEMI-ETH2611180000-HI1800',
  targetSymbol: 'GEMI-ETH2611180000-HI1820',
  conditionStrike: 1_800_000_000n,
  targetStrike: 1_820_000_000n,
  stake: 5_000_000n,
  price: 625_000,
  payoutIfHit: 8_000_000n,
  hedged: true,
  placedAt: 1_794_960_000n,
  expiry: 1_795_046_400n,
  evidence: '07'.repeat(32),
};

test('base58 round-trips addresses, including leading zero bytes', () => {
  for (const address of [fx.programId, fx.caller, fx.recorder, '11111111111111111111111111111111']) {
    assert.equal(encodeBase58(decodeBase58(address)), address);
  }
  assert.equal(decodeBase58('11111111111111111111111111111111').length, 32);
});

test('instruction encoders produce the exact bytes Anchor does', () => {
  assert.equal(encodeInitialize(fx.recorder).toString('hex'), fx.initializeIx);
  assert.equal(encodeRecordCall(sample).toString('hex'), fx.recordIx);
  assert.equal(
    encodeSettleCall({ betId: 'a1b2c3d4', conditionHeld: true, targetHit: true, payout: 8_000_000n }).toString('hex'),
    fx.settleIx,
  );
});

test('decodes the events the program emitted', () => {
  const [recorded] = extractProgramData(fx.recorded, fx.programId).map(decodeEvent);
  assert.deepEqual(recorded, { type: 'CallRecorded', seq: 0n, ...sample, recordedAt: 0n });

  const [settled] = extractProgramData(fx.settled, fx.programId).map(decodeEvent);
  assert.deepEqual(settled, {
    type: 'CallSettled', seq: 0n, betId: 'a1b2c3d4', caller: fx.caller, handle: 'primary',
    conditionHeld: true, targetHit: true, stake: 5_000_000n, payout: 8_000_000n, pnl: 3_000_000n, settledAt: 0n,
  });
  assert.equal(decodeEvent(Buffer.from('not an event')), null);
});

test('decodes the receipt account', () => {
  const account = decodeReceiptAccount(Buffer.from(fx.receiptAccount, 'hex'));
  assert.deepEqual(account, {
    seq: 0n, ...sample, recordedAt: 0n,
    status: 'settled', conditionHeld: true, targetHit: true, payout: 8_000_000n, pnl: 3_000_000n, settledAt: 0n,
  });
});

test('real logs flow through ingest into the leaderboard', () => {
  const store = new ReceiptStore();
  const opts = { programId: fx.programId, store, decode: decodeReceipt };
  const tx = (signature: string, slot: number, logs: string[]) => ({ signature, slot, blockTime: 1_795_000_000, logs, success: true });
  assert.equal(ingest({ data: [[tx('recSig', 1, fx.recorded)]] }, opts), 1);

  let board = scoreLeaderboard(store.all());
  assert.deepEqual(board.totals, { calls: 1, open: 1, settled: 0, staked: 5, pnl: 0 });
  assert.equal(board.leaderboard[0]!.roi, null);

  assert.equal(ingest({ data: [[tx('setSig', 2, fx.settled)]] }, opts), 1);
  board = scoreLeaderboard(store.all());
  assert.deepEqual(board.leaderboard, [{
    rank: 1, caller: fx.caller, handle: 'primary', calls: 1, open: 0, hits: 1, misses: 0, refunds: 0,
    staked: 5, pnl: 3, roi: 0.6, hitRate: 1,
  }]);
  const call = board.calls[0]!;
  assert.deepEqual(
    [call.status, call.outcome, call.price, call.conditionStrike, call.recordTx, call.settleTx],
    ['settled', 'hit', 0.625, 1800, 'recSig', 'setSig'],
  );
});

test('leaderboard ranks by profit, then hit rate', () => {
  const rec = (betId: string, handle: string, seq: number) => ({
    id: `${betId}:r`, signature: `r-${betId}`, slot: seq, blockTime: null, data: '',
    decoded: {
      type: 'CallRecorded', seq, betId, caller: `wallet-${handle}`, handle, eventTicker: 'E', conditionSymbol: 'A',
      targetSymbol: 'B', conditionStrike: 1, targetStrike: 2, stake: 10, price: 0.5, payoutIfHit: 20, hedged: true,
      placedAt: 0, expiry: null,
    },
  });
  const set = (betId: string, conditionHeld: boolean, targetHit: boolean, payout: number, slot: number) => ({
    id: `${betId}:s`, signature: `s-${betId}`, slot, blockTime: null, data: '',
    decoded: { type: 'CallSettled', betId, conditionHeld, targetHit, stake: 10, payout, pnl: payout - 10, settledAt: 0 },
  });
  const board = scoreLeaderboard([
    rec('a1', 'ann', 0), rec('a2', 'ann', 1), rec('b1', 'bob', 2), rec('b2', 'bob', 3), rec('c1', 'cy', 4),
    set('a1', true, true, 20, 5),   // ann: hit  +10
    set('a2', true, false, 0, 6),   // ann: miss -10
    set('b1', true, true, 20, 7),   // bob: hit  +10
    set('b2', false, false, 10, 8), // bob: refund 0
    set('b2', true, true, 20, 9),   // duplicate settle is ignored
  ]);
  assert.deepEqual(
    board.leaderboard.map((r) => [r.rank, r.handle, r.pnl, r.hitRate, r.hits, r.misses, r.refunds, r.open]),
    [[1, 'bob', 10, 1, 1, 0, 1, 0], [2, 'ann', 0, 0.5, 1, 1, 0, 0], [3, 'cy', 0, null, 0, 0, 0, 1]],
  );
  assert.deepEqual(board.totals, { calls: 5, open: 1, settled: 4, staked: 50, pnl: 10 });
});
