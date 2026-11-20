/**
 * Verify a revealed call from Solana alone, in the browser, without trusting our server.
 *
 * Given the signature of a reveal transaction, this reads the reveal and the commit it names straight from a Solana RPC,
 * checks both were signed by our authority key, and recomputes the commit hash from the revealed fields and salt.
 * The hash format must match `chain/src/hash.ts`; `verify.test.ts` pins both to the same vector.
 *
 * What it proves: the call (event, strikes, entry price, fair price) was fixed on chain and not changed afterwards, and its
 * commit landed in an earlier slot than its reveal. Where the market's close time is part of the event's code, it also shows
 * the commit landed before the market closed, by Solana's own block time.
 * What it does not: the outcome is attested by our authority key (no hash can cover a result that did not exist yet), and
 * the key itself is the one our server names, so it is shown for the reader to compare, not proved here.
 */

import { kindOfBetId } from './betKind';
import type { BetKind } from './betKind';
import { money, trunc } from './format';
import { assetLabel } from './markets';

export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export interface CallFields {
  betId: string;
  event: string;
  condition: string;
  target: string;
  entryPrice: number;
  fairPrice: number;
  /** Unix seconds when the call was committed. */
  at: number;
}

export const preimage = (f: CallFields, salt: string): string =>
  ['given1', f.betId, f.event, f.condition, f.target, f.entryPrice.toFixed(6), f.fairPrice.toFixed(6), String(f.at), salt].join('|');

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const commitHash = (f: CallFields, salt: string): Promise<string> => sha256Hex(preimage(f, salt));

/** A JSON-RPC call to a Solana node. Injected so tests need no network. */
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export function solanaRpc(url: string): Rpc {
  return async (method, params) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!res.ok) throw new Error(`The Solana node answered ${res.status}.`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? 'The Solana node returned an error.');
    return body.result ?? null;
  };
}

interface ParsedTx {
  slot?: number;
  /** Unix seconds, as Solana's validators vote it. Null or absent for a block whose time the node does not have. */
  blockTime?: number | null;
  meta?: { err: unknown } | null;
  transaction: {
    message: {
      instructions: Array<{ program?: string; programId?: string; parsed?: unknown }>;
      accountKeys: Array<{ pubkey: string; signer: boolean }>;
    };
  };
}

export interface MemoTx {
  memo: string;
  signer: string;
  slot: number;
  /** Unix seconds, or null when the node did not give one. */
  blockTime: number | null;
  /** Every program the (successful) transaction invoked. Used to see whether our program ran. */
  programs: string[];
}

export async function memoTx(rpc: Rpc, signature: string): Promise<MemoTx | null> {
  const tx = (await rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])) as ParsedTx | null;
  if (!tx || (tx.meta && tx.meta.err)) return null;
  const ix = tx.transaction.message.instructions.find((i) => i.program === 'spl-memo' || i.programId === MEMO_PROGRAM_ID);
  const signer = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey;
  if (!ix || typeof ix.parsed !== 'string' || !signer) return null;
  const programs = tx.transaction.message.instructions.map((i) => i.programId).filter((p): p is string => typeof p === 'string');
  return { memo: ix.parsed, signer, slot: wholeSlot(tx.slot), blockTime: sensibleTime(tx.blockTime), programs };
}

/** A slot is a whole number the node sent as a number. Anything else counts as missing (0), which the order check refuses. */
const wholeSlot = (slot: unknown): number => (typeof slot === 'number' && Number.isSafeInteger(slot) && slot >= 0 ? slot : 0);

/**
 * A block time is whole unix seconds between 1970 and 2100. A node answering anything else (a string, NaN, a number too big
 * for a date) gave no usable time, and the page says it was not given one instead of failing on it.
 */
const sensibleTime = (t: unknown): number | null => (typeof t === 'number' && Number.isSafeInteger(t) && t > 0 && t < 4_102_444_800 ? t : null);

export interface Check {
  id: 'reveal-found' | 'reveal-signer' | 'commit-found' | 'commit-signer' | 'link' | 'hash' | 'order' | 'closed' | 'program';
  label: string;
  ok: boolean;
  detail?: string;
  /** Informational: it never decides `Verification.ok`. Records made before the program existed are valid without it. */
  optional?: boolean;
}

export interface Verification {
  ok: boolean;
  checks: Check[];
  commitSignature: string | null;
}

type Json = Record<string, unknown>;
const parse = (text: string): Json | null => {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
};

