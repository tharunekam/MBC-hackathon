import type { MarketEvent } from '../api/types';
import { distributionOf, moveText, priceAtChance } from './distribution';
import { money } from './format';
import { rungGap, snap, tickFor } from './ladders';
import { closesLabel } from './markets';

/**
 * The market's forecast for one asset, read across its closing times.
 *
 * An exchange lists a separate ladder for each time an asset's price is read: this hour, tonight, the end of the month.
 * Each ladder on its own says where the market thinks the price finishes at that one moment (lib/distribution.ts). Put side
 * by side in the order they close, they say how that view widens the further out it looks, which is the shape a forecaster
 * draws as a fan. Nothing here is modelled or smoothed: every figure is read off one ladder's own prices, and a ladder whose
 * prices do not reach far enough to give a figure simply has none.
 *
 * The two bands are the bets this app sells. A Range on a band's two edges is a bet the price stays inside it; a Breakout
 * on the same two edges is a bet it does not.
 */

export interface Band {
  low: number;
  high: number;
}

export interface OutlookLevel {
  symbol: string;
  strike: number;
}

export interface OutlookPoint {
  ticker: string;
  expiry: string;
  /** When this ladder closes, in milliseconds. */
  at: number;
  /** The price the market gives an even chance of finishing at or above. */
  middle: number;
  /** Holds an even chance: from the price it gives 75% of reaching to the one it gives 25%. Null when the ladder does not reach that far. */
  even: Band | null;
  /** Holds four chances in five: from the 90% price to the 10% price. Null when the ladder does not reach that far. */
  wide: Band | null;
  /** The two listed levels closest to the even band's edges, to open a bet on it. Null when the ladder has no two levels to offer. */
  levels: { low: OutlookLevel; high: OutlookLevel } | null;
}

const band = (low: number | null, high: number | null): Band | null => (low !== null && high !== null && high > low ? { low, high } : null);

/** The listed level closest to a price. Ties go to the lower one. */
function nearest(levels: OutlookLevel[], price: number): number {
  let best = 0;
  for (let i = 1; i < levels.length; i++) if (Math.abs(levels[i]!.strike - price) < Math.abs(levels[best]!.strike - price)) best = i;
  return best;
}

/**
 * Two listed levels to stand for a band. A band narrower than the gap between rungs lands both edges on the same rung, and a
 * bet needs two, so the upper one moves up a rung (or the lower one down, at the top of the ladder).
 */
export function levelsFor(levels: OutlookLevel[], b: Band): { low: OutlookLevel; high: OutlookLevel } | null {
  if (levels.length < 2) return null;
  let lo = nearest(levels, b.low);
  let hi = nearest(levels, b.high);
  if (hi <= lo) {
    if (lo + 1 < levels.length) hi = lo + 1;
    else lo = hi - 1;
  }
  return { low: levels[lo]!, high: levels[hi]! };
}

/** One ladder's point on the fan. Null when it has closed, has no close time, or its prices do not say where the middle is. */
export function pointOf(e: Pick<MarketEvent, 'ticker' | 'expiry' | 'rungs'>, now: number): OutlookPoint | null {
  if (!e.expiry) return null;
  const at = new Date(e.expiry).getTime();
  if (!Number.isFinite(at) || at <= now) return null;
  const levels = distributionOf(e.rungs)?.levels;
  if (!levels) return null;
  // A price read between two rungs is rounded to a hundredth of the rung gap: to the cent it would claim more than the ladder knows.
  const tick = tickFor(rungGap(levels.map((l) => l.strike)));
  const at50 = priceAtChance(levels, 0.5);
  if (at50 === null) return null;
  const read = (q: number): number | null => {
    const price = priceAtChance(levels, q);
    return price === null ? null : snap(price, tick);
  };
  const middle = snap(at50, tick);
  const even = band(read(0.75), read(0.25));
  const wide = band(read(0.9), read(0.1));
  const listed = levels.map((l) => ({ symbol: l.symbol, strike: l.strike }));
  return { ticker: e.ticker, expiry: e.expiry, at, middle, even, wide, levels: levelsFor(listed, even ?? wide ?? { low: middle, high: middle }) };
}

/**
 * The fan for one asset: a point per closing time, soonest first. Two ladders that close at the same moment would draw two
 * points on one spot, so the one that says more (both bands, then either) is kept.
 */
