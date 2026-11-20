import type { MarketEvent, Rung } from '../api/types';
import { rangeEstimate } from './pricing';

/** Where the default range aims: a floor the price will probably hold, and a ceiling it will probably stay under. */
export const FLOOR_AIM = 0.75;
export const CEILING_AIM = 0.3;
/** A rung priced at or beyond this is close to certain either way; a range between two of them is a dollar for nothing. */
const NEAR_CERTAIN = 0.9;
const NEAR_ZERO = 0.1;

const mid = (r: Rung) => ((r.bid ?? 0) + (r.ask ?? 0)) / 2;

/**
 * A sensible starting range: a floor near a 75% chance of finishing at or above it and a ceiling near 30%, so the chance of
 * finishing inside is around 40 to 50%. Chosen from the ladder's two-sided open rungs, lower strike first. Never the two ends
 * of the ladder, never two rungs that are both near-certain (or both near-impossible), and a range the offer rule would
 * refuse only when nothing else is left. Null when fewer than three rungs are usable.
 *
 * `openOnly: false` picks the same way from two-sided rungs whether or not they are open, so a ladder that is not open yet
 * still shows a range, and the button can say why it cannot be placed.
 */
export function defaultRange(ev: MarketEvent, opts: { openOnly?: boolean; feeCoef?: number } = {}): { low: string; high: string } | null {
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
      if (!(ml > mh)) continue; // no chance of finishing inside
      if ((ml >= NEAR_CERTAIN && mh >= NEAR_CERTAIN) || (ml <= NEAR_ZERO && mh <= NEAR_ZERO)) continue;
      const est = rangeEstimate({ bid: lo.bid, ask: lo.ask }, { bid: hi.bid, ask: hi.ask }, feeCoef);
      const refused = !est || est.verdict === 'refuse';
      const score = Math.abs(ml - FLOOR_AIM) + Math.abs(mh - CEILING_AIM) + (refused ? 1 : 0);
      if (!best || score < best.score) best = { low: lo, high: hi, score };
    }
  }
  return best ? { low: best.low.symbol, high: best.high.symbol } : null;
}
