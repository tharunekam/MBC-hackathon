import type { MarketEvent, Rung } from '../api/types';
import { breakoutEstimate, rangeEstimate } from './pricing';

/** Where the default range aims: a floor the price will probably hold, and a ceiling it will probably stay under. */
export const FLOOR_AIM = 0.75;
export const CEILING_AIM = 0.3;
/**
 * Where the default breakout aims: a chance of finishing outside a little under a half, so that with the spread it costs about
 * 50 cents for each dollar it can win. On a real ladder the rungs are coarse, and the pair nearest the market's two quartiles
 * often leaves only a one-in-three chance outside; aiming at the chance itself picks the tighter band instead.
 */
export const BREAKOUT_AIM = 0.48;
/** How much a lopsided breakout is marked down: one that is nearly all "below" or all "above" is a bet on a direction. */
const BREAKOUT_BALANCE = 0.25;
/** A rung priced at or beyond this is close to certain either way; a range between two of them is a dollar for nothing. */
const NEAR_CERTAIN = 0.9;
const NEAR_ZERO = 0.1;

const mid = (r: Rung) => ((r.bid ?? 0) + (r.ask ?? 0)) / 2;

type Levels = { low: string; high: string };
type Options = { openOnly?: boolean; feeCoef?: number };

/**
 * The pair of rungs with the smallest `miss`: a function that is given the chance of finishing at or above the lower level and
 * at or above the higher one, and says how far the pair is from what is wanted. Chosen from the ladder's two-sided open
 * rungs, lower strike first. Never the two ends of the ladder, never two rungs that are both near-certain (or both
 * near-impossible), and a pair the offer rule would refuse only when nothing else is left. Null when fewer than three rungs
 * are usable.
 */
function closest(ev: MarketEvent, opts: Options, miss: (chanceLow: number, chanceHigh: number) => number, refused: (lo: Rung, hi: Rung, feeCoef: number) => boolean): Levels | null {
  const { openOnly = true, feeCoef = 0 } = opts;
  const usable = ev.rungs.filter((r) => r.bid !== null && r.ask !== null && (!openOnly || r.open)).sort((a, b) => a.strike - b.strike);
  if (usable.length < 3) return null;

  const last = usable.length - 1;
  let best: { low: Rung; high: Rung; score: number } | null = null;
  for (let i = 0; i < last; i++) {
    for (let j = i + 1; j <= last; j++) {
      if (i === 0 && j === last) continue;
      const lo = usable[i]!;
      const hi = usable[j]!;
      const [ml, mh] = [mid(lo), mid(hi)];
      if (!(ml > mh)) continue; // no chance of finishing between the two
      if ((ml >= NEAR_CERTAIN && mh >= NEAR_CERTAIN) || (ml <= NEAR_ZERO && mh <= NEAR_ZERO)) continue;
      const score = miss(ml, mh) + (refused(lo, hi, feeCoef) ? 1 : 0);
      if (!best || score < best.score) best = { low: lo, high: hi, score };
    }
  }
  return best ? { low: best.low.symbol, high: best.high.symbol } : null;
}

/**
 * A sensible starting range: a floor near a 75% chance of finishing at or above it and a ceiling near 30%, so the chance of
 * finishing inside is around 40 to 50%. See `closest` for what is never chosen.
 *
 * `openOnly: false` picks the same way from two-sided rungs whether or not they are open, so a ladder that is not open yet
 * still shows a range, and the button can say why it cannot be placed.
 */
export function defaultRange(ev: MarketEvent, opts: Options = {}): Levels | null {
  const miss = (low: number, high: number) => Math.abs(low - FLOOR_AIM) + Math.abs(high - CEILING_AIM);
  return closest(ev, opts, miss, (lo, hi, feeCoef) => {
    const est = rangeEstimate({ bid: lo.bid, ask: lo.ask }, { bid: hi.bid, ask: hi.ask }, feeCoef);
    return !est || est.verdict === 'refuse';
  });
}

/**
 * A sensible starting breakout: two levels the market gives close to an even chance of finishing outside, with a real chance on
 * each side. A narrower band would be a near-certain win that pays almost nothing and a wider one a long shot; this one reads
 * as "does it move, or does it stay put". Chosen from the same rungs as the default range, with the same things never chosen.
 */
export function defaultBreakout(ev: MarketEvent, opts: Options = {}): Levels | null {
  // `low` and `high` are the chances of finishing at or above each level, so 1 - low lies below the band and high above it.
  const miss = (low: number, high: number) => Math.abs(1 - low + high - BREAKOUT_AIM) + BREAKOUT_BALANCE * Math.abs(1 - low - high);
  return closest(ev, opts, miss, (lo, hi, feeCoef) => {
    const est = breakoutEstimate({ bid: lo.bid, ask: lo.ask }, { bid: hi.bid, ask: hi.ask }, feeCoef);
    return !est || est.verdict === 'refuse';
  });
}

/**
 * Where a builder starts on a ladder, for a bet that the price stays inside two levels (`in`) or finishes outside them (`out`):
 * the default from its open prices; on a ladder that is not open yet, the same choice from the prices it shows, so the button
 * can say why it cannot be placed; and on a ladder with almost no prices, its middle two rungs.
 */
export function startingLevels(ev: MarketEvent, feeCoef: number, side: 'in' | 'out' = 'in'): Levels | null {
  const choose = side === 'out' ? defaultBreakout : defaultRange;
  const pick = choose(ev, { feeCoef }) ?? choose(ev, { feeCoef, openOnly: false });
  if (pick) return pick;
  const r = [...ev.rungs].sort((a, b) => a.strike - b.strike);
  if (r.length < 2) return null;
  const i = Math.max(0, Math.floor(r.length / 2) - 1);
  return { low: r[i]!.symbol, high: r[i + 1]!.symbol };
}
