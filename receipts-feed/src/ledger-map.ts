// Maps the executor's ledger records (executor/src/ledger.ts, BetRecord) to
// receipt instructions. Only the fields used here are declared, so the
// executor can add to its records without breaking the recorder.
import { createHash } from 'node:crypto';
import type { RecordCallArgs, SettleCallArgs } from './codec.ts';

export interface LedgerLeg {
  clientOrderId: string;
  orderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  outcome: 'yes' | 'no';
  quantityFilled: number;
  avgPrice: number | null;
}

export interface LedgerBet {
  id: string;
  user: string;
  createdAt: string;
  eventTicker: string;
  expiry: string | null;
  condition: { symbol: string; strike: number };
  target: { symbol: string; strike: number };
  status: 'placing' | 'open' | 'unhedged' | 'unwound' | 'failed' | 'settled';
  legs: LedgerLeg[];
  payoffs?: { stake: number; ifBothHit: number; conditionalPrice: number | null; hedged: boolean };
  settlement?: { conditionResolved: 'yes' | 'no'; targetResolved: 'yes' | 'no'; payout: number };
}

const micro = (dollars: number): bigint => BigInt(Math.round(dollars * 1e6));
const unix = (iso: string | null): bigint => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? BigInt(Math.floor(ms / 1000)) : 0n;
};

/**
 * SHA-256 over the bet's Gemini orders (tags, order ids and fills). Anyone
 * holding the account's order history can recompute it from the same fields.
 */
export function evidenceHash(bet: LedgerBet): string {
  const legs = bet.legs.map((l) => [
    l.clientOrderId, l.orderId ?? null, l.symbol, l.side, l.outcome, l.quantityFilled, l.avgPrice,
  ]);
  return createHash('sha256').update(JSON.stringify(legs)).digest('hex');
}

export type Mapped<T> = { ok: true; args: T } | { ok: false; reason: string };

/** A bet becomes a receipt once it holds a position: open, unhedged or already settled. */
export function recordArgs(bet: LedgerBet, caller: string): Mapped<RecordCallArgs> {
  if (bet.status !== 'open' && bet.status !== 'unhedged' && bet.status !== 'settled') {
    return { ok: false, reason: `status is ${bet.status}` };
  }
  const p = bet.payoffs;
  if (!p || !(p.stake > 0) || p.conditionalPrice === null) return { ok: false, reason: 'no filled position' };
  const price = Math.round(p.conditionalPrice * 1e6);
  if (!(price > 0 && price <= 1_000_000)) {
    return { ok: false, reason: `price ${p.conditionalPrice} per $1 is outside (0, 1]` };
  }
  if (Buffer.byteLength(bet.id) > 16) return { ok: false, reason: 'bet id is longer than 16 bytes' };
  return {
    ok: true,
    args: {
      betId: bet.id,
      caller,
      handle: bet.user.slice(0, 24),
      eventTicker: bet.eventTicker,
      conditionSymbol: bet.condition.symbol,
      targetSymbol: bet.target.symbol,
      conditionStrike: micro(bet.condition.strike),
      targetStrike: micro(bet.target.strike),
      stake: micro(p.stake),
      price,
      payoutIfHit: micro(p.stake + p.ifBothHit),
      hedged: p.hedged,
      placedAt: unix(bet.createdAt),
      expiry: unix(bet.expiry),
      evidence: evidenceHash(bet),
    },
  };
}

export function settleArgs(bet: LedgerBet): SettleCallArgs | null {
  if (bet.status !== 'settled' || !bet.settlement) return null;
  return {
    betId: bet.id,
    conditionHeld: bet.settlement.conditionResolved === 'yes',
    targetHit: bet.settlement.targetResolved === 'yes',
    payout: micro(bet.settlement.payout),
  };
}
