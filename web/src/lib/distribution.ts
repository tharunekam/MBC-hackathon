import type { Rung } from '../api/types';
import { money } from './format';

/**
 * What a ladder says about where the price finishes.
 *
 * Each rung is a contract on "finishes at or above this price", so its mid price is the market's chance of that. The chance
 * of finishing BETWEEN two neighbouring rungs is the difference of their two chances, which turns a ladder into a histogram:
 * one bar per gap between rungs, plus one below the lowest rung and one at or above the highest. Nothing is modelled or
 * smoothed; the bars are the exchange's own prices, read another way.
 *
 * Real ladders are sometimes out of order for a moment (a higher rung priced above a lower one), which would make a bar
 * negative. Those rungs are averaged with their neighbours until the chances fall as the price rises (the standard
 * pool-adjacent-violators fit), and `adjusted` says that it happened so a page can say so.
 */

export interface Level {
  symbol: string;
  strike: number;
  /** Market's chance of finishing at or above this strike, after the ordering fix. */
  chance: number;
}

export interface Bucket {
  /** Lower edge, a rung's strike. Null for the bar below the lowest rung. */
  from: number | null;
  /** Upper edge, a rung's strike. Null for the bar at or above the highest rung. */
  to: number | null;
  /** Chance of finishing at or above `from` and below `to`. */
  chance: number;
}

export interface Distribution {
  /** Two-sided rungs, lowest strike first, chances never rising. */
  levels: Level[];
  /** `levels.length + 1` bars, lowest prices first. They add up to 1. */
  buckets: Bucket[];
  /** True when the ladder's prices were out of order and had to be averaged. */
  adjusted: boolean;
}

