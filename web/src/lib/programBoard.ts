/**
 * The leaderboard as the `given_receipts` program itself holds it, read by the browser from a Solana node.
 *
 * Every reveal that goes through the program is added to one small account per player (`CallerStats` in
 * receipts-program/programs/given_receipts/src/state.rs). Asking a node for those accounts gives a board our server
 * had no part in: one `getProgramAccounts` request, filtered to that kind of account and to the key that wrote them.
 *
 * What it can show: totals only (calls, hits, summed edge), and only for reveals that went through the program. A call
 * recorded as a Memo alone is on the server's board and not in these accounts.
 *
 * There is no Solana library in the web package, and this does not need one: the record is a few fixed-width numbers
 * and one short string. `programBoard.test.ts` pins the decoder to bytes captured from devnet.
 *
 * `CallerStats` as Anchor (Borsh) writes it, little-endian:
 *
 *   offset  bytes  field
 *   0       8      discriminator: the first 8 bytes of sha256("account:CallerStats")
 *   8       32     authority, the key that wrote the record
 *   40      4      length of the handle, u32
 *   44      n      handle, UTF-8, n <= 32
 *   44+n    4      calls, u32
 *   48+n    4      hits, u32
 *   52+n    8      edge_sum, i64, in millionths (1.00 is 1_000_000)
 *   60+n    8      last_revealed_at, i64, unix seconds on the chain's clock
 *   68+n    1      bump
 *
 * The account is sized for the longest handle, so a shorter one leaves unused zero bytes after the bump.
 */
import type { LeaderboardRow } from '../api/types';
import type { Rpc } from './verify';

/** Edge is kept per $1 in millionths, the same unit as `PRICE_ONE` in the program. */
export const PRICE_ONE = 1_000_000;
/** A handle is also an account seed, and a seed holds at most 32 bytes. */
export const MAX_HANDLE_BYTES = 32;

/**
 * sha256("account:CallerStats"), first 8 bytes. Written out because the browser's sha256 is async and this is needed
 * to build a filter; the test recomputes it from the name.
 */
export const STATS_DISCRIMINATOR = Uint8Array.of(253, 107, 155, 198, 163, 63, 205, 21);

const HEAD = 8 + 32 + 4; // discriminator, authority, handle length
const TAIL = 4 + 4 + 8 + 8 + 1; // calls, hits, edge_sum, last_revealed_at, bump

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 as Solana writes keys: the bytes as one big number in base 58, with a `1` for each leading zero byte. */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  for (; n > 0n; n /= 58n) out = B58.charAt(Number(n % 58n)) + out;
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** One player's running score under one authority, exactly as the account holds it. */
export interface CallerStats {
  authority: string;
  handle: string;
  calls: number;
  hits: number;
  /** Sum of (1 if the call hit, else 0) minus its fair price, in millionths. */
  edgeSum: number;
  /** Unix seconds, from Solana's clock at the latest reveal. */
  lastRevealedAt: number;
}

/**
 * Reads one account's bytes. Null for anything that is not a whole `CallerStats` record: another kind of account, data
 * cut short, a handle longer than the program allows, or more hits than calls (the program cannot write that).
 */
export function decodeCallerStats(data: Uint8Array): CallerStats | null {
  if (data.length < HEAD + TAIL) return null;
  if (!STATS_DISCRIMINATOR.every((b, i) => data[i] === b)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = view.getUint32(40, true);
  if (n > MAX_HANDLE_BYTES || data.length < HEAD + n + TAIL) return null;
  let handle: string;
  try {
    handle = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(HEAD, HEAD + n));
  } catch {
    return null;
  }
  const at = HEAD + n;
  const calls = view.getUint32(at, true);
  const hits = view.getUint32(at + 4, true);
  if (hits > calls) return null;
  return {
    authority: base58(data.subarray(8, 40)),
    handle,
    calls,
    hits,
    // Both fit a JavaScript number exactly: a sum this size would need billions of calls, and the time is seconds.
    edgeSum: Number(view.getBigInt64(at + 8, true)),
    lastRevealedAt: Number(view.getBigInt64(at + 16, true)),
  };
}

/** For `getProgramAccounts`: every score account one authority has written. The node compares base58 text to bytes. */
export const statsFilters = (authority: string) => [
  { memcmp: { offset: 0, bytes: base58(STATS_DISCRIMINATOR) } },
  { memcmp: { offset: 8, bytes: authority } },
];

function bytesOfBase64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * The score accounts in one `getProgramAccounts` answer. The node was asked to filter, but the answer is checked
 * again here: an account counts only if the program owns it and the record names the authority that was asked for.
 */
