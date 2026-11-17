// Turns decoded program events into the feed's JSON and the leaderboard.
import { decodeEvent } from './codec.ts';
import type { Receipt } from './store.ts';

const usd = (micro: bigint): number => Number(micro) / 1e6;
const unix = (v: bigint): number => Number(v);

/** Decoder for the feed server: JSON-safe fields, dollars as numbers. */
export function decodeReceipt(raw: Buffer): Record<string, unknown> | null {
  let e;
  try {
    e = decodeEvent(raw);
  } catch {
    return null; // truncated or foreign data: keep the raw bytes, skip scoring
  }
  if (!e) return null;
  if (e.type === 'CallRecorded') {
    return {
      type: e.type,
      seq: Number(e.seq),
      betId: e.betId,
      caller: e.caller,
      handle: e.handle,
      eventTicker: e.eventTicker,
      conditionSymbol: e.conditionSymbol,
      targetSymbol: e.targetSymbol,
      conditionStrike: usd(e.conditionStrike),
      targetStrike: usd(e.targetStrike),
      stake: usd(e.stake),
      price: e.price / 1e6,
      payoutIfHit: usd(e.payoutIfHit),
      hedged: e.hedged,
      placedAt: unix(e.placedAt),
      expiry: unix(e.expiry) || null,
      evidence: e.evidence,
      recordedAt: unix(e.recordedAt),
    };
  }
  return {
    type: e.type,
    seq: Number(e.seq),
    betId: e.betId,
    caller: e.caller,
    handle: e.handle,
    conditionHeld: e.conditionHeld,
    targetHit: e.targetHit,
    stake: usd(e.stake),
    payout: usd(e.payout),
    pnl: usd(e.pnl),
    settledAt: unix(e.settledAt),
  };
}

/**
 * hit     condition held and the target hit
 * miss    condition held, target missed
 * refund  condition failed (a hedged call gets its stake back)
 */
export type Outcome = 'hit' | 'miss' | 'refund';

export interface Call {
  betId: string;
  seq: number;
  caller: string;
  handle: string;
  eventTicker: string;
  conditionSymbol: string;
  targetSymbol: string;
  conditionStrike: number;
  targetStrike: number;
  stake: number;
  price: number;
  payoutIfHit: number;
  hedged: boolean;
  placedAt: number;
  expiry: number | null;
  recordTx: string;
  status: 'open' | 'settled';
  outcome: Outcome | null;
  payout: number | null;
  pnl: number | null;
  settledAt: number | null;
  settleTx: string | null;
}

export interface LeaderboardRow {
  rank: number;
  caller: string;
  handle: string;
  calls: number;
  open: number;
  hits: number;
  misses: number;
  refunds: number;
  /** Dollars staked across all calls, open and settled. */
  staked: number;
  /** Realised profit across settled calls. */
  pnl: number;
  /** pnl over the stake of settled calls; null until one settles. */
  roi: number | null;
  /** hits / (hits + misses); refunds do not count either way. */
  hitRate: number | null;
}

export interface Board {
  leaderboard: LeaderboardRow[];
  /** Most recent first. */
  calls: Call[];
  totals: { calls: number; open: number; settled: number; staked: number; pnl: number };
}

const round = (x: number): number => Math.round(x * 1e6) / 1e6;

export function buildCalls(receipts: Receipt[]): Call[] {
  const calls = new Map<string, Call>();
  // Records first: Streams batches can arrive out of order across restarts.
  for (const r of receipts) {
    const d = r.decoded;
    if (d?.type !== 'CallRecorded') continue;
    const betId = d.betId as string;
    if (calls.has(betId)) continue;
    calls.set(betId, {
      betId,
      seq: d.seq as number,
      caller: d.caller as string,
      handle: d.handle as string,
      eventTicker: d.eventTicker as string,
      conditionSymbol: d.conditionSymbol as string,
      targetSymbol: d.targetSymbol as string,
      conditionStrike: d.conditionStrike as number,
      targetStrike: d.targetStrike as number,
      stake: d.stake as number,
      price: d.price as number,
      payoutIfHit: d.payoutIfHit as number,
      hedged: d.hedged as boolean,
      placedAt: d.placedAt as number,
      expiry: d.expiry as number | null,
      recordTx: r.signature,
      status: 'open',
      outcome: null,
      payout: null,
      pnl: null,
      settledAt: null,
      settleTx: null,
    });
  }
  for (const r of receipts) {
    const d = r.decoded;
    if (d?.type !== 'CallSettled') continue;
    const call = calls.get(d.betId as string);
    if (!call || call.status === 'settled') continue;
    call.status = 'settled';
    call.outcome = !d.conditionHeld ? 'refund' : d.targetHit ? 'hit' : 'miss';
    call.payout = d.payout as number;
    call.pnl = d.pnl as number;
    call.settledAt = d.settledAt as number;
    call.settleTx = r.signature;
  }
  return [...calls.values()].sort((a, b) => b.seq - a.seq);
}

export function scoreLeaderboard(receipts: Receipt[]): Board {
  const calls = buildCalls(receipts);
  const rows = new Map<string, LeaderboardRow & { settledStake: number }>();
  for (const c of calls) {
    const key = `${c.caller}|${c.handle}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        rank: 0, caller: c.caller, handle: c.handle, calls: 0, open: 0, hits: 0, misses: 0, refunds: 0,
        staked: 0, pnl: 0, roi: null, hitRate: null, settledStake: 0,
      };
      rows.set(key, row);
    }
    row.calls++;
    row.staked += c.stake;
    if (c.status === 'open') {
      row.open++;
      continue;
    }
    row.settledStake += c.stake;
    row.pnl += c.pnl ?? 0;
    if (c.outcome === 'hit') row.hits++;
    else if (c.outcome === 'miss') row.misses++;
    else row.refunds++;
  }

  const leaderboard = [...rows.values()]
    .map(({ settledStake, ...row }) => ({
      ...row,
      staked: round(row.staked),
      pnl: round(row.pnl),
      roi: settledStake > 0 ? round(row.pnl / settledStake) : null,
      hitRate: row.hits + row.misses > 0 ? round(row.hits / (row.hits + row.misses)) : null,
    }))
    .sort(
      (a, b) =>
        b.pnl - a.pnl ||
        (b.hitRate ?? -1) - (a.hitRate ?? -1) ||
        b.calls - a.calls ||
        a.handle.localeCompare(b.handle),
    )
    .map((row, i) => ({ ...row, rank: i + 1 }));

  const settled = calls.filter((c) => c.status === 'settled');
  return {
    leaderboard,
    calls,
    totals: {
      calls: calls.length,
      open: calls.length - settled.length,
      settled: settled.length,
      staked: round(calls.reduce((s, c) => s + c.stake, 0)),
      pnl: round(settled.reduce((s, c) => s + (c.pnl ?? 0), 0)),
    },
  };
}
