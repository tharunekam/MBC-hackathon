import type { Bet, LegRecord } from '../api/types';
import { isUnconfirmed, kindOf, productName, resultOf, resultWords } from './betKind';
import type { BetKind, BetResult } from './betKind';
import { edgeText } from './callWords';
import { cents, dateTime, money, trunc, usd } from './format';
import { receiptWords } from './receiptWords';

/**
 * How My bets reads a list of bets: what state each one is in, the four figures above the list, which bets were placed
 * together as a basket, and the words for each order. Pure, so each rule can be checked without a page.
 */

/**
 * Where a bet stands. `unprotected` is a bet whose first order is in and whose second is not (status `unhedged`): money is at
 * risk that the bet was meant to cover, and it is told as that, never as an ordinary open bet. `unconfirmed` is a bet with an
 * order that was sent and has no confirmed result: it may be partly or fully in place, nothing more is sent for it, and the
 * person is told to look in their exchange account. `placing` is a bet the executor has not finished placing. `unwound` is a
 * bet whose second order could not be placed and whose first was sold back: a real loss, and a finished bet.
 */
export type Outcome = 'open' | 'unprotected' | 'unconfirmed' | 'placing' | 'won' | 'back' | 'lost' | 'review' | 'failed' | 'unwound' | 'cashed';

// Where the predicate lives so the receipt can use it too: betKind.ts is imported by both.
export { isUnconfirmed } from './betKind';

export function outcomeOf(b: Pick<Bet, 'status' | 'settlement'> & Partial<Pick<Bet, 'legs' | 'note'>>): Outcome {
  if (b.status === 'needs_review') return 'review';
  if (b.status === 'open') return 'open';
  if (b.status === 'unhedged') return isUnconfirmed(b) ? 'unconfirmed' : 'unprotected';
  if (b.status === 'placing') return 'placing';
  if (b.status === 'failed') return 'failed';
  if (b.status === 'unwound') return 'unwound';
  if (b.status === 'cashed_out') return 'cashed';
  const r = resultOf(b);
  if (r === 'refunded') return 'back';
  if (r === 'won') return 'won';
  if (r === 'lost') return 'lost';
  return 'failed';
}

/**
 * A bet that put money at stake. A failed bet did not, so it is left out of the figures. An unwound bet did: it bought and sold
 * back at a loss, and that loss is real money, so it counts.
 */
export const isPlaced = (b: Pick<Bet, 'status' | 'settlement'> & Partial<Pick<Bet, 'legs' | 'note'>>): boolean => outcomeOf(b) !== 'failed';

/** This bet is finished: the market has settled it (whether or not what it paid is known yet), or it was sold back. */
export const isSettled = (b: Pick<Bet, 'status' | 'settlement'> & Partial<Pick<Bet, 'legs' | 'note'>>): boolean => {
  const o = outcomeOf(b);
  return o === 'won' || o === 'lost' || o === 'back' || o === 'review' || o === 'cashed' || o === 'unwound';
};

/** This bet can still change: it is open, only half placed, not confirmed, or still being placed. */
export const isOpen = (b: Pick<Bet, 'status' | 'settlement'> & Partial<Pick<Bet, 'legs' | 'note'>>): boolean => {
  const o = outcomeOf(b);
  return o === 'open' || o === 'unprotected' || o === 'unconfirmed' || o === 'placing';
};

/**
 * The stake of a bet, as the person knows it: the amount they entered, so three $10 bets read $10.00 and not the $9.99 or
 * $10.00 their orders happened to cost. When the market could not fill that much the executor placed a smaller bet and says
 * so (`stakeReduced`); then the entered figure would be false, and what the orders cost is the stake. Selling a bet back takes
 * the proceeds off its running cost, so a bet that has been cashed out keeps what it cost before the first sale in `cashOut.stake`.
 */
export const stakeOf = (b: Pick<Bet, 'cost' | 'cashOut' | 'requestedStake' | 'stakeReduced'> & Partial<Pick<Bet, 'status' | 'legs'>>): number => {
  // An unwound bet's stake is what its first order really bought: the stake that was asked for was never all spent.
  if (b.status === 'unwound') return boughtOf(b);
  const cost = b.cashOut?.stake ?? b.cost;
  if (b.stakeReduced || !(b.requestedStake > 0)) return cost;
  return b.requestedStake;
};

/**
 * What a bet's buy orders cost, fees included, from its orders. The executor's `cost` is what is left once sell orders have been
 * taken off, so a bet that was sold straight back has a small cost and a much larger amount bought. Never less than `cost`.
 */
