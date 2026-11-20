import type { MarketEvent, Pair, Rung } from '../api/types';
import type { Chance } from './distribution';
import { breakoutEstimate, breakoutOutcomesFor, outcomesFor, rangeEstimate, rangeOutcomesFor } from './pricing';

/**
 * From a person's view of where a price finishes to the bets on offer that the view makes worth more than they cost.
 *
 * Every bet the app sells on a ladder is listed with the price the exchange asks for it (spread and fees included, the same
 * number the builders show as "You pay per $1"), then valued under the person's own view. The difference is what their view
 * is worth on that bet, per $1 of payout, and the list is ordered by it. Nothing here is a forecast of ours: the only inputs
 * are the exchange's prices and the view the person entered, and the page says so.
 *
 * It used to order by the average return on $100 and print that number. A long shot at 10 cents that the view thinks is
 * worth 20 "returns 100%" on that measure, so a small nudge put bets that lose four times in five at the top, under a dollar
 * figure that read as a promise. Now a bet has to win reasonably often under the person's own view to be listed ahead of
 * one that does, and the only dollar figure shown is what a stake wins at the price, which is a fact and not an expectation.
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

export type Idea = ({ product: 'parlay'; direction: 'up' | 'down'; condition: Leg; target: Leg } | { product: 'range'; low: Leg; high: Leg } | { product: 'breakout'; low: Leg; high: Leg }) & Terms;

export interface Scored {
  idea: Idea;
  /** What $1 of this bet's payout is worth if the view is right: for a parlay, the chance of the target once the first level holds. */
  worth: number;
  /** `worth` minus the price paid, per $1 of payout. Positive when the view makes the bet worth more than it costs. */
  edge: number;
  /**
   * The same three as whole cents, the way the page shows them. The difference is taken between the two rounded figures, so
   * "36¢, 17¢" is never followed by "+18¢".
   */
  worthCents: number;
  priceCents: number;
  edgeCents: number;
  /** The view's chance of each result. They add up to 1. */
  win: number;
  back: number;
  lose: number;
}

/** A bet has to win at least this often under the person's own view to be listed ahead of a long shot. */
export const MIN_WIN = 0.2;

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

/**
 * Ranges and breakouts are not in the market list, so they are judged here by the page's port of the same rule, waiver
 * included: every pair of open two-sided rungs, as a bet that the price finishes between them and as a bet that it does not.
 */
function levelIdeas(rungs: Rung[], feeCoef: number, waiveMarkup: boolean): Idea[] {
  const usable = rungs.filter((r) => r.bid !== null && r.ask !== null && r.open).sort((a, b) => a.strike - b.strike);
  const out: Idea[] = [];
  for (let i = 0; i < usable.length - 1; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const lo = usable[i]!;
      const hi = usable[j]!;
      const books = [{ bid: lo.bid, ask: lo.ask }, { bid: hi.bid, ask: hi.ask }] as const;
      for (const product of ['range', 'breakout'] as const) {
        const est = product === 'range' ? rangeEstimate(books[0], books[1], feeCoef) : breakoutEstimate(books[0], books[1], feeCoef);
        if (!est) continue;
        const waived = est.verdict === 'refuse' && waiveMarkup && est.code === 'markup_too_high';
        if (est.verdict === 'refuse' && !waived) continue;
        out.push({ product, low: leg(lo), high: leg(hi), pricePaid: est.pricePaid, fairPrice: est.fairPrice, warn: est.verdict === 'warn', waived });
      }
    }
  }
  return out;
}

/**
 * Whether a ladder's prices are out of order: a higher level priced above a lower one, on the buy side or the sell side. "X or
 * above" must get cheaper as X rises, so this is a stale or broken book. The same rule the executor refuses every bet on a
 * ladder for (`ladderInversions`), read from every level with a price on that side, not only the open ones.
 */
export function crossed(rungs: Rung[]): boolean {
  const sorted = [...rungs].sort((a, b) => a.strike - b.strike);
  return sorted.some((lo, i) =>
    sorted.slice(i + 1).some((hi) => hi.strike > lo.strike && ((lo.bid !== null && hi.bid !== null && hi.bid > lo.bid + 1e-9) || (lo.ask !== null && hi.ask !== null && hi.ask > lo.ask + 1e-9))),
  );
}

/** Whether the exchange will take no bet on this ladder for the moment because its prices are out of order. */
export const outOfOrder = (ev: Pick<MarketEvent, 'ladderOutOfOrder' | 'rungs'>): boolean => ev.ladderOutOfOrder || crossed(ev.rungs);

/**
 * Every bet a ladder has on offer right now: the parlays the exchange's prices allow, both ways, and every range and breakout
 * that passes the same rule. None on a ladder whose prices are out of order: the executor refuses every bet on it, and the
 * evening-out of such prices would make a difference out of nothing, a green "+6¢" on a bet that cannot be placed.
 */
