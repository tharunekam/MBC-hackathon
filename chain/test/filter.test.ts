import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { encode } from '../src/memo.ts';

// Loads quicknode/filter.js the way QuickNode would run it: a script that defines `main(stream)`.
const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../quicknode/filter.js'), 'utf8');
const main = new Function(`${source}; return main;`)() as (stream: unknown) => Array<{ sig: string; slot: number }> | null;

const SIG_A = 'A'.repeat(88);
const SIG_B = 'B'.repeat(88);
const memo = encode({ g: 1, t: 'c', h: 'a'.repeat(64), u: 'quiet-otter-42', at: 1 });
const escaped = `Program log: Memo (len ${memo.length}): ${JSON.stringify(memo)}`; // as the runtime prints it: quotes escaped
const plain = `Program log: Memo (len ${memo.length}): "${memo}"`;

test('keeps only successful transactions that logged a Given memo, as { sig, slot }', () => {
  const stream = {
    data: [
      [
        { signature: SIG_A, slot: 10, success: true, logs: ['Program Memo111 invoke [1]', escaped] },
        { signature: SIG_B, slot: 10, success: true, logs: ['Program log: Memo (len 5): "hello"'] }, // someone else's memo
        { signature: 'C'.repeat(88), slot: 11, success: false, logs: [escaped] }, // failed
        { signature: 'D'.repeat(88), slot: 11, success: true, logs: ['Program log: Instruction: Transfer'] },
      ],
    ],
  };
  assert.deepEqual(main(stream), [{ sig: SIG_A, slot: 10 }]);
});

test('accepts the memo whether its quotes are printed escaped or plain', () => {
  assert.deepEqual(main({ data: [{ signature: SIG_A, slot: 1, success: true, logs: [plain] }] }), [{ sig: SIG_A, slot: 1 }]);
  assert.deepEqual(main({ data: [{ signature: SIG_A, slot: 1, success: true, logs: [escaped] }] }), [{ sig: SIG_A, slot: 1 }]);
});

test('delivers nothing (null) for a block with nothing of ours, and survives odd shapes', () => {
  assert.equal(main({ data: [] }), null);
  assert.equal(main({ data: null }), null);
  assert.equal(main({ data: [[{ signature: SIG_A, slot: 1, success: true }]] }), null, 'a transaction with no logs');
  assert.equal(main({ data: { nested: { deeper: [{ signature: SIG_A, slot: 2, success: true, logs: [escaped] }] } } })?.length, 1, 'found even when nested');
});

// ---- the shape QuickNode documents, carrying the log lines of real devnet records
const real = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/devnet-logs.json'), 'utf8')) as {
  txs: Array<{ signature: string; slot: number; blockTime: number; success: boolean; logs: string[] }>;
};
/** One transaction as the "Programs + Logs" dataset lists it. */
const asDelivered = (t: (typeof real.txs)[number]) => ({
  ...t,
  programInvocations: [{ programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', instruction: { index: 0, accounts: [{ pubkey: 'x', preBalance: 1, postBalance: 1 }], data: 'x', tokenBalances: [] } }],
});
const stranger = { signature: 'E'.repeat(88), slot: 523513408, blockTime: 1, success: true, logs: ['Program 11111111111111111111111111111111 invoke [1]', 'Program 11111111111111111111111111111111 success'], programInvocations: [] };

test('real devnet records, a commit and a reveal written through our program, are picked out of a batch of blocks', () => {
  const [commit, reveal] = real.txs.map(asDelivered);
  // A batch is one array of transactions per block. Ours sit in two of three blocks, among other people's.
  const batch = { data: [[stranger, commit], [stranger], [reveal, stranger]], metadata: { network: 'solana-devnet', dataset: 'programs_with_logs' } };
  assert.deepEqual(main(batch), [
    { sig: real.txs[0]!.signature, slot: real.txs[0]!.slot },
    { sig: real.txs[1]!.signature, slot: real.txs[1]!.slot },
  ]);
  assert.ok(real.txs[0]!.logs.some((l) => l.includes('Instruction: CommitCall')), 'the fixture really is a program call');
});

test('what the filter returns is what the webhook reads: the same signatures come out the other end', async () => {
  const { signaturesIn } = await import('../src/webhook.ts');
  const delivered = main({ data: [real.txs.map(asDelivered)] });
  assert.deepEqual(signaturesIn(delivered), real.txs.map((t) => t.signature));
  assert.deepEqual(signaturesIn({ data: delivered }), real.txs.map((t) => t.signature), 'also if QuickNode wraps the result');
});

test('a batch with nothing of ours delivers nothing, and a failed copy of a real record is ignored', () => {
  assert.equal(main({ data: [[stranger], [stranger, stranger]] }), null);
  assert.equal(main({ data: [[{ ...asDelivered(real.txs[0]!), success: false }]] }), null);
});
