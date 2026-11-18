/**
 * The two records Given writes to Solana, as Memo-program text.
 *
 *   commit  {"g":1,"t":"c","h":<sha256 hex>,"u":<handle>,"at":<unix seconds>}
 *   reveal  {"g":1,"t":"r","c":<commit tx signature>,"u":<handle>,"b":<bet id>,"e":<event>,
 *            "k":<condition>,"x":<target>,"p":<entry price>,"f":<fair price>,"at":<unix seconds>,
 *            "s":<salt>,"o":0|1}
 *
 * A reveal carries every input of the commit hash, so it can be checked with no other data.
 * The edge is not stored: readers compute outcome minus fair price themselves.
 * The Memo program caps a memo at 566 bytes; `encode` refuses anything larger.
 */
import { commitHash } from './hash.ts';
import type { CallFields } from './hash.ts';

export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const MEMO_MAX_BYTES = 566;

export interface CommitMemo {
  g: 1;
  t: 'c';
  h: string;
  u: string;
  at: number;
}

export interface RevealMemo {
  g: 1;
  t: 'r';
  c: string;
  u: string;
  b: string;
  e: string;
  k: string;
  x: string;
  p: number;
  f: number;
  at: number;
  s: string;
  o: 0 | 1;
}

export type Memo = CommitMemo | RevealMemo;

export function encode(memo: Memo): string {
  const text = JSON.stringify(memo);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MEMO_MAX_BYTES) throw new Error(`Memo is ${bytes} bytes; the Memo program allows ${MEMO_MAX_BYTES}.`);
  return text;
}

const isStr = (v: unknown, max = 128): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/** Parses a memo strictly. Anything that is not exactly one of the two shapes returns null; nothing is guessed. */
export function parseMemo(text: string): Memo | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.g !== 1) return null;
  if (o.t === 'c') {
    if (typeof o.h !== 'string' || !HEX64.test(o.h) || !isStr(o.u, 40) || !isNum(o.at)) return null;
    return { g: 1, t: 'c', h: o.h, u: o.u, at: o.at };
  }
  if (o.t === 'r') {
    if (typeof o.c !== 'string' || !SIG.test(o.c)) return null;
    if (!isStr(o.u, 40) || !isStr(o.b) || !isStr(o.e) || !isStr(o.k) || !isStr(o.x)) return null;
    if (!isNum(o.p) || !isNum(o.f) || !isNum(o.at)) return null;
    if (typeof o.s !== 'string' || !HEX32.test(o.s)) return null;
    if (o.o !== 0 && o.o !== 1) return null;
    return { g: 1, t: 'r', c: o.c, u: o.u, b: o.b, e: o.e, k: o.k, x: o.x, p: o.p, f: o.f, at: o.at, s: o.s, o: o.o };
  }
  return null;
}

export const fieldsOf = (r: RevealMemo): CallFields => ({ betId: r.b, event: r.e, condition: r.k, target: r.x, entryPrice: r.p, fairPrice: r.f, at: r.at });

/**
 * True only if the reveal reproduces the commit: same hash, same handle, same time.
 * The caller separately checks the reveal points at this commit's transaction.
 */
export function revealMatchesCommit(commit: CommitMemo, reveal: RevealMemo): boolean {
  if (commit.u !== reveal.u || commit.at !== reveal.at) return false;
  try {
    return commitHash(fieldsOf(reveal), reveal.s) === commit.h;
  } catch {
    return false;
  }
}