const clean = (x: number) => Math.round(x * 1e8) / 1e8;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** The closest never-rising sequence to `xs` (least squares): neighbours that rise are replaced by their average. */
export function neverRising(xs: number[]): number[] {
  const blocks: { sum: number; n: number }[] = [];
  for (const x of xs) {
    blocks.push({ sum: x, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]!;
      const a = blocks[blocks.length - 2]!;
      if (a.sum / a.n >= b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  return blocks.flatMap((b) => Array<number>(b.n).fill(b.sum / b.n));
}

/** The ladder as a histogram. Null when fewer than two rungs have both a buy and a sell price. */
export function distributionOf(rungs: Rung[]): Distribution | null {
  const priced = rungs.filter((r) => r.bid !== null && r.ask !== null).sort((a, b) => a.strike - b.strike);
  if (priced.length < 2) return null;
  const raw = priced.map((r) => clamp01((r.bid! + r.ask!) / 2));
  const fitted = neverRising(raw);
  const adjusted = fitted.some((c, i) => Math.abs(c - raw[i]!) > 1e-9);
  const levels: Level[] = priced.map((r, i) => ({ symbol: r.symbol, strike: r.strike, chance: clean(fitted[i]!) }));
  const buckets: Bucket[] = [{ from: null, to: levels[0]!.strike, chance: clean(1 - levels[0]!.chance) }];
  for (let i = 0; i < levels.length - 1; i++) buckets.push({ from: levels[i]!.strike, to: levels[i + 1]!.strike, chance: clean(levels[i]!.chance - levels[i + 1]!.chance) });
  const top = levels[levels.length - 1]!;
  buckets.push({ from: top.strike, to: null, chance: top.chance });
  return { levels, buckets, adjusted };
}

/**
 * The price the market gives a `q` chance of finishing at or above (q = 0.5 is the middle of its view), read off the ladder
 * with a straight line between rungs. Null when that chance lies off either end of the ladder, where there is no rung to
 * read it from.
 */
export function priceAtChance(levels: Level[], q: number): number | null {
  for (let i = 0; i < levels.length - 1; i++) {
    const a = levels[i]!;
    const b = levels[i + 1]!;
    if (a.chance >= q && q >= b.chance) {
      if (a.chance === b.chance) return (a.strike + b.strike) / 2;
      return a.strike + ((a.chance - q) / (a.chance - b.chance)) * (b.strike - a.strike);
    }
  }
  return null;
}

/**
 * How far the market expects the price to travel, with no model: the band that holds the middle half of its view.
 *
 * `low` is the price it gives a 75% chance of finishing at or above and `high` the price it gives 25%, so it gives an even
 * chance of finishing between the two and an even chance of finishing outside them. That makes it the yardstick for a bet
 * on two levels: a band wider than this one is more likely than not to hold, and a narrower one more likely to break.
 */
export interface EvenBand {
  low: number;
  high: number;
  /** Half the band's width as a fraction of its middle price: 0.006 reads as "±0.6%". */
  halfWidth: number;
}

/** The band the market gives an even chance of holding. Null when the ladder does not reach a 75% or a 25% chance. */
export function evenBand(levels: Level[]): EvenBand | null {
  const low = priceAtChance(levels, 0.75);
  const high = priceAtChance(levels, 0.25);
  if (low === null || high === null || !(high > low)) return null;
  const middle = (low + high) / 2;
  if (!(middle > 0)) return null;
  return { low, high, halfWidth: (high - low) / 2 / middle };
}

/** The expected move as a figure for a table: "±0.6%", to a whole percent once it reaches ten, and "–" when it is not known. */
export function moveText(band: Pick<EvenBand, 'halfWidth'> | null): string {
  if (!band || !Number.isFinite(band.halfWidth)) return '–';
  const percent = band.halfWidth * 100;
  return `±${percent.toFixed(percent < 9.95 ? 1 : 0)}%`;
}

/** A bar in words: "Below $61,500", "$63,000 to $63,500", "$64,500 or more". */
export function bucketLabel(b: Bucket): string {
  if (b.from === null) return b.to === null ? 'Any price' : `Below ${money(b.to)}`;
  return b.to === null ? `${money(b.from)} or more` : `${money(b.from)} to ${money(b.to)}`;
}

/** The bar the market thinks most likely. Ties go to the lower prices. */
export function likeliest(buckets: Bucket[]): Bucket | null {
  return buckets.reduce<Bucket | null>((best, b) => (best === null || b.chance > best.chance ? b : best), null);
}

// ------------------------------------------------------------------ a person's own view

/** Where a view sits and how wide it is: the price it gives an even chance, and roughly how far either side it would not be surprised by. */
export interface View {
  center: number;
  spread: number;
}

/** A chance of finishing at or above any price. */
export type Chance = (price: number) => number;

/**
 * The market's own view as a centre and a width: centred where it gives an even chance, as wide as the middle half of its
 * prices (the width a bell curve with those quartiles would have). Falls back to the middle of the ladder and a rung's width
 * when the ladder does not reach those chances.
 */
export function marketView(levels: Level[]): View {
  const lo = levels[0]!.strike;
  const hi = levels[levels.length - 1]!.strike;
  const step = levels.length > 1 ? (hi - lo) / (levels.length - 1) : Math.abs(lo) || 1;
  const mid = priceAtChance(levels, 0.5);
  const q75 = priceAtChance(levels, 0.75);
  const q25 = priceAtChance(levels, 0.25);
  // 1.349 standard deviations separate a bell curve's quartiles; one quartile and the middle give half of that.
  const spread = q75 !== null && q25 !== null ? (q25 - q75) / 1.349 : mid !== null && q25 !== null ? (q25 - mid) / 0.6745 : mid !== null && q75 !== null ? (mid - q75) / 0.6745 : step;
  const center = mid ?? (levels[0]!.chance < 0.5 ? lo : levels[levels.length - 1]!.chance > 0.5 ? hi : (lo + hi) / 2);
  return { center, spread: Math.max(spread, step / 4) };
}

/**
 * The market's chance of finishing at or above ANY price, not only a rung: a straight line between rungs, and beyond either
 * end of the ladder the chance that is left fades away over about one width. The ladder says nothing about how it fades out
 * there, so the tails are an assumption; they only matter to a view that has been moved a long way.
 */
export function chanceAt(levels: Level[], price: number, width = marketView(levels).spread): number {
  const first = levels[0]!;
  const last = levels[levels.length - 1]!;
  if (price <= first.strike) return clamp01(1 - (1 - first.chance) * Math.exp(-(first.strike - price) / width));
  if (price >= last.strike) return clamp01(last.chance * Math.exp(-(price - last.strike) / width));
  for (let i = 0; i < levels.length - 1; i++) {
    const a = levels[i]!;
    const b = levels[i + 1]!;
    if (price <= b.strike) return a.chance + ((price - a.strike) / (b.strike - a.strike)) * (b.chance - a.chance);
  }
  return last.chance;
}

/**
 * A person's view of where the price finishes: the market's own curve, moved to a new centre and squeezed or widened.
 *
 * Starting from the market's curve rather than a textbook bell means a view that has not been moved IS the market's, rung
 * for rung, so every difference a page shows is one the person made and none is an artefact of fitting a shape. It is their
 * view, not a forecast of ours.
 */
export function viewOf(levels: Level[], view: View): Chance {
  const base = marketView(levels);
  const scale = Math.max(view.spread, 1e-9) / base.spread;
  return (price) => chanceAt(levels, base.center + (price - view.center) / scale, base.spread);
}

/** A view as bars over the same edges as the market's, so the two can be drawn on top of each other. They add up to 1. */
export function viewBuckets(chance: Chance, levels: Level[]): Bucket[] {
  // Read rung by rung and kept in order, so no bar can come out negative.
  const at = neverRising(levels.map((l) => clamp01(chance(l.strike))));
  const out: Bucket[] = [{ from: null, to: levels[0]!.strike, chance: clean(1 - at[0]!) }];
  for (let i = 0; i < levels.length - 1; i++) out.push({ from: levels[i]!.strike, to: levels[i + 1]!.strike, chance: clean(at[i]! - at[i + 1]!) });
  out.push({ from: levels[levels.length - 1]!.strike, to: null, chance: clean(at[at.length - 1]!) });
  return out;
}

// ------------------------------------------------------------------ what a bet pays in each bar

export type Zone = 'win' | 'back' | 'lose';

/** The shape of a bet on one ladder, by the strikes that decide it. */
export type Shape =
  | { kind: 'up'; condition: number; target: number }
  | { kind: 'down'; condition: number; target: number }
  | { kind: 'range'; low: number; high: number }
  | { kind: 'breakout'; low: number; high: number };

/**
 * What a bet does if the price finishes in a bar. A rising parlay wins at or above its target, pays the stake back below its
 * condition and loses in between; a falling one is the mirror image; a range wins inside and loses outside; a breakout is the
 * range turned inside out, winning outside and losing inside. A bar is judged by its lower edge, which is exact because every
 * bar's edges are rungs and a bet's strikes are rungs too.
 */
export function zoneOf(shape: Shape, bucket: Bucket): Zone {
  const from = bucket.from ?? -Infinity;
  if (shape.kind === 'up') return from >= shape.target ? 'win' : from >= shape.condition ? 'lose' : 'back';
  if (shape.kind === 'down') return from < shape.target ? 'win' : from < shape.condition ? 'lose' : 'back';
  const inside = from >= shape.low && from < shape.high;
  return inside === (shape.kind === 'range') ? 'win' : 'lose';
}

/** The chance of each result, by adding up the bars. They sum to 1. */
export function zoneChances(shape: Shape, buckets: Bucket[]): Record<Zone, number> {
  const out: Record<Zone, number> = { win: 0, back: 0, lose: 0 };
  for (const b of buckets) out[zoneOf(shape, b)] += b.chance;
  return { win: clean(out.win), back: clean(out.back), lose: clean(out.lose) };
}
