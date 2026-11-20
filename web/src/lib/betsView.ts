import type { Bet, LegRecord } from '../api/types';
import { kindOf, productName, resultOf, resultWords } from './betKind';
import type { BetKind } from './betKind';
import { money } from './format';
import { receiptWords } from './receiptWords';

/**
 * How My bets reads a list of bets: what state each one is in, the four figures above the list, which bets were placed
 * together as a basket, and the words for each order. Pure, so each rule can be checked without a page.
 */

export type Outcome = 'open' | 'won' | 'back' | 'lost' | 'review' | 'failed' | 'unwound';

export function outcomeOf(b: Pick<Bet, 'status' | 'settlement'>): Outcome {
  if (b.status === 'needs_review') return 'review';
  if (b.status === 'open' || b.status === 'unhedged' || b.status === 'placing') return 'open';
  if (b.status === 'failed') return 'failed';
  if (b.status === 'unwound') return 'unwound';
  const r = resultOf(b);
  if (r === 'refunded') return 'back';
  if (r === 'won') return 'won';
  if (r === 'lost') return 'lost';
  return 'failed';
}

/** A bet that put money at stake. A failed or unwound bet did not, so it is left out of the figures. */
export const isPlaced = (b: Pick<Bet, 'status' | 'settlement'>): boolean => {
  const o = outcomeOf(b);
  return o !== 'failed' && o !== 'unwound';
};

/** The market has finished with this bet, whether or not what it paid is known yet. */
export const isSettled = (b: Pick<Bet, 'status' | 'settlement'>): boolean => {
  const o = outcomeOf(b);
  return o === 'won' || o === 'lost' || o === 'back' || o === 'review';
};

/** The tag shown on a bet: the product, and for a parlay that looks down, which way. */
export const kindLabel = (kind: BetKind): string => (kind.product === 'parlay' && kind.direction === 'down' ? `${productName(kind)} · falling` : productName(kind));

/** The words on a bet's status chip. A settled bet speaks in its product's own words. */
export function statusWords(b: Pick<Bet, 'status' | 'settlement' | 'product' | 'direction'>): string {
  const o = outcomeOf(b);
  if (o === 'open') return 'Open';
  if (o === 'review') return 'Needs review';
  if (o === 'failed') return 'Failed';
  if (o === 'unwound') return 'Unwound';
  return resultWords(kindOf(b), o === 'back' ? 'refunded' : o);
}

/**
 * What a bet has actually paid: from the settlement, or for a bet Gemini settled without a plain yes or no, from the
 * amount entered by hand once it has been read from the account. Null while that is not known.
 */
export function realised(b: Pick<Bet, 'status' | 'settlement' | 'review'>): { payout: number; pnl: number } | null {
  if (b.status === 'settled' && b.settlement) return { payout: b.settlement.payout, pnl: b.settlement.pnl };
  if (b.status === 'needs_review' && b.review?.resolved) return { payout: b.review.resolved.payout, pnl: b.review.resolved.pnl };
  return null;
}

/** What an open bet nets if it comes off, and the words for what it takes. */
export function ifItComesOff(b: Pick<Bet, 'product' | 'direction' | 'target' | 'payoffs'>): { amount: number; condition: string } {
  const kind = kindOf(b);
  if (kind.product === 'range') return { amount: b.payoffs?.ifInRange ?? b.payoffs?.ifBothHit ?? 0, condition: 'if it finishes inside' };
  return { amount: b.payoffs?.ifBothHit ?? 0, condition: kind.direction === 'down' ? `if it falls below ${money(b.target.strike)}` : `if it reaches ${money(b.target.strike)}` };
}

export interface Totals {
  /** Bets placed: failed and unwound ones are not counted. */
  count: number;
  open: number;
  settled: number;
  /** What the placed bets cost. */
  staked: number;
  /** What settled bets paid back, including stakes refunded. */
  returned: number;
  /** Paid back minus cost, over the bets whose result is in. */
  net: number;
}

export function summarize(bets: readonly Bet[]): Totals {
  const t: Totals = { count: 0, open: 0, settled: 0, staked: 0, returned: 0, net: 0 };
  for (const b of bets) {
    if (!isPlaced(b)) continue;
    t.count += 1;
    t.staked += b.cost;
    if (outcomeOf(b) === 'open') t.open += 1;
    if (isSettled(b)) t.settled += 1;
    const r = realised(b);
    if (r) {
      t.returned += r.payout;
      t.net += r.pnl;
    }
  }
  return t;
}

