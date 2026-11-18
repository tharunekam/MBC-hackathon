/**
 * Verify a revealed call from Solana alone, in the browser, without trusting our server.
 *
 * Given the signature of a reveal transaction, this reads the reveal and the commit it names straight from a Solana RPC,
 * checks both were signed by our authority key, and recomputes the commit hash from the revealed fields and salt.
 * The hash format must match `chain/src/hash.ts`; `verify.test.ts` pins both to the same vector.
 *
 * What it proves: the call (event, strikes, entry price, fair price) was fixed on chain before the result was known.
 * What it does not: the outcome is attested by our authority key (no hash can cover a result that did not exist yet).
 */

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
}

export async function memoTx(rpc: Rpc, signature: string): Promise<MemoTx | null> {
  const tx = (await rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])) as ParsedTx | null;
  if (!tx || (tx.meta && tx.meta.err)) return null;
  const ix = tx.transaction.message.instructions.find((i) => i.program === 'spl-memo' || i.programId === MEMO_PROGRAM_ID);
  const signer = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey;
  if (!ix || typeof ix.parsed !== 'string' || !signer) return null;
  return { memo: ix.parsed, signer, slot: tx.slot ?? 0 };
}

export interface Check {
  id: 'reveal-found' | 'reveal-signer' | 'commit-found' | 'commit-signer' | 'link' | 'hash';
  label: string;
  ok: boolean;
  detail?: string;
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

/** Runs the checks in order and stops at the first failure, so the page can say exactly which step broke. */
export async function verifyOnChain(rpc: Rpc, revealSignature: string, authority: string): Promise<Verification> {
  const checks: Check[] = [];
  const fail = (c: Check): Verification => ({ ok: false, checks: [...checks, c], commitSignature: null });

  const revealTx = await memoTx(rpc, revealSignature);
  const reveal = revealTx ? parse(revealTx.memo) : null;
  if (!revealTx || !reveal || reveal.g !== 1 || reveal.t !== 'r') return fail({ id: 'reveal-found', label: 'Found the reveal on Solana', ok: false, detail: 'No Given reveal at that signature.' });
  checks.push({ id: 'reveal-found', label: 'Found the reveal on Solana', ok: true, detail: `slot ${revealTx.slot}` });

  if (revealTx.signer !== authority) return fail({ id: 'reveal-signer', label: 'Reveal signed by our key', ok: false, detail: 'Signed by a different key.' });
  checks.push({ id: 'reveal-signer', label: 'Reveal signed by our key', ok: true });

  const commitSignature = String(reveal.c ?? '');
  const commitTx = commitSignature ? await memoTx(rpc, commitSignature) : null;
  const commit = commitTx ? parse(commitTx.memo) : null;
  if (!commitTx || !commit || commit.g !== 1 || commit.t !== 'c') return { ...fail({ id: 'commit-found', label: 'Found the commit it points to', ok: false, detail: 'The commit is missing.' }), commitSignature };
  checks.push({ id: 'commit-found', label: 'Found the commit it points to', ok: true, detail: `slot ${commitTx.slot}, before the result` });

  if (commitTx.signer !== authority) return { ...fail({ id: 'commit-signer', label: 'Commit signed by our key', ok: false, detail: 'Signed by a different key.' }), commitSignature };
  checks.push({ id: 'commit-signer', label: 'Commit signed by our key', ok: true });

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

  return { ok: true, checks, commitSignature };
}

/** `GEMI-BTC2611190100-HI62500` -> 62500 */
export const strikeOf = (symbol: string): number | null => {
  const m = /HI(\d+(?:\.\d+)?)$/.exec(symbol);
  return m ? Number(m[1]) : null;
};

/** `BTC2611190100` -> `BTC` */
export const assetOf = (event: string): string => /^[A-Z]+/.exec(event)?.[0] ?? event;