export function boughtOf(b: Pick<Bet, 'cost'> & Partial<Pick<Bet, 'legs'>>): number {
  const spent = (b.legs ?? []).reduce((sum, l) => (l.side === 'buy' && l.quantityFilled > 0 && l.avgPrice !== null && l.avgPrice !== undefined ? sum + l.quantityFilled * l.avgPrice + (l.fee ?? 0) : sum), 0);
  return Math.max(spent, b.cost, 0);
}

/** The tag shown on a bet: the product, and for Stake Back which way it goes. */
export const kindLabel = (kind: BetKind): string => (kind.product === 'parlay' ? `${productName(kind)} ${kind.direction === 'down' ? 'down' : 'up'}` : productName(kind));

/** The words on a bet's status chip. A finished bet reads Won, Lost or Stake back, whatever the product. */
export function statusWords(b: Pick<Bet, 'status' | 'settlement'> & Partial<Pick<Bet, 'legs' | 'note'>>): string {
  const o = outcomeOf(b);
  if (o === 'open') return 'Open';
  // Said by what is true: one of the two orders went through. (Not "protected": that word promises what a bet cannot.)
  if (o === 'unprotected') return 'Half placed';
  if (o === 'unconfirmed') return 'Not confirmed';
  if (o === 'placing') return 'Being placed';
  if (o === 'review') return 'Being checked';
  if (o === 'failed') return 'Not placed';
  if (o === 'unwound') return 'Sold back';
  if (o === 'cashed') return 'Cashed out';
  return resultWords(o === 'back' ? 'refunded' : o);
}

/**
 * What a bet has actually paid: from the settlement, or for a bet Gemini settled without a plain yes or no, from the
 * amount entered by hand once it has been read from the account. Null while that is not known. The profit or loss is worked
 * out against the stake the person sees (`stakeOf`), so a $10 bet that lost reads −$10.00 beside its $10.00 and not −$9.99.
 */
export function realised(
  b: Pick<Bet, 'status' | 'settlement' | 'review' | 'cashOut' | 'cost' | 'requestedStake' | 'stakeReduced'> & Partial<Pick<Bet, 'legs'>>,
): { payout: number; pnl: number } | null {
  const paid = (payout: number) => ({ payout, pnl: payout - stakeOf(b) });
  // A bet sold straight back, because its second order could not be placed: what its first order bought, less what it was sold
  // for, is the loss. The executor's `cost` is exactly that, so the bet returns its stake less its cost.
  if (b.status === 'unwound') return { payout: stakeOf(b) - b.cost, pnl: -b.cost };
  // A bet sold back in part and then settled: what it paid is the sale plus the settlement, against what it first cost.
  if (b.status === 'settled' && b.settlement && b.cashOut) return paid(b.cashOut.proceeds + b.settlement.payout);
  if (b.status === 'cashed_out' && b.cashOut) return paid(b.cashOut.proceeds);
  if (b.status === 'settled' && b.settlement) return paid(b.settlement.payout);
  if (b.status === 'needs_review' && b.review?.resolved) return paid(b.review.resolved.payout);
  return null;
}

/**
 * Where the price finished, when the exchange reported it: "Finished at $63,696.06". A settled bet carries it on its
 * settlement; a bet sold back before its market closed carries it with how its call turned out, once the market has a
 * result. For a range or a breakout it also says which side of the two levels that is ("Finished at $63,200, inside the
 * range"), because the status chip says only Won or Lost. Null until there is something to say. It shows where the price
 * ended; what the bet paid never depends on it.
 */
