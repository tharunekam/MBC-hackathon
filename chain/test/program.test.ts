import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { SolanaChain } from '../src/chain.ts';
import { commitHash, preimage } from '../src/hash.ts';
import type { CallFields } from '../src/hash.ts';
import { MEMO_PROGRAM_ID, encode } from '../src/memo.ts';
import type { CommitMemo, RevealMemo } from '../src/memo.ts';
import { callAddress, commitInstruction, decodeCallAccount, decodeStatsAccount, instructionFor, millionths, revealInstruction, statsAddress } from '../src/program.ts';

// Bytes captured from the real program by its own tests (receipts-program: WRITE_PROGRAM_FIXTURE=... cargo test).
const fixture = JSON.parse(readFileSync(new URL('./fixtures/program.json', import.meta.url), 'utf8')) as Record<string, string>;
const programId = new PublicKey(fixture.programId!);
const authority = new PublicKey(fixture.authority!);

// The same example test/memo.test.ts pins the preimage with.
const FIELDS: CallFields = {
  betId: 'd1a2b3',
  event: 'BTC2611190100',
  condition: 'GEMI-BTC2611190100-HI62500',
  target: 'GEMI-BTC2611190100-HI63500',
  entryPrice: 0.4375,
  fairPrice: 0.41,
  at: 1763433000,
};
const SALT = 'aa'.repeat(16);
const HANDLE = 'quiet-otter-42';
const commit: CommitMemo = { g: 1, t: 'c', h: commitHash(FIELDS, SALT), u: HANDLE, at: FIELDS.at };
const reveal: RevealMemo = {
  g: 1, t: 'r', c: '5'.repeat(88), u: HANDLE, b: FIELDS.betId, e: FIELDS.event, k: FIELDS.condition, x: FIELDS.target, p: FIELDS.entryPrice, f: FIELDS.fairPrice, at: FIELDS.at, s: SALT, o: 1,
};

test('the program hashes the same text as the service', () => {
  assert.equal(preimage(FIELDS, SALT), fixture.preimage);
  assert.equal(commit.h, fixture.hash);
});

test('the commit instruction is byte-for-byte what the program expects', () => {
  const ix = commitInstruction(programId, authority, commit);
  assert.equal(ix.data.toString('hex'), fixture.commitIx);
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), [fixture.authority, fixture.callPda, '11111111111111111111111111111111']);
  assert.equal(callAddress(programId, authority, commit.h).toBase58(), fixture.callPda);
});

test('the reveal instruction is byte-for-byte what the program expects, and finds its record by the recomputed hash', () => {
  const ix = revealInstruction(programId, authority, reveal);
  assert.equal(ix.data.toString('hex'), fixture.revealIx);
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), [fixture.authority, fixture.callPda, fixture.statsPda, '11111111111111111111111111111111']);
  assert.equal(statsAddress(programId, authority, HANDLE).toBase58(), fixture.statsPda);
});

test('prices go on chain as the same six decimals the hash uses', () => {
  assert.equal(millionths(0.4375), 437500n);
  assert.equal(millionths(0.41), 410000n);
  assert.equal(millionths(1), 1000000n);
  assert.equal(millionths(0), 0n);
  assert.equal(millionths(0.1 + 0.2), 300000n);
  assert.equal(millionths(0.9999996), 1000000n);
  assert.throws(() => millionths(-0.1));
  assert.throws(() => millionths(Number.NaN));
  assert.throws(() => revealInstruction(programId, authority, { ...reveal, f: 1.2 }), /fair price/);
});

test('a handle too long to be an account seed is refused before anything is sent', () => {
  assert.throws(() => commitInstruction(programId, authority, { ...commit, u: 'x'.repeat(33) }), /32 bytes/);
});

test('only Given records get a program instruction', () => {
  assert.equal(instructionFor(programId, authority, 'hello'), null);
  assert.equal(instructionFor(programId, authority, '{"g":2,"t":"c"}'), null);
  assert.equal(instructionFor(programId, authority, encode(commit))!.data.toString('hex'), fixture.commitIx);
  assert.equal(instructionFor(programId, authority, encode(reveal))!.data.toString('hex'), fixture.revealIx);
});

test('a record is a Memo alone, or a Memo with the program check beside it', () => {
  const key = Keypair.generate();
  const memoOnly = new SolanaChain('http://127.0.0.1:1', key).instructions(encode(commit));
  assert.deepEqual(memoOnly.map((i) => i.programId.toBase58()), [MEMO_PROGRAM_ID]);

  const chain = new SolanaChain('http://127.0.0.1:1', key, fixture.programId);
  assert.equal(chain.program, fixture.programId);
  const both = chain.instructions(encode(reveal));
  assert.deepEqual(both.map((i) => i.programId.toBase58()), [MEMO_PROGRAM_ID, fixture.programId]);
  assert.equal(both[0]!.data.toString('utf8'), encode(reveal), 'the Memo is unchanged, so every reader of Memo records still works');
  assert.equal(both[1]!.keys[0]!.pubkey.toBase58(), key.publicKey.toBase58());
});

test('the program accounts decode: a revealed call and its handle\'s running score', () => {
  const call = decodeCallAccount(Buffer.from(fixture.callAccount!, 'hex'));
  assert.deepEqual(call, {
    authority: fixture.authority, hash: fixture.hash, handle: HANDLE, at: FIELDS.at, committedAt: FIELDS.at + 3,
    state: 'revealed', revealedAt: FIELDS.at + 3600, outcome: 1, fairPrice: 0.41, edge: 0.59,
  });
  const stats = decodeStatsAccount(Buffer.from(fixture.statsAccount!, 'hex'));
  assert.deepEqual(stats, { authority: fixture.authority, handle: HANDLE, calls: 1, hits: 1, edge: 0.59, lastRevealedAt: FIELDS.at + 3600 });
  assert.equal(decodeCallAccount(Buffer.from(fixture.statsAccount!, 'hex')), null);
  assert.equal(decodeStatsAccount(Buffer.alloc(4)), null);
});