export function statsFromAnswer(answer: unknown, program: string, authority: string): CallerStats[] {
  if (!Array.isArray(answer)) throw new Error('The Solana node sent an answer this page cannot read.');
  const out: CallerStats[] = [];
  for (const item of answer as Array<{ account?: { owner?: unknown; data?: unknown } } | null>) {
    const account = item?.account;
    if (!account || account.owner !== program) continue;
    const data: unknown[] = Array.isArray(account.data) ? account.data : [];
    if (typeof data[0] !== 'string' || data[1] !== 'base64') continue;
    const bytes = bytesOfBase64(data[0]);
    const stats = bytes && decodeCallerStats(bytes);
    if (stats && stats.authority === authority) out.push(stats);
  }
  return out;
}

/** A row of the program's board. The same figures as the server's row, without the individual calls. */
export interface ProgramRow {
  handle: string;
  calls: number;
  hits: number;
  hitRate: number;
  /** Summed edge per $1, e.g. 0.59. */
  edge: number;
  /** ISO time of the player's latest reveal. */
  lastRevealedAt: string;
}

/**
 * Turns score accounts into a board, the way the server builds its own: a handle's accounts under different trusted
 * keys are added together, players with fewer than `minCalls` calls are held back, and the order is edge first, then
 * number of calls, then handle.
 */
export function boardRows(stats: CallerStats[], minCalls = 1): ProgramRow[] {
  const by = new Map<string, { calls: number; hits: number; edgeSum: number; last: number }>();
  for (const s of stats) {
    const cur = by.get(s.handle) ?? { calls: 0, hits: 0, edgeSum: 0, last: 0 };
    cur.calls += s.calls;
    cur.hits += s.hits;
    cur.edgeSum += s.edgeSum;
    cur.last = Math.max(cur.last, s.lastRevealedAt);
    by.set(s.handle, cur);
  }
  return [...by.entries()]
    .filter(([, v]) => v.calls >= Math.max(1, minCalls))
    .map(([handle, v]) => ({ handle, calls: v.calls, hits: v.hits, hitRate: v.hits / v.calls, edge: v.edgeSum / PRICE_ONE, lastRevealedAt: new Date(v.last * 1000).toISOString() }))
    .sort((a, b) => b.edge - a.edge || b.calls - a.calls || a.handle.localeCompare(b.handle));
}

/**
 * Reads the board from a Solana node. One request per trusted key, one after another: public nodes turn away bursts
 * of `getProgramAccounts`, and there are only ever a few keys.
 */
export async function readProgramBoard(rpc: Rpc, program: string, authorities: string[], minCalls = 1): Promise<ProgramRow[]> {
  const stats: CallerStats[] = [];
  for (const authority of new Set(authorities)) {
    const answer = await rpc('getProgramAccounts', [program, { encoding: 'base64', commitment: 'confirmed', filters: statsFilters(authority) }]);
    stats.push(...statsFromAnswer(answer, program, authority));
  }
  return boardRows(stats, minCalls);
}

export interface BoardComparison {
  /** Players on either board. */
  total: number;
  /** Players with the same calls, hits and edge on both. */
  same: number;
  /** Handles whose figures differ, or that are on one board only. */
  differing: string[];
}

/**
 * Lines the program's rows up against the server's, by handle. The server rounds edge to four decimals and the
 * program keeps six, so edges within one unit of the server's last digit count as the same.
 */
export function compareBoards(program: ProgramRow[], server: Pick<LeaderboardRow, 'handle' | 'calls' | 'hitRate' | 'edge'>[]): BoardComparison {
  const theirs = new Map(server.map((r) => [r.handle, r]));
  const differing: string[] = [];
  let same = 0;
  for (const p of program) {
    const s = theirs.get(p.handle);
    theirs.delete(p.handle);
    if (s && s.calls === p.calls && Math.round(s.hitRate * s.calls) === p.hits && Math.abs(s.edge - p.edge) <= 0.0001 + 1e-9) same++;
    else differing.push(p.handle);
  }
  differing.push(...theirs.keys());
  return { total: same + differing.length, same, differing };
}

/** The comparison as one sentence for the page. At most three handles are named, so the line stays one line. */
export function comparisonLine(c: BoardComparison): string {
  const head = `Matches the table above for ${c.same} of ${c.total} player${c.total === 1 ? '' : 's'}.`;
  if (c.differing.length === 0) return head;
  const named = c.differing.slice(0, 3).join(', ');
  const more = c.differing.length - 3;
  return `${head} Different or on one side only: ${named}${more > 0 ? ` and ${more} more` : ''}.`;
}

/** What to tell a person when the read fails. Public devnet nodes often rate-limit this method, so that case is named. */
export function readProblem(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/\b429\b|too many requests|rate limit/i.test(message)) return 'The Solana node is turning requests away because it is busy. Wait a few seconds and try again.';
  // What fetch throws when the node cannot be reached at all.
  if (error instanceof TypeError) return 'Could not reach the Solana node. Check your connection and try again.';
  return message ? `The Solana node could not answer: ${message}` : 'The Solana node could not answer. Try again.';
}

export const explorerAddress = (address: string, cluster: 'devnet' | 'mainnet-beta' = 'devnet') =>
  `https://explorer.solana.com/address/${address}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