export function finishedWords(b: Pick<Bet, 'settlement' | 'called' | 'status' | 'product' | 'direction'>): string | null {
  const at = b.settlement?.finishedAt ?? b.called?.finishedAt;
  const where = typeof at === 'number' && Number.isFinite(at) ? `Finished at ${money(at)}` : null;
  const kind = kindOf(b);
  if (kind.product === 'parlay') return where;
  const result = b.status === 'cashed_out' ? calledResult(b) : b.settlement ? resultOf(b) : null;
  if (result !== 'won' && result !== 'lost') return where;
  // A range wins inside its two levels and a breakout outside them.
  const inside = (result === 'won') === (kind.product === 'range');
  const side = inside ? 'inside the range' : 'outside the range';
  return where ? `${where}, ${side}` : `Finished ${side}`;
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
 * What became of the call of a bet that was sold back, in the bet's own words: still waiting on the market, won, lost, or
 * does not count because the first level failed.
 */
export function soldCallWords(b: Pick<Bet, 'status' | 'called' | 'product' | 'direction' | 'condition' | 'target'>): string {
  const result = calledResult(b);
  if (result === null) return 'Waiting for the market to close. After that its call can be revealed.';
  if (result === 'refunded') return 'The market has closed and the first level failed, so this call does not count.';
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
  return `The market has closed: ${what}, so your call ${won ? 'won' : 'lost'}.`;
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
export const hasPending = (bets: readonly (Pick<Bet, 'status' | 'settlement' | 'called'> & Partial<Pick<Bet, 'legs' | 'note'>>)[]): boolean =>
  bets.some((b) => {
    const o = outcomeOf(b);
    return o === 'open' || o === 'unprotected' || o === 'unconfirmed' || o === 'review' || (o === 'cashed' && !b.called);
  });

/**
 * The one line under a bet whose call has been revealed: when, and the call's edge. Whether it won is not said again here: the
 * status chip and the result column carry it, and the proof of the call says where the price finished.
 */
export function revealedWords(when: string | number | null | undefined, edge: number | null | undefined): string {
  const at = dateTime(when);
  const head = `Revealed on Solana${at ? `, ${at}` : ''}`;
  return typeof edge === 'number' && Number.isFinite(edge) ? `${head} · Edge ${edgeText(edge)} per $1` : head;
}

/** What "Check results" found, in a sentence. `called` counts sold-back bets whose call has just been given its result. */
export function checkedWords(found: { settled: number; called?: number; stillOpen: number }): string {
  const bets = (n: number) => `${n} bet${n === 1 ? '' : 's'}`;
  const called = found.called ?? 0;
  const parts: string[] = [];
  if (found.settled > 0) parts.push(`${bets(found.settled)} finished.`);
  if (called > 0) parts.push(`The market behind ${bets(called)} you sold back has closed, so ${called === 1 ? 'its call' : 'their calls'} can be revealed.`);
  if (parts.length > 0) return parts.join(' ');
  return found.stillOpen > 0 ? 'Nothing has closed yet. Results arrive a few seconds after a market closes.' : 'Everything is up to date.';
}

/** What an open bet nets if it comes off, and the words for what it takes. */
export function ifItComesOff(b: Pick<Bet, 'product' | 'direction' | 'target' | 'payoffs'>): { amount: number; condition: string } {
  const kind = kindOf(b);
  if (kind.product === 'range') return { amount: b.payoffs?.ifInRange ?? b.payoffs?.ifBothHit ?? 0, condition: 'if it finishes inside' };
  if (kind.product === 'breakout') return { amount: b.payoffs?.ifOutside ?? b.payoffs?.ifBothHit ?? 0, condition: 'if it finishes outside' };
  return { amount: b.payoffs?.ifBothHit ?? 0, condition: kind.direction === 'down' ? `if it falls below ${money(b.target.strike)}` : `if it reaches ${money(b.target.strike)}` };
}

export interface Totals {
  /** Every bet in the list, so the count agrees with the filter's "All". */
  count: number;
  /** Bets that never went on (nothing was bought): in the count, left out of every figure below. */
  notPlaced: number;
  open: number;
  settled: number;
  /** What the placed bets were staked at (see `stakeOf`). */
  staked: number;
  /** What finished bets paid back, including stakes returned. */
  returned: number;
  /** Paid back minus cost, over the bets whose result is in. */
  net: number;
}

export function summarize(bets: readonly Bet[]): Totals {
  const t: Totals = { count: 0, notPlaced: 0, open: 0, settled: 0, staked: 0, returned: 0, net: 0 };
  for (const b of bets) {
    t.count += 1;
    if (!isPlaced(b)) {
      t.notPlaced += 1;
      continue;
    }
    t.staked += stakeOf(b);
    if (isOpen(b)) t.open += 1;
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

/** The name of a basket's net figure: a running one while its bets are still open, the result once they are all in. */
export const netLabel = (s: Pick<BasketSummary, 'done'>): string => (s.done ? 'Net result' : 'Net so far');

export type Filter = 'all' | 'open' | 'settled';

export const matches = (b: Bet, f: Filter): boolean => (f === 'all' ? true : f === 'open' ? isOpen(b) : isSettled(b));

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
  /** "Order 1", "Order 2", or what a later order was for ("Sold", "Sold back"). */
  label: string;
  /** What the order bets on, in words: "Bets that it reaches $63,500". */
  bets: string;
  /** "YES" or "NO", and the level it bought or sold. */
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
  if (leg.role === 'cashout') return { label: 'Sold', bets: 'Sells this order back at the best price on offer', side, strike };
  return { label: 'Trigger', bets: leg.side === 'sell' ? 'Sold when a set price was reached' : 'Bought when a set price was reached', side, strike };
}

/**
 * An order's id as it is shown: named "Exchange ID" so it is not mistaken for the "Order 1" and "Order 2" numbering, and so an
 * id as short as "1" is not left as a bare digit.
 */
export const orderIdWords = (orderId: string | undefined): string => (orderId ? `Exchange ID ${trunc(orderId, 6, 4)}` : 'No exchange ID yet');

const LEG_STATUS: Record<LegRecord['status'], string> = {
  sent: 'sent',
  filled: 'completed',
  partial: 'partly completed',
  unfilled: 'did not go through',
  resting: 'waiting for a match',
  error: 'not accepted',
  unknown: 'not confirmed',
};

/**
 * What an order did, in one line: "15.83 YES shares on $63,500 at 38¢ each", with its state when it did not go through in full.
 * An order nobody could confirm says only that: there is no quantity or price to state, and "0.00 shares" would be a claim.
 */
export function fillWords(leg: Pick<LegRecord, 'quantityFilled' | 'avgPrice' | 'status'>, line: Pick<OrderLine, 'side' | 'strike'>): string {
  if (leg.status === 'unknown') return 'Not confirmed';
  const price = leg.avgPrice !== null && Number.isFinite(leg.avgPrice) ? `${cents(leg.avgPrice)} each` : '–';
  const base = `${sharesWords(leg.quantityFilled)} ${line.side} shares${line.strike !== null ? ` on ${money(line.strike)}` : ''} at ${price}`;
  return leg.status === 'filled' ? base : `${base}, ${LEG_STATUS[leg.status] ?? leg.status}`;
}

/** A filled quantity as the person reads it: always two decimals, so 10.2 shares reads 10.20. */
export const sharesWords = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '–');

/**
 * What a bet that never went on says, and what the person can do about it. An unwound bet did cost something, and says how much.
 * Null for a bet that was placed.
 */
export function notPlacedWords(o: Outcome, bet?: Pick<Bet, 'cost'>): string | null {
  if (o === 'failed') return 'Not placed. The first order did not go through, so nothing was bought and nothing was spent. You can place the bet again.';
  if (o === 'unwound') {
    const lost = bet && Math.round(bet.cost * 100) > 0 ? ` It cost you ${usd(bet.cost)}.` : '';
    return `The second order could not be placed, so the first was sold back and nothing is left open.${lost}`;
  }
  return null;
}

/**
 * What a bet with only its first order in place says, by what is missing. A Stake Back gives its stake back only through its
 * second order; a Range and a Breakout have no stake back. The cash-out button sits beside it.
 */
export function unprotectedWords(b: Pick<Bet, 'cashOut'> & Partial<Pick<Bet, 'product' | 'direction'>>): string {
  if (b.cashOut && !b.cashOut.complete) return `Part of this bet was sold for ${usd(b.cashOut.proceeds)} so far. You can sell the rest.`;
  return kindOf(b).product === 'parlay'
    ? 'Only the first order went through, so your stake does not come back if the first level fails. You can sell it back.'
    : 'Only the first order went through, so this bet is only half placed. You can sell it back.';
}

/**
 * What a bet with an order that has no confirmed result says: an order was sent and nobody knows what became of it. Nothing
 * more is sent for it, so there is nothing to sell from here, and the person's exchange account is the place to look.
 */
export const unconfirmedWords = (): string => 'Gemini did not confirm one of this bet’s orders, so it may be partly or fully in place. Check your Gemini account.';

/** The line under an open bet that has been partly sold: what the sale brought in, and that the rest is still open. Null otherwise. */
export function partSoldWords(b: Pick<Bet, 'status' | 'cashOut'>): string | null {
  if (b.status !== 'open' || !b.cashOut || b.cashOut.complete) return null;
  return `Part of this bet was sold for ${usd(b.cashOut.proceeds)} so far. The rest is still open.`;
}

/** The line under a bet whose market ended without a clear yes or no. Nothing for the person to do. */
export function reviewWords(paid: number | null): string {
  return `This market ended without a clear yes or no. ${paid === null ? 'We are working out what it paid.' : `It paid ${usd(paid)}.`} This call is not scored.`;
}

/**
 * The bets a page can draw. One record that arrives without its levels or its id cannot be titled or listed, and must not take
 * the whole page, and the other bets' cash-out with it: it is left out. A missing list of orders is an empty one, and a hole in
 * that list is skipped.
 */
export function usableBets(raw: unknown): Bet[] {
  if (!Array.isArray(raw)) return [];
  const out: Bet[] = [];
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const b = item as Partial<Bet>;
    if (typeof b.id !== 'string' || !Number.isFinite(b.condition?.strike) || !Number.isFinite(b.target?.strike)) continue;
    const legs = Array.isArray(b.legs) ? b.legs.filter((l) => l !== null && typeof l === 'object') : [];
    out.push({ ...b, legs } as Bet);
  }
  return out;
}