export function ideasOn(ev: MarketEvent, feeCoef: number): Idea[] {
  if (outOfOrder(ev)) return [];
  // The market list does not say outright whether the venue waives the markup rule; a parlay it let through says so.
  const waiveMarkup = [...ev.pairs, ...(ev.down?.pairs ?? [])].some((p) => p.quote.overridden);
  return [...parlayIdeas(ev.pairs, 'up'), ...parlayIdeas(ev.down?.pairs, 'down'), ...levelIdeas(ev.rungs, feeCoef, waiveMarkup)];
}

const valued = (idea: Idea, worth: number, win: number, back: number): Scored => {
  const worthCents = Math.round(worth * 100);
  const priceCents = Math.round(idea.pricePaid * 100);
  return { idea, worth, edge: worth - idea.pricePaid, worthCents, priceCents, edgeCents: worthCents - priceCents, win, back, lose: Math.max(0, 1 - win - back) };
};

/**
 * One bet valued under a view, given as the view's chance of finishing at or above any price. Null when the view gives the
 * bet's first level no chance of holding, so there is nothing to value.
 */
export function score(idea: Idea, chance: Chance): Scored | null {
  if (idea.product === 'range') {
    const win = Math.min(1, Math.max(0, chance(idea.low.strike) - chance(idea.high.strike)));
    return valued(idea, win, win, 0);
  }
  if (idea.product === 'breakout') {
    const win = Math.min(1, Math.max(0, 1 - (chance(idea.low.strike) - chance(idea.high.strike))));
    return valued(idea, win, win, 0);
  }
  const up = idea.direction === 'up';
  const holds = up ? chance(idea.condition.strike) : 1 - chance(idea.condition.strike);
  const hits = up ? chance(idea.target.strike) : 1 - chance(idea.target.strike);
  if (!(holds > 1e-6)) return null;
  // $1 of payout is only in play once the first level holds, so it is worth the chance of the target given that.
  return valued(idea, Math.min(1, hits / holds), Math.min(hits, holds), 1 - holds);
}

/**
 * What a stake on a bet nets if it wins, in dollars, from the price alone: the same sum the builder's estimate does. A fact
 * about the price, not a forecast: it says nothing about how often the bet wins.
 */
export function winsOn(idea: Idea, stake: number): number {
  // A range's pair of contracts costs $1 more than its price (the dollar one of them pays either way); a breakout's costs its price.
  if (idea.product === 'range') return rangeOutcomesFor(stake, 1 + idea.pricePaid).ifInRange;
  if (idea.product === 'breakout') return breakoutOutcomesFor(stake, idea.pricePaid).ifOutside;
  return outcomesFor(stake, idea.pricePaid).ifBothHit;
}

const kindOf = (i: Idea) => (i.product === 'parlay' ? i.direction : i.product);

/** Two bets a reader would call the same idea: parlays the same way to the same target, or two ranges, or two breakouts, that share a level. */
function alike(a: Idea, b: Idea): boolean {
  if (a.product !== 'parlay' && a.product === b.product) return a.low.strike === b.low.strike || a.high.strike === b.high.strike;
  if (a.product === 'parlay' && b.product === 'parlay') return a.direction === b.direction && a.target.strike === b.target.strike;
  return false;
}

/**
 * The bets a view favours, biggest difference first: what $1 of the bet is worth to the view, less what it costs. Only bets
 * whose difference is real and shows as at least a cent are listed, at most `perKind` of each kind (rising, falling, range, breakout),
 * and never two that differ only in where the first level sits, so the list is not five near-copies of one bet.
 *
 * A bet must also win at least `MIN_WIN` of the time under the view itself. If none does, the best of the long shots are
 * listed all the same (the page says that is what they are) rather than an empty list under a view that plainly differs.
 */
export function rank(ideas: Idea[], chance: Chance, opts: { limit?: number; perKind?: number } = {}): Scored[] {
  const { limit = 5, perKind = 2 } = opts;
  // More than half a cent of real difference, and a cent of it on screen: neither "69¢ against 68¢" for a fifth of a cent,
  // nor "+0¢".
  const worthIt = ideas.map((i) => score(i, chance)).filter((s): s is Scored => s !== null && s.edge > 0.005 && s.edgeCents >= 1);
  const likely = worthIt.filter((s) => s.win >= MIN_WIN);
  const scored = (likely.length > 0 ? likely : worthIt).sort((a, b) => b.edge - a.edge || b.win - a.win);
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
  if (idea.product !== 'parlay') {
    q.set('low', idea.low.symbol);
    q.set('high', idea.high.symbol);
    // A breakout is built on the Range page, on its other side.
    if (idea.product === 'breakout') q.set('side', 'out');
    return `/range?${q}`;
  }
  q.set('condition', idea.condition.symbol);
  q.set('target', idea.target.symbol);
  if (idea.direction === 'down') q.set('direction', 'down');
  return `/parlay?${q}`;
}
