// Reads bets from the executor and maps them to what goes on chain. Only the
// fields used here are declared (see executor/src/ledger.ts, BetRecord), so the
// executor can add to its records without breaking this service.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { PRICE_ONE, type CallDetails } from './codec.ts';

export interface BetLeg {
  clientOrderId: string;
  orderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  outcome: 'yes' | 'no';
  quantityFilled: number;
  avgPrice: number | null;
}

export interface Bet {
  id: string;
  user: string;
  createdAt: string;
  eventTicker: string;
  eventTitle?: string;
  expiry: string | null;
  condition: { symbol: string; label?: string };
  target: { symbol: string; label?: string };
  /** placing | open | unhedged | unwound | failed | settled | needs_review */
  status: string;
  legs: BetLeg[];
  payoffs?: { conditionalPrice: number | null };
  offer?: { fairPrice: number | null };
  settlement?: { conditionResolved: 'yes' | 'no'; targetResolved: 'yes' | 'no' };
}

export interface BetSource {
  list(): Promise<Bet[]>;
}

/** The executor's HTTP API (`GET /bets`): the documented interface between the two services. */
export function executorSource(baseUrl: string): BetSource {
  const url = `${baseUrl.replace(/\/+$/, '')}/bets`;
  return {
    async list() {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`The executor answered ${res.status} for ${url}`);
      return ((await res.json()) as { bets?: Bet[] }).bets ?? [];
    },
  };
}

/** The executor's ledger file, for running on the same machine without its API. */
export function ledgerSource(path: string): BetSource {
  return {
    async list() {
      if (!existsSync(path)) return [];
      return (JSON.parse(readFileSync(path, 'utf8')) as { bets?: Bet[] }).bets ?? [];
    },
  };
}

/**
 * SHA-256 over the bet's Gemini orders (tags, order ids and fills). Anyone
 * holding the account's order history can recompute it from the same fields.
 */
export function evidenceHash(bet: Bet): string {
  const legs = bet.legs.map((l) => [
    l.clientOrderId, l.orderId ?? null, l.symbol, l.side, l.outcome, l.quantityFilled, l.avgPrice,
  ]);
  return createHash('sha256').update(JSON.stringify(legs)).digest('hex');
}

/**
 * Fair price when the bet was placed, micro-dollars per $1: the executor's
 * no-spread, no-fee price. If the books gave no usable one, the price actually
 * paid stands in, which can only understate the caller's edge.
 */
export function fairPriceAtEntry(bet: Bet): number | null {
  for (const price of [bet.offer?.fairPrice, bet.payoffs?.conditionalPrice]) {
    if (typeof price !== 'number') continue;
    const micro = Math.round(price * PRICE_ONE);
    if (micro > 0 && micro <= PRICE_ONE) return micro;
  }
  return null;
}

const unix = (iso: string | null): bigint => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? BigInt(Math.floor(ms / 1000)) : 0n;
};

export type Mapped<T> = { ok: true; value: T } | { ok: false; code: string; reason: string };

/** A bet can be committed once it holds a position and while its event is still open. */
export function detailsFor(bet: Bet, handle: string): Mapped<CallDetails> {
  if (bet.status !== 'open' && bet.status !== 'unhedged' && bet.status !== 'settled') {
    return { ok: false, code: 'not_filled', reason: `This bet is ${bet.status.replace('_', ' ')}, so there is no position to record.` };
  }
  const fairPrice = fairPriceAtEntry(bet);
  if (fairPrice === null) return { ok: false, code: 'no_fair_price', reason: 'This bet has no fair price at entry, so it cannot be scored.' };
  const expiry = unix(bet.expiry);
  if (expiry === 0n) return { ok: false, code: 'no_expiry', reason: 'This bet\'s event has no closing time, so it cannot be scored.' };
  const tooLong = [[bet.id, 16], [bet.eventTicker, 32], [bet.condition.symbol, 64], [bet.target.symbol, 64]] as const;
  if (tooLong.some(([s, max]) => s.length === 0 || Buffer.byteLength(s) > max)) {
    return { ok: false, code: 'bad_bet', reason: 'This bet has an id or symbol the record cannot hold.' };
  }
  return {
    ok: true,
    value: {
      betId: bet.id,
      handle,
      eventTicker: bet.eventTicker,
      conditionSymbol: bet.condition.symbol,
      targetSymbol: bet.target.symbol,
      fairPrice,
      placedAt: unix(bet.createdAt),
      expiry,
      evidence: evidenceHash(bet),
    },
  };
}
