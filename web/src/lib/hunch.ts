import type { MarketEvent, Pair, Rung } from '../api/types';
import type { Chance } from './distribution';
import { rangeEstimate } from './pricing';

/**
 * From a person's view of where a price finishes to the bets on offer that pay best if they are right.
 *
 * Every bet the app sells on a ladder is listed with the price the exchange asks for it (spread and fees included, the same
 * number the builders show as "You pay per $1"), then valued under the person's own view. The difference is what their view
 * is worth on that bet, per $1 of payout. Nothing here is a forecast of ours: the only inputs are the exchange's prices and
 * the view the person entered, and the page says so.
 */

interface Leg {
  symbol: string;
  strike: number;
}

/**
 * `warn` is the offer rule's own word on the price: a little over fair value. `waived` marks a bet the rule refuses for its
 * markup and the venue lets through anyway, which only the sandbox demo does (its books are several times wider than
 * production's); the page says so on the bet, and the price shown is the real one.
 */
interface Terms {
  pricePaid: number;
  fairPrice: number;
  warn: boolean;
  waived: boolean;
}

export type Idea = ({ product: 'parlay'; direction: 'up' | 'down'; condition: Leg; target: Leg } | { product: 'range'; low: Leg; high: Leg }) & Terms;

export interface Scored {
  idea: Idea;
  /** What $1 of this bet's payout is worth if the view is right: for a parlay, the chance of the target once the condition holds. */
  worth: number;
  /** `worth` minus the price paid, per $1 of payout. Positive when the view makes the bet worth more than it costs. */
  edge: number;
  /** The view's chance of each result. They add up to 1. */
  win: number;
  back: number;
  lose: number;
  /** The average result of putting $100 on it, if the view is right. */
  expectedPer100: number;
}

const leg = (l: { symbol: string; strike: number }): Leg => ({ symbol: l.symbol, strike: l.strike });

function parlayIdeas(pairs: Pair[] | undefined, direction: 'up' | 'down'): Idea[] {
  const out: Idea[] = [];
  for (const p of pairs ?? []) {
    const q = p.quote;
    // `offerable` is the executor's answer to "may this be placed": the rule passed, or only its markup failed with the waiver on.
    if (!q.offerable || q.pricePaid === null || q.fairPrice === null) continue;
    out.push({ product: 'parlay', direction, condition: leg(p.condition), target: leg(p.target), pricePaid: q.pricePaid, fairPrice: q.fairPrice, warn: q.verdict === 'warn', waived: q.overridden });
  }
  return out;
}

/** Ranges are not in the market list, so they are judged here by the page's port of the same rule, waiver included. */
function rangeIdeas(rungs: Rung[], feeCoef: number, waiveMarkup: boolean): Idea[] {
  const usable = rungs.filter((r) => r.bid !== null && r.ask !== null && r.open).sort((a, b) => a.strike - b.strike);
  const out: Idea[] = [];
  for (let i = 0; i < usable.length - 1; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const lo = usable[i]!;
      const hi = usable[j]!;
      const est = rangeEstimate({ bid: lo.bid, ask: lo.ask }, { bid: hi.bid, ask: hi.ask }, feeCoef);
      if (!est) continue;
      const waived = est.verdict === 'refuse' && waiveMarkup && est.code === 'markup_too_high';
      if (est.verdict === 'refuse' && !waived) continue;
      out.push({ product: 'range', low: leg(lo), high: leg(hi), pricePaid: est.pricePaid, fairPrice: est.fairPrice, warn: est.verdict === 'warn', waived });
    }
  }
  return out;
}

/** Every bet a ladder has on offer right now: the parlays the exchange's prices allow, both ways, and every range that passes the same rule. */
export function ideasOn(ev: MarketEvent, feeCoef: number): Idea[] {
  // The market list does not say outright whether the venue waives the markup rule; a parlay it let through says so.
  const waiveMarkup = [...ev.pairs, ...(ev.down?.pairs ?? [])].some((p) => p.quote.overridden);
  return [...parlayIdeas(ev.pairs, 'up'), ...parlayIdeas(ev.down?.pairs, 'down'), ...rangeIdeas(ev.rungs, feeCoef, waiveMarkup)];
}

/**
 * One bet valued under a view, given as the view's chance of finishing at or above any price. Null when the view gives the
 * bet's condition no chance at all, so there is nothing to value.
 */
export function score(idea: Idea, chance: Chance): Scored | null {
  if (idea.product === 'range') {
    const win = Math.max(0, chance(idea.low.strike) - chance(idea.high.strike));
    // Each pair of contracts costs $1 + price and returns $2 inside the range and $1 outside it.
    const expectedPer100 = (100 * (win - idea.pricePaid)) / (1 + idea.pricePaid);
    return { idea, worth: win, edge: win - idea.pricePaid, win, back: 0, lose: 1 - win, expectedPer100 };
  }
  const up = idea.direction === 'up';
  const holds = up ? chance(idea.condition.strike) : 1 - chance(idea.condition.strike);
  const hits = up ? chance(idea.target.strike) : 1 - chance(idea.target.strike);
  if (!(holds > 1e-6)) return null;
  const worth = Math.min(1, hits / holds);
  // $100 buys 100 / price contracts that pay $1 each if the target is reached; the stake comes back if the condition fails.
  const expectedPer100 = 100 * (hits / idea.pricePaid - holds);
  return { idea, worth, edge: worth - idea.pricePaid, win: hits, back: 1 - holds, lose: Math.max(0, holds - hits), expectedPer100 };
}

const kindOf = (i: Idea) => (i.product === 'range' ? 'range' : i.direction);

/** Two bets a reader would call the same idea: parlays the same way to the same target, or ranges that share an edge. */
function alike(a: Idea, b: Idea): boolean {
  if (a.product === 'range' && b.product === 'range') return a.low.strike === b.low.strike || a.high.strike === b.high.strike;
  if (a.product === 'parlay' && b.product === 'parlay') return a.direction === b.direction && a.target.strike === b.target.strike;
  return false;
}

/**
 * The bets a view favours, best first by what $100 is expected to return if the view is right. Only bets the view makes worth
 * more than they cost are listed, at most `perKind` of each kind (rising, falling, range), and never two that differ only in
 * where the condition sits, so the list is not five near-copies of one bet.
 */
export function rank(ideas: Idea[], chance: Chance, opts: { limit?: number; perKind?: number } = {}): Scored[] {
  const { limit = 5, perKind = 2 } = opts;
  const scored = ideas
    .map((i) => score(i, chance))
    .filter((s): s is Scored => s !== null && s.edge > 0.005 && s.expectedPer100 > 0)
    .sort((a, b) => b.expectedPer100 - a.expectedPer100 || b.edge - a.edge);
  const taken: Record<string, number> = {};
  const out: Scored[] = [];
  for (const s of scored) {
    const k = kindOf(s.idea);
    if ((taken[k] ?? 0) >= perKind || out.some((o) => alike(o.idea, s.idea))) continue;
    taken[k] = (taken[k] ?? 0) + 1;
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/** Where a bet's builder opens with this bet already chosen. */
export function builderLink(ticker: string, idea: Idea): string {
  const q = new URLSearchParams({ market: ticker });
  if (idea.product === 'range') {
    q.set('low', idea.low.symbol);
    q.set('high', idea.high.symbol);
    return `/range?${q}`;
  }
  q.set('condition', idea.condition.symbol);
  q.set('target', idea.target.symbol);
  if (idea.direction === 'down') q.set('direction', 'down');
  return `/parlay?${q}`;
}