export function outlookOf(events: Pick<MarketEvent, 'ticker' | 'expiry' | 'rungs'>[], now: number): OutlookPoint[] {
  const says = (p: OutlookPoint) => Number(p.even !== null) + Number(p.wide !== null);
  const byClose = new Map<number, OutlookPoint>();
  for (const e of events) {
    const p = pointOf(e, now);
    if (!p) continue;
    const held = byClose.get(p.at);
    if (!held || says(p) > says(held)) byClose.set(p.at, p);
  }
  return [...byClose.values()].sort((a, b) => a.at - b.at);
}

/**
 * How far along the chart a closing time sits, 0 at now and 1 at the last close. The scale is the square root of the time
 * left, not the time itself: an hour, a day and a month on a straight time axis would crowd everything near the left edge,
 * and uncertainty grows roughly with the square root of time, so on this axis a steady market draws a fan with straight
 * sides. With one closing time there is nothing to space out and it sits at the right edge.
 */
export function alongOf(at: number, now: number, last: number): number {
  const span = last - now;
  if (!(span > 0)) return 1;
  return Math.sqrt(Math.min(1, Math.max(0, (at - now) / span)));
}

/** Half a band's width as a share of its middle: 0.006 reads as "±0.6%". */
export const halfWidth = (b: Band): number => (b.high - b.low) / (b.high + b.low);

/** What one closing time says, as a sentence for under the chart. */
export function pointWords(p: OutlookPoint, now: number): string {
  const when = closesLabel(p.expiry, now).replace(/^Today /, 'today at ');
  const head = `By ${when} the middle of the market’s view is ${money(p.middle)}.`;
  if (p.even && p.wide)
    return `${head} It gives an even chance of finishing between ${money(p.even.low)} and ${money(p.even.high)}, and four chances in five of finishing between ${money(p.wide.low)} and ${money(p.wide.high)}.`;
  if (p.even) return `${head} It gives an even chance of finishing between ${money(p.even.low)} and ${money(p.even.high)}.`;
  if (p.wide) return `${head} It gives four chances in five of finishing between ${money(p.wide.low)} and ${money(p.wide.high)}.`;
  return `${head} Its prices do not reach far enough either side to say how wide that view is.`;
}

/**
 * How the view widens from the soonest close to the furthest, in one line: "The even-chance band widens from ±0.4% by today
 * 10 PM to ±1.9% by Nov 21, 5 PM." Null with fewer than two closes that have that band, when there is nothing to compare.
 */
export function wideningWords(points: OutlookPoint[], now: number): string | null {
  const banded = points.filter((p): p is OutlookPoint & { even: Band } => p.even !== null);
  if (banded.length < 2) return null;
  const first = banded[0]!;
  const last = banded[banded.length - 1]!;
  const by = (p: OutlookPoint) => closesLabel(p.expiry, now).replace(/^Today /, 'today ');
  const [a, b] = [halfWidth(first.even), halfWidth(last.even)];
  const verb = b > a * 1.05 ? 'widens' : b < a * 0.95 ? 'narrows' : 'holds steady';
  if (verb === 'holds steady') return `The even-chance band ${verb} at about ${moveText({ halfWidth: b })} from ${by(first)} to ${by(last)}.`;
  return `The even-chance band ${verb} from ${moveText({ halfWidth: a })} by ${by(first)} to ${moveText({ halfWidth: b })} by ${by(last)}.`;
}

/** The lowest and highest price the chart has to show, with a little air above and below. Null with no points. */
export function priceSpan(points: OutlookPoint[]): Band | null {
  if (points.length === 0) return null;
  const lows = points.map((p) => p.wide?.low ?? p.even?.low ?? p.middle);
  const highs = points.map((p) => p.wide?.high ?? p.even?.high ?? p.middle);
  const [low, high] = [Math.min(...lows), Math.max(...highs)];
  const air = high > low ? (high - low) * 0.12 : Math.abs(high) * 0.01 || 1;
  return { low: low - air, high: high + air };
}

/** Round prices for the side of the chart: about `want` of them, on steps of 1, 2 or 5 times a power of ten. */
export function priceTicks(span: Band, want = 4): number[] {
  const raw = (span.high - span.low) / Math.max(1, want);
  if (!(raw > 0)) return [];
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const out: number[] = [];
  for (let v = Math.ceil(span.low / step) * step; v <= span.high + 1e-9; v += step) out.push(Math.round(v * 1e8) / 1e8);
  return out;
}
