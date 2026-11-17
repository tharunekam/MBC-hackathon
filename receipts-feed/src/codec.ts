// Wire format of the given_receipts program: Anchor discriminators plus borsh.
// Field order must match receipts-program/programs/given_receipts/src/state.rs;
// test/codec.test.ts checks every encoder and decoder here against bytes the
// real program accepted and emitted.
import { createHash } from 'node:crypto';
import { addressBytes, encodeBase58 } from './base58.ts';

export const discriminator = (kind: 'global' | 'event' | 'account', name: string): Buffer =>
  createHash('sha256').update(`${kind}:${name}`).digest().subarray(0, 8);

const EVENT_RECORDED = discriminator('event', 'CallRecorded');
const EVENT_SETTLED = discriminator('event', 'CallSettled');
const ACCOUNT_RECEIPT = discriminator('account', 'CallReceipt');

class Writer {
  private readonly parts: Buffer[] = [];
  bytes(b: Uint8Array): this {
    this.parts.push(Buffer.from(b));
    return this;
  }
  u8(v: number): this {
    return this.bytes(Uint8Array.of(v));
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  u32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return this.bytes(b);
  }
  u64(v: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
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
    if (this.offset + n > this.buf.length) throw new RangeError('Receipt data is shorter than its layout');
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
  address(): string {
    return encodeBase58(this.take(32));
  }
  hex(n: number): string {
    return this.take(n).toString('hex');
  }
}

/** Arguments of `record_call`. Amounts are micro-USD; `price` is micro-dollars per $1 of payout. */
export interface RecordCallArgs {
  betId: string;
  caller: string;
  handle: string;
  eventTicker: string;
  conditionSymbol: string;
  targetSymbol: string;
  conditionStrike: bigint;
  targetStrike: bigint;
  stake: bigint;
  price: number;
  payoutIfHit: bigint;
  hedged: boolean;
  placedAt: bigint;
  expiry: bigint;
  /** 32 bytes, hex. */
  evidence: string;
}

export interface SettleCallArgs {
  betId: string;
  conditionHeld: boolean;
  targetHit: boolean;
  payout: bigint;
}

export function encodeInitialize(recorder: string): Buffer {
  return new Writer().bytes(discriminator('global', 'initialize')).address(recorder).done();
}

export function encodeRecordCall(a: RecordCallArgs): Buffer {
  const evidence = Buffer.from(a.evidence, 'hex');
  if (evidence.length !== 32) throw new Error('evidence must be 32 bytes of hex');
  return new Writer()
    .bytes(discriminator('global', 'record_call'))
    .string(a.betId)
    .address(a.caller)
    .string(a.handle)
    .string(a.eventTicker)
    .string(a.conditionSymbol)
    .string(a.targetSymbol)
    .i64(a.conditionStrike)
    .i64(a.targetStrike)
    .u64(a.stake)
    .u32(a.price)
    .u64(a.payoutIfHit)
    .bool(a.hedged)
    .i64(a.placedAt)
    .i64(a.expiry)
    .bytes(evidence)
    .done();
}

export function encodeSettleCall(a: SettleCallArgs): Buffer {
  return new Writer()
    .bytes(discriminator('global', 'settle_call'))
    .string(a.betId)
    .bool(a.conditionHeld)
    .bool(a.targetHit)
    .u64(a.payout)
    .done();
}

export interface CallRecorded extends RecordCallArgs {
  type: 'CallRecorded';
  seq: bigint;
  recordedAt: bigint;
}

export interface CallSettled {
  type: 'CallSettled';
  seq: bigint;
  betId: string;
  caller: string;
  handle: string;
  conditionHeld: boolean;
  targetHit: boolean;
  stake: bigint;
  payout: bigint;
  pnl: bigint;
  settledAt: bigint;
}

function readCallFields(r: Reader): Omit<RecordCallArgs, 'betId' | 'caller'> {
  return {
    handle: r.string(),
    eventTicker: r.string(),
    conditionSymbol: r.string(),
    targetSymbol: r.string(),
    conditionStrike: r.i64(),
    targetStrike: r.i64(),
    stake: r.u64(),
    price: r.u32(),
    payoutIfHit: r.u64(),
    hedged: r.bool(),
    placedAt: r.i64(),
    expiry: r.i64(),
    evidence: r.hex(32),
  };
}

/** Decodes one `Program data:` payload. Returns null for events this program does not define. */
export function decodeEvent(raw: Buffer): CallRecorded | CallSettled | null {
  if (raw.length < 8) return null;
  const tag = raw.subarray(0, 8);
  const r = new Reader(raw.subarray(8));
  if (tag.equals(EVENT_RECORDED)) {
    const seq = r.u64();
    const betId = r.string();
    const caller = r.address();
    const fields = readCallFields(r);
    return { type: 'CallRecorded', seq, betId, caller, ...fields, recordedAt: r.i64() };
  }
  if (tag.equals(EVENT_SETTLED)) {
    return {
      type: 'CallSettled',
      seq: r.u64(),
      betId: r.string(),
      caller: r.address(),
      handle: r.string(),
      conditionHeld: r.bool(),
      targetHit: r.bool(),
      stake: r.u64(),
      payout: r.u64(),
      pnl: r.i64(),
      settledAt: r.i64(),
    };
  }
  return null;
}

export interface ReceiptAccount extends RecordCallArgs {
  seq: bigint;
  recordedAt: bigint;
  status: 'open' | 'settled';
  conditionHeld: boolean;
  targetHit: boolean;
  payout: bigint;
  pnl: bigint;
  settledAt: bigint;
}

/** Decodes a CallReceipt account as stored on chain. */
export function decodeReceiptAccount(data: Buffer): ReceiptAccount {
  if (!data.subarray(0, 8).equals(ACCOUNT_RECEIPT)) throw new Error('Not a CallReceipt account');
  const r = new Reader(data.subarray(8));
  const seq = r.u64();
  const caller = r.address();
  const betId = r.string();
  const fields = readCallFields(r);
  return {
    seq,
    caller,
    betId,
    ...fields,
    recordedAt: r.i64(),
    status: r.u8() === 0 ? 'open' : 'settled',
    conditionHeld: r.bool(),
    targetHit: r.bool(),
    payout: r.u64(),
    pnl: r.i64(),
    settledAt: r.i64(),
  };
}
