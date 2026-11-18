// Wire format of the given_receipts program: Anchor discriminators plus borsh.
// Field order must match receipts-program/programs/given_receipts/src/state.rs;
// test/codec.test.ts checks every encoder and decoder here, and the commitment
// hash, against bytes the real program accepted and emitted.
import { createHash } from 'node:crypto';
import { addressBytes } from './base58.ts';

export const discriminator = (kind: 'global' | 'event' | 'account', name: string): Buffer =>
  createHash('sha256').update(`${kind}:${name}`).digest().subarray(0, 8);

const EVENT_COMMITTED = discriminator('event', 'CallCommitted');
const EVENT_REVEALED = discriminator('event', 'CallRevealed');
const ACCOUNT_CALL = discriminator('account', 'CallRecord');
const ACCOUNT_STATS = discriminator('account', 'CallerStats');

/** Prefix of every commitment (COMMIT_DOMAIN in the program). */
export const COMMIT_DOMAIN = 'given:call:v1';
/** Prices and edge are micro-dollars per $1 of payout. */
export const PRICE_ONE = 1_000_000;

class Writer {
  private readonly parts: Buffer[] = [];
  bytes(b: Uint8Array): this {
    this.parts.push(Buffer.from(b));
    return this;
  }
  bool(v: boolean): this {
    return this.bytes(Uint8Array.of(v ? 1 : 0));
  }
  u32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return this.bytes(b);
  }
  i64(v: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v);
    return this.bytes(b);
  }
  string(v: string): this {
    const b = Buffer.from(v, 'utf8');
    return this.u32(b.length).bytes(b);
  }
  address(v: string): this {
    return this.bytes(addressBytes(v));
  }
  done(): Buffer {
    return Buffer.concat(this.parts);
  }
}

class Reader {
  private offset = 0;
  private readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  private take(n: number): Buffer {
    if (this.offset + n > this.buf.length) throw new RangeError('Data is shorter than its layout');
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  u8(): number {
    return this.take(1)[0]!;
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u32(): number {
    return this.take(4).readUInt32LE();
  }
  u64(): bigint {
    return this.take(8).readBigUInt64LE();
  }
  i64(): bigint {
    return this.take(8).readBigInt64LE();
  }
  string(): string {
    return this.take(this.u32()).toString('utf8');
  }
  hex(n: number): string {
    return this.take(n).toString('hex');
  }
}

/** 32 bytes given as 64 hex characters. */
export function bytes32(hex: string, name: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${name} must be 32 bytes of hex`);
  return Buffer.from(hex, 'hex');
}

/** What a commitment hides until it is revealed (CallDetails in the program). */
export interface CallDetails {
  betId: string;
  handle: string;
  eventTicker: string;
  conditionSymbol: string;
  targetSymbol: string;
  /** Fair price at entry, micro-dollars per $1 of payout. */
  fairPrice: number;
  /** Unix seconds. */
  placedAt: bigint;
  /** Unix seconds: when the event closes. */
  expiry: bigint;
  /** SHA-256 of the bet's Gemini order legs, hex. */
  evidence: string;
}

function writeDetails(w: Writer, d: CallDetails): Writer {
  return w
    .string(d.betId)
    .string(d.handle)
    .string(d.eventTicker)
    .string(d.conditionSymbol)
    .string(d.targetSymbol)
    .u32(d.fairPrice)
    .i64(d.placedAt)
    .i64(d.expiry)
    .bytes(bytes32(d.evidence, 'evidence'));
}

function readDetails(r: Reader): CallDetails {
  return {
    betId: r.string(),
    handle: r.string(),
    eventTicker: r.string(),
    conditionSymbol: r.string(),
    targetSymbol: r.string(),
    fairPrice: r.u32(),
    placedAt: r.i64(),
    expiry: r.i64(),
    evidence: r.hex(32),
  };
}

/** sha256(COMMIT_DOMAIN || borsh(details) || salt), hex: what `commit_call` stores. */
export function commitHash(details: CallDetails, salt: string): string {
  return createHash('sha256')
    .update(COMMIT_DOMAIN)
    .update(writeDetails(new Writer(), details).done())
    .update(bytes32(salt, 'salt'))
    .digest('hex');
}

export function encodeInitialize(recorder: string): Buffer {
  return new Writer().bytes(discriminator('global', 'initialize')).address(recorder).done();
}

export function encodeCommitCall(commit: string): Buffer {
  return new Writer().bytes(discriminator('global', 'commit_call')).bytes(bytes32(commit, 'commit')).done();
}

export function encodeRevealCall(a: { details: CallDetails; salt: string; targetHit: boolean }): Buffer {
  return writeDetails(new Writer().bytes(discriminator('global', 'reveal_call')), a.details)
    .bytes(bytes32(a.salt, 'salt'))
    .bool(a.targetHit)
    .done();
}

export interface CallCommitted {
  type: 'CallCommitted';
  seq: bigint;
  commit: string;
  committedAt: bigint;
}

export interface CallRevealed {
  type: 'CallRevealed';
  seq: bigint;
  commit: string;
  committedAt: bigint;
  revealedAt: bigint;
  targetHit: boolean;
  /** Micro-dollars: (1.00 if the target hit, else 0) minus the fair price. */
  edge: bigint;
  details: CallDetails;
}

/** Decodes one `Program data:` payload. Returns null for events this program does not define. */
export function decodeEvent(raw: Buffer): CallCommitted | CallRevealed | null {
  if (raw.length < 8) return null;
  const tag = raw.subarray(0, 8);
  const r = new Reader(raw.subarray(8));
  if (tag.equals(EVENT_COMMITTED)) {
    return { type: 'CallCommitted', seq: r.u64(), commit: r.hex(32), committedAt: r.i64() };
  }
  if (tag.equals(EVENT_REVEALED)) {
    return {
      type: 'CallRevealed',
      seq: r.u64(),
      commit: r.hex(32),
      committedAt: r.i64(),
      revealedAt: r.i64(),
      targetHit: r.bool(),
      edge: r.i64(),
      details: readDetails(r),
    };
  }
  return null;
}

export interface CallAccount {
  seq: bigint;
  commit: string;
  committedAt: bigint;
  state: 'committed' | 'revealed';
  revealedAt: bigint;
  targetHit: boolean;
  edge: bigint;
  /** Empty strings and zeros until the call is revealed. */
  details: CallDetails;
}

/** Decodes a CallRecord account as stored on chain. */
export function decodeCallAccount(data: Buffer): CallAccount {
  if (!data.subarray(0, 8).equals(ACCOUNT_CALL)) throw new Error('Not a CallRecord account');
  const r = new Reader(data.subarray(8));
  const seq = r.u64();
  const commit = r.hex(32);
  const committedAt = r.i64();
  const state = r.u8() === 0 ? 'committed' : 'revealed';
  r.u8(); // bump
  return { seq, commit, committedAt, state, revealedAt: r.i64(), targetHit: r.bool(), edge: r.i64(), details: readDetails(r) };
}

export interface StatsAccount {
  handle: string;
  calls: number;
  hits: number;
  edgeSum: bigint;
  lastRevealedAt: bigint;
}

/** Decodes a CallerStats account: one handle's running score. */
export function decodeStatsAccount(data: Buffer): StatsAccount {
  if (!data.subarray(0, 8).equals(ACCOUNT_STATS)) throw new Error('Not a CallerStats account');
  const r = new Reader(data.subarray(8));
  return { handle: r.string(), calls: r.u32(), hits: r.u32(), edgeSum: r.i64(), lastRevealedAt: r.i64() };
}
