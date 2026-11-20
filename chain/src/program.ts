/**
 * The `given_receipts` Solana program (../receipts-program): the on-chain check that rides in the same transaction as
 * each Memo record when GIVEN_PROGRAM_ID is set.
 *
 * The Memo stays the record everything reads. The program instruction beside it makes Solana itself do the checking:
 * a commit creates one account holding only the hash, and a reveal fails, taking its Memo with it, unless the
 * revealed fields hash to what was committed and the call has not been revealed before. The program also keeps a
 * running score per handle, so the leaderboard can be read from accounts alone.
 *
 * The byte layouts here are checked against bytes captured from the real program (test/fixtures/program.json).
 */
import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { commitHash } from './hash.ts';
import { fieldsOf, parseMemo } from './memo.ts';
import type { CommitMemo, RevealMemo } from './memo.ts';

/** A handle is also an account seed, and a seed holds at most 32 bytes. */
export const MAX_HANDLE_BYTES = 32;
export const PRICE_ONE = 1_000_000;

const discriminator = (kind: 'global' | 'account', name: string): Buffer => createHash('sha256').update(`${kind}:${name}`).digest().subarray(0, 8);
const CALL = discriminator('account', 'CallRecord');
const STATS = discriminator('account', 'CallerStats');

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const i64 = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};
const text = (s: string): Buffer => {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(bytes.length), bytes]);
};

/**
 * A price in millionths, taken from the same six-decimal text the hash uses, so the program rebuilds exactly the
 * string that was hashed.
 */
export function millionths(price: number): bigint {
  if (!Number.isFinite(price) || price < 0) throw new Error('A price must be zero or more.');
  return BigInt(price.toFixed(6).replace('.', ''));
}

export function callAddress(programId: PublicKey, authority: PublicKey, hashHex: string): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('call'), authority.toBuffer(), Buffer.from(hashHex, 'hex')], programId)[0];
}

export function statsAddress(programId: PublicKey, authority: PublicKey, handle: string): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('caller'), authority.toBuffer(), Buffer.from(handle, 'utf8')], programId)[0];
}

function checkHandle(handle: string): void {
  if (Buffer.byteLength(handle, 'utf8') > MAX_HANDLE_BYTES) throw new Error(`A handle can be at most ${MAX_HANDLE_BYTES} bytes on chain.`);
}

export function commitInstruction(programId: PublicKey, authority: PublicKey, memo: CommitMemo): TransactionInstruction {
  checkHandle(memo.u);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: callAddress(programId, authority, memo.h), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator('global', 'commit_call'), Buffer.from(memo.h, 'hex'), text(memo.u), i64(memo.at)]),
  });
}

export function revealInstruction(programId: PublicKey, authority: PublicKey, memo: RevealMemo): TransactionInstruction {
  checkHandle(memo.u);
  if (millionths(memo.f) > BigInt(PRICE_ONE)) throw new Error('A fair price cannot be above 1.');
  // The record is found by its hash, which the reveal's own fields and salt reproduce.
  const hash = commitHash(fieldsOf(memo), memo.s);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: callAddress(programId, authority, hash), isSigner: false, isWritable: true },
      { pubkey: statsAddress(programId, authority, memo.u), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      discriminator('global', 'reveal_call'),
      text(memo.b),
      text(memo.e),
      text(memo.k),
      text(memo.x),
      u64(millionths(memo.p)),
      u32(Number(millionths(memo.f))),
      Buffer.from(memo.s, 'hex'),
      Buffer.from([memo.o]),
    ]),
  });
}

/** The program instruction that belongs beside this memo, or null if the text is not one of Given's two records. */
export function instructionFor(programId: PublicKey, authority: PublicKey, memoText: string): TransactionInstruction | null {
  const memo = parseMemo(memoText);
  if (!memo) return null;
  return memo.t === 'c' ? commitInstruction(programId, authority, memo) : revealInstruction(programId, authority, memo);
}

// ------------------------------------------------------------------ reading accounts

export interface CallAccount {
  authority: string;
  hash: string;
  handle: string;
  /** The time the service gave the call (part of the hash). */
  at: number;
  /** Solana's own clock when the hash was written. */
  committedAt: number;
  state: 'committed' | 'revealed';
  revealedAt: number | null;
  outcome: 0 | 1 | null;
  fairPrice: number | null;
  edge: number | null;
}

export interface StatsAccount {
  authority: string;
  handle: string;
  calls: number;
  hits: number;
  /** Sum of (outcome − fair price). */
  edge: number;
  lastRevealedAt: number;
}

function reader(data: Buffer, kind: Buffer) {
  if (data.length < 8 || !data.subarray(0, 8).equals(kind)) return null;
  let at = 8;
  const take = (n: number): Buffer => {
    if (at + n > data.length) throw new Error('account data is too short');
    at += n;
    return data.subarray(at - n, at);
  };
  return {
    key: () => new PublicKey(take(32)).toBase58(),
    bytes: take,
    str: () => take(take(4).readUInt32LE()).toString('utf8'),
    u8: () => take(1).readUInt8(),
    u32: () => take(4).readUInt32LE(),
    i64: () => Number(take(8).readBigInt64LE()),
  };
}

export function decodeCallAccount(data: Buffer): CallAccount | null {
  const r = reader(data, CALL);
  if (!r) return null;
  try {
    const authority = r.key();
    const hash = r.bytes(32).toString('hex');
    const handle = r.str();
    const at = r.i64();
    const committedAt = r.i64();
    const revealed = r.u8() === 1;
    const revealedAt = r.i64();
    const outcome = r.u8() === 1 ? 1 : 0;
    const fair = r.u32();
    const edge = r.i64();
    return {
      authority, hash, handle, at, committedAt,
      state: revealed ? 'revealed' : 'committed',
      revealedAt: revealed ? revealedAt : null,
      outcome: revealed ? outcome : null,
      fairPrice: revealed ? fair / PRICE_ONE : null,
      edge: revealed ? edge / PRICE_ONE : null,
    };
  } catch {
    return null;
  }
}

export function decodeStatsAccount(data: Buffer): StatsAccount | null {
  const r = reader(data, STATS);
  if (!r) return null;
  try {
    const authority = r.key();
    const handle = r.str();
    const calls = r.u32();
    const hits = r.u32();
    const edge = r.i64() / PRICE_ONE;
    return { authority, handle, calls, hits, edge, lastRevealedAt: r.i64() };
  } catch {
    return null;
  }
}

/** For `getProgramAccounts`: every score account one authority has written. */
export const statsFilters = (authority: PublicKey) => [
  { memcmp: { offset: 0, bytes: bs58(STATS) } },
  { memcmp: { offset: 8, bytes: authority.toBase58() } },
];

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58(bytes: Buffer): string {
  let n = BigInt(`0x${bytes.toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}
