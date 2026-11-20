import type { Bet, LegRecord } from '../api/types';
import { kindOf, productName, resultOf, resultWords } from './betKind';
import type { BetKind, BetResult } from './betKind';
import { money, trunc } from './format';
import { receiptWords } from './receiptWords';

/**
 * How My bets reads a list of bets: what state each one is in, the four figures above the list, which bets were placed
 * together as a basket, and the words for each order. Pure, so each rule can be checked without a page.
 */

export type Outcome = 'open' | 'won' | 'back' | 'lost' | 'review' | 'failed' | 'unwound' | 'cashed';

export function outcomeOf(b: Pick<Bet, 'status' | 'settlement'>): Outcome {
  if (b.status === 'needs_review') return 'review';
  if (b.status === 'open' || b.status === 'unhedged' || b.status === 'placing') return 'open';
  if (b.status === 'failed') return 'failed';
  if (b.status === 'unwound') return 'unwound';
  if (b.status === 'cashed_out') return 'cashed';
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

/** This bet is finished: the market has settled it (whether or not what it paid is known yet), or it was sold back. */
export const isSettled = (b: Pick<Bet, 'status' | 'settlement'>): boolean => {
  const o = outcomeOf(b);
  return o === 'won' || o === 'lost' || o === 'back' || o === 'review' || o === 'cashed';
};

/**
 * What a bet cost. Selling a bet back takes the proceeds off its running cost, so a bet that has been cashed out, in
 * whole or in part, keeps what it cost before the first sale in `cashOut.stake`.
 */
export const stakeOf = (b: Pick<Bet, 'cost' | 'cashOut'>): number => b.cashOut?.stake ?? b.cost;

/** The tag shown on a bet: the product, and for a parlay that looks down, which way. */
export const kindLabel = (kind: BetKind): string => (kind.product === 'parlay' && kind.direction === 'down' ? `${productName(kind)} · falling` : productName(kind));

/** The words on a bet's status chip. A settled bet speaks in its product's own words. */
export function statusWords(b: Pick<Bet, 'status' | 'settlement' | 'product' | 'direction'>): string {
  const o = outcomeOf(b);
  if (o === 'open') return 'Open';
  if (o === 'review') return 'Needs review';
  if (o === 'failed') return 'Failed';
  if (o === 'unwound') return 'Unwound';
  if (o === 'cashed') return 'Cashed out';
  return resultWords(kindOf(b), o === 'back' ? 'refunded' : o);
}

/**
 * What a bet has actually paid: from the settlement, or for a bet Gemini settled without a plain yes or no, from the
 * amount entered by hand once it has been read from the account. Null while that is not known.
 */
export function realised(b: Pick<Bet, 'status' | 'settlement' | 'review' | 'cashOut'>): { payout: number; pnl: number } | null {
  // A bet sold back in part and then settled: what it paid is the sale plus the settlement, against what it first cost.
  if (b.status === 'settled' && b.settlement && b.cashOut) {
    const payout = b.cashOut.proceeds + b.settlement.payout;
    return { payout, pnl: payout - b.cashOut.stake };
  }
  if (b.status === 'cashed_out' && b.cashOut) return { payout: b.cashOut.proceeds, pnl: b.cashOut.pnl };
  if (b.status === 'settled' && b.settlement) return { payout: b.settlement.payout, pnl: b.settlement.pnl };
  if (b.status === 'needs_review' && b.review?.resolved) return { payout: b.review.resolved.payout, pnl: b.review.resolved.pnl };
  return null;
}

/**
 * Where the ladder finished, when the exchange reported it: "Finished at $63,696.06". A settled bet carries it on its
 * settlement; a bet sold back before its market settled carries it with how its call turned out, once the market has a
 * result. Null until then. It is there to show where the price ended; what the bet paid never depends on it.
 */
export function finishedWords(b: Pick<Bet, 'settlement' | 'called'>): string | null {
  const at = b.settlement?.finishedAt ?? b.called?.finishedAt;
  return typeof at === 'number' && Number.isFinite(at) ? `Finished at ${money(at)}` : null;
}

// ------------------------------------------------------------------ the call of a bet that was sold back

/**
 * How the call of a sold-back bet turned out. Selling a bet early ends the bet, not the call: the call was still right or
 * wrong, and the executor writes down which once the market has a clean result (`called`). Null until it has, and for any
 * bet that was not sold back.
 */
export function calledResult(b: Pick<Bet, 'status' | 'called'>): BetResult | null {
  if (b.status !== 'cashed_out' || !b.called) return null;
  if (b.called.conditionResolved === 'no') return 'refunded';
  return b.called.targetResolved === 'yes' ? 'won' : 'lost';
}

/**
 * How a bet's call came out, whether the bet was held to the end or sold back first: won, lost, or refunded (the first level
 * failed, so the call does not count). Null while there is no clean result.
 */
export function callResult(b: Pick<Bet, 'status' | 'settlement' | 'called'>): BetResult | null {
  if (b.status === 'cashed_out') return calledResult(b);
  return b.status === 'settled' ? resultOf(b) : null;
}

/** A call that can be revealed and scored: it has a result, and the result is a plain won or lost. */
export const canRevealCall = (b: Pick<Bet, 'status' | 'settlement' | 'called'>): boolean => {
  const r = callResult(b);
  return r === 'won' || r === 'lost';
};

/**
 * What became of the call of a bet that was sold back, in the bet's own words: still waiting on the market, came off, did
 * not, or does not count because the first level failed.
 */
export function soldCallWords(b: Pick<Bet, 'status' | 'called' | 'product' | 'direction' | 'condition' | 'target'>): string {
  const result = calledResult(b);
  if (result === null) return 'Its call can be revealed once the market settles.';
  if (result === 'refunded') return 'The market has since settled: the first level failed, so this call does not count.';
  const kind = kindOf(b);
  const won = result === 'won';
  // For a range or a breakout the two strikes are its lower and higher level.
  const [c, t] = [money(b.condition.strike), money(b.target.strike)];
  const what =
    kind.product === 'parlay'
      ? kind.direction === 'down'
        ? won
          ? `it fell below ${t}`
          : `it did not fall below ${t}`
        : won
          ? `it reached ${t}`
          : `it did not reach ${t}`
      : won === (kind.product === 'range')
        ? `it finished between ${c} and ${t}`
        : `it finished outside ${c} to ${t}`;
  return `The market has since settled: ${what}, so the call ${won ? 'came off' : 'did not come off'}.`;
}

/** How a sold-back bet was sold, from the sell orders it carries: "as two sell orders". Empty when it carries none. */
export function sellOrdersWords(b: Pick<Bet, 'legs'>): string {
  const n = b.legs.filter((l) => l.role === 'cashout').length;
  if (n === 0) return '';
  return `as ${n === 1 ? 'one sell order' : n === 2 ? 'two sell orders' : `${n} sell orders`}`;
}

/**
 * Whether "Check results" has anything to check: a bet still open or under review, or one sold back whose market has not
 * given its call a result yet. With none of those, every bet on the page is final.
 */
export const hasPending = (bets: readonly Pick<Bet, 'status' | 'settlement' | 'called'>[]): boolean =>
  bets.some((b) => {
    const o = outcomeOf(b);
    return o === 'open' || o === 'review' || (o === 'cashed' && !b.called);
  });

/** What "Check results" found, in a sentence. `called` counts sold-back bets whose call has just been given its result. */
export function checkedWords(found: { settled: number; called?: number; stillOpen: number }): string {
  const bets = (n: number) => `${n} bet${n === 1 ? '' : 's'}`;
  const called = found.called ?? 0;
  const parts: string[] = [];
  if (found.settled > 0) parts.push(`${bets(found.settled)} settled.`);
  if (called > 0) parts.push(`The market behind ${bets(called)} you sold back has settled, so ${called === 1 ? 'its call' : 'their calls'} can be revealed.`);
  if (parts.length > 0) return parts.join(' ');
  return found.stillOpen > 0 ? 'Nothing has closed yet. Markets settle a few seconds after they expire.' : 'Everything is up to date.';
}

/** What an open bet nets if it comes off, and the words for what it takes. */
export function ifItComesOff(b: Pick<Bet, 'product' | 'direction' | 'target' | 'payoffs'>): { amount: number; condition: string } {
  const kind = kindOf(b);
  if (kind.product === 'range') return { amount: b.payoffs?.ifInRange ?? b.payoffs?.ifBothHit ?? 0, condition: 'if it finishes inside' };
  if (kind.product === 'breakout') return { amount: b.payoffs?.ifOutside ?? b.payoffs?.ifBothHit ?? 0, condition: 'if it finishes outside' };
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
    t.staked += stakeOf(b);
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
  /** True once every placed leg is finished, so the net is the basket's result and no longer a running figure. */
  done: boolean;
}

export function basketSummary(entry: Extract<Entry, { type: 'basket' }>): BasketSummary {
  const placed = entry.legs.filter(isPlaced);
  const known = entry.legs.map(realised).filter((r): r is { payout: number; pnl: number } => r !== null);
  const placedAt = entry.legs.reduce((first, b) => (b.createdAt < first ? b.createdAt : first), entry.legs[0]?.createdAt ?? '');
  const settled = entry.legs.filter(isSettled).length;
  return {
    legs: entry.legs.length,
    size: Math.max(entry.size, entry.legs.length),
    placedAt,
    stake: placed.reduce((n, b) => n + stakeOf(b), 0),
    settled,
    net: known.length > 0 ? known.reduce((n, r) => n + r.pnl, 0) : null,
    // A leg under review counts as settled before what it paid is known, so the net is final only once every leg has a figure.
    done: placed.length > 0 && placed.every(isSettled) && known.length === placed.length,
  };
}

/** The name of a basket's net figure: a running one while legs are still open, the result once they are all in. */
export const netLabel = (s: Pick<BasketSummary, 'done'>): string => (s.done ? 'Net result' : 'Net so far');

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
 * condition; a range's are a YES on its lower strike and a NO on its higher one; a breakout's are a YES on its higher strike
 * and a NO on its lower one.
 */
export function orderLine(bet: Pick<Bet, 'product' | 'direction' | 'condition' | 'target'>, leg: Pick<LegRecord, 'role' | 'symbol' | 'outcome' | 'side'>): OrderLine {
  const w = receiptWords(bet);
  const strike = leg.symbol === bet.condition.symbol ? bet.condition.strike : leg.symbol === bet.target.symbol ? bet.target.strike : null;
  const side = leg.outcome === 'yes' ? 'YES' : 'NO';
  if (leg.role === 'outcome') return { label: 'Order 1', bets: `Bets ${w.first}`, side, strike };
  if (leg.role === 'hedge') return { label: 'Order 2', bets: `Bets ${w.second}`, side, strike };
  if (leg.role === 'unwind') return { label: 'Sold back', bets: 'Sells what was bought, because the bet could not be completed', side, strike };
  if (leg.role === 'cashout') return { label: 'Cashed out', bets: 'Sells this order back at the best price on offer', side, strike };
  return { label: 'Trigger', bets: leg.side === 'sell' ? 'Sold when a set price was reached' : 'Bought when a set price was reached', side, strike };
}

/** An order's id as it is shown: named, so an id as short as "1" (the local test exchange counts from one) is not left as a bare digit. */
export const orderIdWords = (orderId: string | undefined): string => (orderId ? `Order id ${trunc(orderId, 6, 4)}` : 'No order id');