/** "2026-11-18 04:43:18 UTC": a moment on Solana's clock, written the same in every time zone. */
export const utcTime = (seconds: number): string => {
  const at = new Date(seconds * 1000);
  // A time that is not a date must not throw in the middle of a check: it prints as unknown.
  return Number.isNaN(at.getTime()) ? 'an unknown time' : `${at.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
};

/**
 * When a market closes, in unix seconds, from its event code: the exchange ends a code with the close as YYMMDDHHMM in UTC
 * ("BTC2611190100" closes 2026-11-19 01:00 UTC). Null for a code that does not end that way, so nothing is claimed about it.
 */
export function closeTimeOf(event: string): number | null {
  const m = /^[A-Z]+(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(event);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  const at = new Date(Date.UTC(2000 + year, month - 1, day, hour, minute));
  // A date that does not exist (month 13, the 31st of a short month) rolls over into a real one; a real code never does.
  if (at.getUTCFullYear() !== 2000 + year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day || at.getUTCHours() !== hour || at.getUTCMinutes() !== minute) return null;
  return Math.floor(at.getTime() / 1000);
}

/**
 * Runs the checks in order and stops at the first failure, so the page can say exactly which step broke.
 *
 * `authority` is the key our server names for these records, so "signed by" is a comparison with that key, which the
 * reader can set beside the key listed on the Proof page; it is not an independent proof of the key. The hash, the order of
 * the two records and the times come from Solana and from the revealed fields, not from our server.
 */
export async function verifyOnChain(rpc: Rpc, revealSignature: string, authority: string, program?: string | null): Promise<Verification> {
  const checks: Check[] = [];
  const fail = (c: Check): Verification => ({ ok: false, checks: [...checks, c], commitSignature: null });

  const revealTx = await memoTx(rpc, revealSignature);
  const reveal = revealTx ? parse(revealTx.memo) : null;
  if (!revealTx || !reveal || reveal.g !== 1 || reveal.t !== 'r') return fail({ id: 'reveal-found', label: 'Found the reveal on Solana', ok: false, detail: 'No Given reveal at that signature.' });
  checks.push({ id: 'reveal-found', label: 'Found the reveal on Solana', ok: true, detail: `slot ${revealTx.slot}` });

  const keyNote = `${trunc(authority, 6, 4)} is the key our server names. Compare it with the key listed on the Proof page.`;
  if (revealTx.signer !== authority) return fail({ id: 'reveal-signer', label: 'Reveal signed by the key listed on the Proof page', ok: false, detail: 'Signed by a key other than the one our server names.' });
  checks.push({ id: 'reveal-signer', label: 'Reveal signed by the key listed on the Proof page', ok: true, detail: keyNote });

  const commitSignature = String(reveal.c ?? '');
  const commitTx = commitSignature ? await memoTx(rpc, commitSignature) : null;
  const commit = commitTx ? parse(commitTx.memo) : null;
  if (!commitTx || !commit || commit.g !== 1 || commit.t !== 'c') return { ...fail({ id: 'commit-found', label: 'Found the commit it points to', ok: false, detail: 'The commit is missing.' }), commitSignature };
  checks.push({ id: 'commit-found', label: 'Found the commit it points to', ok: true, detail: `slot ${commitTx.slot}` });

  if (commitTx.signer !== authority) return { ...fail({ id: 'commit-signer', label: 'Commit signed by the key listed on the Proof page', ok: false, detail: 'Signed by a key other than the one our server names.' }), commitSignature };
  checks.push({ id: 'commit-signer', label: 'Commit signed by the key listed on the Proof page', ok: true, detail: keyNote });

  if (commit.u !== reveal.u || commit.at !== reveal.at) return { ...fail({ id: 'link', label: 'Same player and time on both', ok: false }), commitSignature };
  checks.push({ id: 'link', label: 'Same player and time on both', ok: true });

  const f: CallFields = {
    betId: String(reveal.b),
    event: String(reveal.e),
    condition: String(reveal.k),
    target: String(reveal.x),
    entryPrice: Number(reveal.p),
    fairPrice: Number(reveal.f),
    at: Number(reveal.at),
  };
  let recomputed: string;
  try {
    recomputed = await commitHash(f, String(reveal.s));
  } catch {
    return { ...fail({ id: 'hash', label: 'The revealed call reproduces the commit', ok: false, detail: 'The record is malformed.' }), commitSignature };
  }
  if (recomputed !== commit.h) return { ...fail({ id: 'hash', label: 'The revealed call reproduces the commit', ok: false, detail: 'The hashes differ: this call was changed after it was committed.' }), commitSignature };
  checks.push({ id: 'hash', label: 'The revealed call reproduces the commit', ok: true, detail: `${recomputed.slice(0, 12)}…` });

  // When. The hash shows the call was not changed; only Solana's own slots and block times show which record came first. A
  // seal that did not land before the reveal proves nothing about the call, so it fails the verification.
  const sealedAt = commitTx.blockTime;
  const revealedAt = revealTx.blockTime;
  const times = sealedAt !== null && revealedAt !== null;
  const when = times
    ? `Sealed ${utcTime(sealedAt)} (slot ${commitTx.slot}); revealed ${utcTime(revealedAt)} (slot ${revealTx.slot}).`
    : `Sealed in slot ${commitTx.slot}; revealed in slot ${revealTx.slot}. Solana gave no clock time for one of them.`;
  if (commitTx.slot <= 0 || revealTx.slot <= 0) {
    return { ...fail({ id: 'order', label: 'Sealed before it was revealed', ok: false, detail: 'Solana did not say which slot each record landed in, so their order cannot be shown.' }), commitSignature };
  }
  if (commitTx.slot >= revealTx.slot || (times && sealedAt > revealedAt)) {
    return { ...fail({ id: 'order', label: 'Sealed before it was revealed', ok: false, detail: `The seal did not land before the reveal. ${when}` }), commitSignature };
  }
  checks.push({ id: 'order', label: 'Sealed before it was revealed', ok: true, detail: when });

  // Before the market closed: only where the close is part of what the call published (the event code) and Solana gave the
  // seal a time. Otherwise nothing is claimed about the close; the times above are all there is.
  const closes = closeTimeOf(f.event);
  if (closes !== null && sealedAt !== null) {
    const early = sealedAt < closes;
    const closed = `The market closed ${utcTime(closes)}, a time that is part of its event code (${f.event}).`;
    if (!early) return { ...fail({ id: 'closed', label: 'Sealed before the market closed', ok: false, detail: `The seal landed ${utcTime(sealedAt)}. ${closed}` }), commitSignature };
    checks.push({ id: 'closed', label: 'Sealed before the market closed', ok: true, detail: `Sealed ${utcTime(sealedAt)}. ${closed}` });
  }

  // Beyond the hash: did Solana's own program run on both transactions? A transaction that includes the program and
  // succeeded passed its checks (the program rejects a reveal that does not reproduce its commit, and a repeat reveal).
  // Informational only: records made before the program existed are Memos and are still valid.
  if (program) {
    const checked = revealTx.programs.includes(program) && commitTx.programs.includes(program);
    checks.push(
      checked
        ? { id: 'program', label: 'Solana’s program checked it on chain', ok: true, optional: true, detail: `Program ${program.slice(0, 8)}… ran on both transactions, and Solana would have rejected a changed or repeated reveal.` }
        : { id: 'program', label: 'Recorded as a Memo only', ok: false, optional: true, detail: 'This call was recorded without the on-chain program. The hash check above still holds.' },
    );
  }

  return { ok: true, checks, commitSignature };
}

/**
 * The sentence under the checks, saying only what they found: the order of the two records always, and the market's close
 * only when that check ran. It never says "before the result", which no check here can show.
 */
export function verdictLine(v: Verification): string {
  if (!v.ok) return 'This call did not verify. Treat it as unproven.';
  const closed = v.checks.some((c) => c.id === 'closed' && c.ok);
  return closed
    ? 'Verified. The call was sealed on Solana before the market closed and before it was revealed, and it was not changed afterwards.'
    : 'Verified. The call was sealed on Solana before it was revealed, and it was not changed afterwards.';
}

/** `GEMI-BTC2611190100-HI62500` -> 62500 */
export const strikeOf = (symbol: string): number | null => {
  const m = /HI(\d+(?:\.\d+)?)$/.exec(symbol);
  return m ? Number(m[1]) : null;
};

/** `BTC2611190100` -> `BTC` */
export const assetOf = (event: string): string => /^[A-Z]+/.exec(event)?.[0] ?? event;

/** A piece of the question on a proof card. `em` marks the asset and the levels, which the card sets in weight. */
export interface Part {
  text: string;
  em?: boolean;
}

export interface CallQuestion {
  kind: BetKind;
  parts: Part[];
  /** The same sentence as plain text, for the picture. */
  text: string;
  /** The result in the product's words. */
  result: string;
}

/**
 * The question a revealed call asked, from what is on Solana only: the bet id (which carries the product, see
 * `kindOfBetId`), the event and the two committed symbols. For a falling parlay the condition symbol is the higher strike;
 * for a range or a breakout the condition is the lower strike and the target the higher one.
 */
export function callQuestion(call: { betId: string; event: string; condition: string; target: string; outcome: 0 | 1 }): CallQuestion {
  const kind = kindOfBetId(call.betId);
  const level = (symbol: string): Part => {
    const s = strikeOf(symbol);
    return { text: s !== null ? money(s) : symbol, em: true };
  };
  // In the app's own word for it (Bitcoin), as everywhere else, not the exchange's code (BTC).
  const asset: Part = { text: assetLabel({ title: '', ticker: call.event }), em: true };
  const c = level(call.condition);
  const t = level(call.target);
  const won = call.outcome === 1;
  let parts: Part[];
  let result: string;
  if (kind.product === 'range') {
    parts = [{ text: 'Will ' }, asset, { text: ' finish between ' }, c, { text: ' and ' }, t, { text: '?' }];
    result = won ? 'Finished inside' : 'Finished outside';
  } else if (kind.product === 'breakout') {
    parts = [{ text: 'Will ' }, asset, { text: ' finish outside ' }, c, { text: ' to ' }, t, { text: '?' }];
    result = won ? 'Finished outside' : 'Finished inside';
  } else if (kind.direction === 'down') {
    parts = [{ text: 'Given ' }, asset, { text: ' stays under ' }, c, { text: ', will it fall below ' }, t, { text: '?' }];
    result = won ? 'Target reached' : 'Fell short';
  } else {
    parts = [{ text: 'Given ' }, asset, { text: ' at ' }, c, { text: ' or above, will it reach ' }, t, { text: '?' }];
    result = won ? 'Target reached' : 'Fell short';
  }
  return { kind, parts, text: parts.map((p) => p.text).join(''), result };
}