export type Entry = { type: 'single'; bet: Bet } | { type: 'basket'; id: string; name: string | null; size: number; legs: Bet[] };

/**
 * The list as it is shown: every bet on its own, except bets placed as one basket, which are gathered into a single entry
 * at the place of the first of them, their legs in the order they were placed.
 */
export function groupBets(bets: readonly Bet[]): Entry[] {
  const out: Entry[] = [];
  const baskets = new Map<string, Extract<Entry, { type: 'basket' }>>();
  for (const bet of bets) {
    const tag = bet.basket;
    if (!tag) {
      out.push({ type: 'single', bet });
      continue;
    }
    let entry = baskets.get(tag.id);
    if (!entry) {
      entry = { type: 'basket', id: tag.id, name: tag.name ?? null, size: tag.size, legs: [] };
      baskets.set(tag.id, entry);
      out.push(entry);
    }
    if (!entry.name && tag.name) entry.name = tag.name;
    entry.legs.push(bet);
  }
  for (const e of baskets.values()) e.legs.sort((a, b) => (a.basket?.index ?? 0) - (b.basket?.index ?? 0));
  return out;
}

export interface BasketSummary {
  /** Legs placed, and how many the basket asked for. */
  legs: number;
  size: number;
  placedAt: string;
  stake: number;
  settled: number;
  /** Net over the legs whose result is in; null until one is. */
  net: number | null;
}

export function basketSummary(entry: Extract<Entry, { type: 'basket' }>): BasketSummary {
  const placed = entry.legs.filter(isPlaced);
  const known = entry.legs.map(realised).filter((r): r is { payout: number; pnl: number } => r !== null);
  const placedAt = entry.legs.reduce((first, b) => (b.createdAt < first ? b.createdAt : first), entry.legs[0]?.createdAt ?? '');
  return {
    legs: entry.legs.length,
    size: Math.max(entry.size, entry.legs.length),
    placedAt,
    stake: placed.reduce((n, b) => n + b.cost, 0),
    settled: entry.legs.filter(isSettled).length,
    net: known.length > 0 ? known.reduce((n, r) => n + r.pnl, 0) : null,
  };
}

export type Filter = 'all' | 'open' | 'settled';

export const matches = (b: Bet, f: Filter): boolean => (f === 'all' ? true : f === 'open' ? outcomeOf(b) === 'open' : isSettled(b));

/** The entries a filter shows. A basket stays one entry, holding only the legs that match; one with none is left out. */
export function filterEntries(entries: readonly Entry[], f: Filter): Entry[] {
  if (f === 'all') return [...entries];
  const out: Entry[] = [];
  for (const e of entries) {
    if (e.type === 'single') {
      if (matches(e.bet, f)) out.push(e);
    } else {
      const legs = e.legs.filter((b) => matches(b, f));
      if (legs.length > 0) out.push({ ...e, legs });
    }
  }
  return out;
}

export interface OrderLine {
  /** "Order 1", "Order 2", or what a later order was for. */
  label: string;
  /** What the order bets on, in words: "Bets that it reaches $63,500". */
  bets: string;
  /** "YES" or "NO", and the strike of the contract it bought or sold. */
  side: 'YES' | 'NO';
  strike: number | null;
}

/**
 * Each order of a bet, described in its product's words. A parlay's first order is on its target and the second on its
 * condition; a range's are a YES on its lower strike and a NO on its higher one.
 */
export function orderLine(bet: Pick<Bet, 'product' | 'direction' | 'condition' | 'target'>, leg: Pick<LegRecord, 'role' | 'symbol' | 'outcome' | 'side'>): OrderLine {
  const w = receiptWords(bet);
  const strike = leg.symbol === bet.condition.symbol ? bet.condition.strike : leg.symbol === bet.target.symbol ? bet.target.strike : null;
  const side = leg.outcome === 'yes' ? 'YES' : 'NO';
  if (leg.role === 'outcome') return { label: 'Order 1', bets: `Bets ${w.first}`, side, strike };
  if (leg.role === 'hedge') return { label: 'Order 2', bets: `Bets ${w.second}`, side, strike };
  if (leg.role === 'unwind') return { label: 'Sold back', bets: 'Sells what was bought, because the bet could not be completed', side, strike };
  return { label: 'Trigger', bets: leg.side === 'sell' ? 'Sold when a set price was reached' : 'Bought when a set price was reached', side, strike };
}
