// Turns decoded program events into JSON and into the leaderboard. Shapes
// follow web/src/api/types.ts (LeaderboardRow, LeaderboardResponse).
import { decodeEvent } from './codec.ts';
import type { Receipt } from './store.ts';

const MICRO = 1e6;
const iso = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();

/** Decoder for the service: JSON-safe fields, prices and edge as plain numbers. */
export function decodeReceipt(raw: Buffer): Record<string, unknown> | null {
  let e;
  try {
    e = decodeEvent(raw);
  } catch {
    return null; // truncated or foreign data: keep the raw bytes, skip scoring
  }
  if (!e) return null;
  if (e.type === 'CallCommitted') {
    return { type: e.type, seq: Number(e.seq), commit: e.commit, committedAt: Number(e.committedAt) };
  }
  const d = e.details;
  return {
    type: e.type,
    seq: Number(e.seq),
    commit: e.commit,
    committedAt: Number(e.committedAt),
    revealedAt: Number(e.revealedAt),
    targetHit: e.targetHit,
    edge: Number(e.edge) / MICRO,
    betId: d.betId,
    handle: d.handle,
    eventTicker: d.eventTicker,
    conditionSymbol: d.conditionSymbol,
    targetSymbol: d.targetSymbol,
    fairPrice: d.fairPrice / MICRO,
    placedAt: Number(d.placedAt),
    expiry: Number(d.expiry),
    evidence: d.evidence,
  };
}

export interface LeaderboardRow {
  rank: number;
  handle: string;
  /** Revealed calls. Calls whose condition failed are never revealed, so never counted. */
  calls: number;
  /** Sum over calls of (1 if the target hit, else 0) minus the fair price at entry. */
  edge: number;
  hitRate: number;
  lastRevealedAt: string;
}

export interface LeaderboardResponse {
  asOf: string;
  /** Handles with fewer revealed calls than this are left off. */
  minCalls: number;
  /** 'quicknode-stream' when every call counted was delivered by the Stream; 'rpc' if any had to be read back from RPC. */
  source: 'quicknode-stream' | 'rpc';
  rows: LeaderboardRow[];
  /** Everything the program has emitted, whether or not it made the table. */
  totals: { committed: number; revealed: number; handles: number };
}

export interface LeaderboardOptions {
  minCalls?: number;
  now?: () => Date;
}

/**
 * Ranks handles by total edge. Stake, payout and profit are not on chain and
 * play no part: the table scores judgement, not size.
 */
export function buildLeaderboard(receipts: Receipt[], opts: LeaderboardOptions = {}): LeaderboardResponse {
  const minCalls = opts.minCalls ?? 3;
  const commits = new Set<string>();
  const revealed = new Map<string, Receipt>();
  for (const r of receipts) {
    const d = r.decoded;
    if (!d || typeof d.commit !== 'string') continue;
    commits.add(d.commit);
    if (d.type === 'CallRevealed' && !revealed.has(d.commit)) revealed.set(d.commit, r);
  }

  interface Tally { handle: string; calls: number; hits: number; edgeMicro: number; last: number; viaRpc: boolean }
  const byHandle = new Map<string, Tally>();
  for (const r of revealed.values()) {
    const d = r.decoded as { handle: string; targetHit: boolean; edge: number; revealedAt: number };
    const t = byHandle.get(d.handle) ?? { handle: d.handle, calls: 0, hits: 0, edgeMicro: 0, last: 0, viaRpc: false };
    t.calls++;
    if (d.targetHit) t.hits++;
    t.edgeMicro += Math.round(d.edge * MICRO);
    t.last = Math.max(t.last, d.revealedAt);
    t.viaRpc ||= r.source === 'rpc';
    byHandle.set(d.handle, t);
  }

  const shown = [...byHandle.values()]
    .filter((t) => t.calls >= minCalls)
    .sort((a, b) => b.edgeMicro - a.edgeMicro || b.hits / b.calls - a.hits / a.calls || b.calls - a.calls || a.handle.localeCompare(b.handle));

  return {
    asOf: (opts.now?.() ?? new Date()).toISOString(),
    minCalls,
    source: shown.some((t) => t.viaRpc) ? 'rpc' : 'quicknode-stream',
    rows: shown.map((t, i) => ({
      rank: i + 1,
      handle: t.handle,
      calls: t.calls,
      edge: t.edgeMicro / MICRO,
      hitRate: t.hits / t.calls,
      lastRevealedAt: iso(t.last),
    })),
    totals: { committed: commits.size, revealed: revealed.size, handles: byHandle.size },
  };
}
