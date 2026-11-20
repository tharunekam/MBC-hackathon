import type { Rung } from '../api/types';
import { distributionOf, zoneOf, type Bucket, type Distribution, type Shape } from './distribution';
import { money, pct } from './format';

/**
 * How a basket's legs come out together.
 *
 * Legs on the SAME ladder are decided by one number: the price that ladder finishes at. So their joint result needs no model.
 * Walk the ladder's bars (see distribution.ts), ask what each leg does in each bar, and add up the bars where every leg wins.
 * The same walk shows when two legs can never both win, such as a rising and a falling parlay whose winning prices do not
 * overlap: the chance is exactly 0, whatever the prices are.
 *
 * Legs on DIFFERENT ladders are another matter. The exchange prices each market on its own, and nothing in those prices says
 * how two markets move together. What holds whatever the relationship is a range (the Fréchet bounds): everything winning is
 * at most as likely as the least likely ladder, and at least as likely as the overlap that is left when the ladders are pushed
 * as far apart as their chances allow. The figure for markets that had nothing to do with each other (the chances multiplied)
 * always lies inside that range, and is given as a reference point, never as the answer.
 *
 * Nothing here is a forecast of ours. The only inputs are the exchange's prices and the strikes the legs are built on.
 */

/** One leg, as far as its result goes: the ladder it is on and the strikes that decide it. */
export interface JointLeg {
  /** The ladder's event ticker. Two legs with the same ticker are decided by the same finishing price. */
  ticker: string;
  shape: Shape;
}

/** The legs that share one ladder, and the market's chance of what they do together. Exact for the ladder's prices. */
export interface LadderGroup {
  ticker: string;
  /** Which legs, by their place in the basket, from 0. */
  legs: number[];
  /** Every one of these legs wins. */
  allWin: number;
  /** None of them loses: each one wins or gets its stake back. */
  noneLose: number;
  /** At least one of them wins. */
  anyWin: number;
  /** True when this ladder's prices were out of order and had to be averaged first. */
  adjusted: boolean;
}

/** A chance that can depend on how separate markets move together: the range that is certain, and one point inside it. */
export interface Span {
  low: number;
  high: number;
  /** What it would be if the markets had nothing to do with each other. A reference point, not the answer. */
  ifUnrelated: number;
  /**
   * True when the two ends meet, so nothing depends on how the markets move together. Always so when every leg is on one
   * ladder; also when some ladder's legs cannot all win, which makes everything winning impossible whatever the others do.
   */
  exact: boolean;
}

export interface Together {
  /** One per ladder, in the order the basket first uses them. Only legs that could be read are in them. */
  groups: LadderGroup[];
  /** Across the whole basket. Null while any leg is left out, because "every leg" cannot be said without it. */
  allWin: Span | null;
  noneLose: Span | null;
  anyWin: Span | null;
  /**
   * Pairs of legs on one ladder whose winning prices do not overlap. Read from the strikes alone, so it needs no prices. With a
   * breakout among three or more legs, the legs can also fail to share a winning price without any pair doing so: see
   * `neverAllWin`. The figures above are worked from the bars either way, so they are right in both cases.
   */
  impossible: { legs: [number, number]; ticker: string }[];
  /**
   * Legs left out, by their place in the basket: not chosen yet, on a ladder with fewer than two priced rungs, or built on a
   * rung that has no price on both sides right now.
   */
  missing: number[];
  /** True when any ladder used here had prices out of order that were averaged. */
  adjusted: boolean;
}

const clean = (x: number) => Math.round(x * 1e8) / 1e8;
/** Ends closer than this are the same figure; the bars are only kept to 8 places. */
const SAME = 1e-9;

/** A leg's shape from its kind and its two levels, in the order the basket holds them: condition then target, or lower level then higher. */
export function shapeOf(kind: Shape['kind'], a: number, b: number): Shape {
  return kind === 'range' || kind === 'breakout' ? { kind, low: a, high: b } : { kind, condition: a, target: b };
}

/** A stretch of the price line: from `from` (included) up to `to` (not included). */
interface Stretch {
  from: number;
  to: number;
}

/**
 * The finishing prices a leg wins at. A parlay or a range wins on one stretch of the price line. A breakout wins on two: below
 * its lower level, and at or above its higher one.
 */
function winStretches(shape: Shape): Stretch[] {
  if (shape.kind === 'up') return [{ from: shape.target, to: Infinity }];
  if (shape.kind === 'down') return [{ from: -Infinity, to: shape.target }];
  if (shape.kind === 'range') return [{ from: shape.low, to: shape.high }];
  return [
    { from: -Infinity, to: shape.low },
    { from: shape.high, to: Infinity },
  ];
}

/** The prices two sets of stretches have in common. */
function shared(xs: Stretch[], ys: Stretch[]): Stretch[] {
  const out: Stretch[] = [];
  for (const x of xs) {
    for (const y of ys) {
      const from = Math.max(x.from, y.from);
      const to = Math.min(x.to, y.to);
      if (from < to) out.push({ from, to });
    }
  }
  return out;
}

/** Whether one finishing price can win every one of these bets, for bets on the same ladder. Read from the strikes alone. */
export function canAllWin(shapes: Shape[]): boolean {
  let left: Stretch[] = [{ from: -Infinity, to: Infinity }];
  for (const s of shapes) left = shared(left, winStretches(s));
  return left.length > 0;
}

/** Whether one finishing price can win both bets, for two bets on the same ladder: only where their winning prices overlap. */
export function canBothWin(a: Shape, b: Shape): boolean {
  return canAllWin([a, b]);
}

/**
 * Three or more legs on one ladder that can win two by two and still never all win. Bets that each win on a single stretch of
 * prices cannot do this (stretches that overlap in pairs all share a price), but a breakout wins on two separate stretches, so
 * it can pair with a leg on each side of its band while those two legs need different sides. Legs are given in basket order,
 * with null for one that has no levels yet; a ladder that already has a pair that cannot both win is left to that pair.
 */
export function neverAllWin(legs: (JointLeg | null)[]): { legs: number[]; ticker: string }[] {
  const byTicker = new Map<string, number[]>();
  legs.forEach((leg, i) => {
    if (!leg) return;
    const on = byTicker.get(leg.ticker);
    if (on) on.push(i);
    else byTicker.set(leg.ticker, [i]);
  });
  const out: { legs: number[]; ticker: string }[] = [];
  for (const [ticker, on] of byTicker) {
    if (on.length < 3) continue;
    const shapes = on.map((i) => legs[i]!.shape);
    const pairsCan = shapes.every((a, x) => shapes.every((b, y) => y <= x || canBothWin(a, b)));
    if (pairsCan && !canAllWin(shapes)) out.push({ legs: on, ticker });
  }
  return out;
}

/** Where a leg wins, in words that follow "needs Bitcoin …": "at $63,500 or above", "below $62,500", "between $62,500 and $63,500", "outside $62,500 to $63,500". */
export function winsAt(shape: Shape): string {
  if (shape.kind === 'up') return `at ${money(shape.target)} or above`;
  if (shape.kind === 'down') return `below ${money(shape.target)}`;
  if (shape.kind === 'range') return `between ${money(shape.low)} and ${money(shape.high)}`;
  return `outside ${money(shape.low)} to ${money(shape.high)}`;
}

/**
 * Whether a ladder's bars can judge this leg. A bar is judged by its lower edge, which is only right when the leg's strikes are
 * edges of bars. A strike on a rung with no two-sided price is not an edge (the bar runs straight across it), so the leg is
 * left out instead of being given a figure that looks exact and is not.
 */
function readable(shape: Shape, d: Distribution): boolean {
  const strikes = 'low' in shape ? [shape.low, shape.high] : [shape.condition, shape.target];
  return strikes.every((k) => d.levels.some((l) => l.strike === k));
}

/** What several legs on one ladder do together, by adding up the bars. */
function onOneLadder(shapes: Shape[], buckets: Bucket[]): Pick<LadderGroup, 'allWin' | 'noneLose' | 'anyWin'> {
  let allWin = 0;
  let noneLose = 0;
  let anyWin = 0;
  for (const b of buckets) {
    const zones = shapes.map((s) => zoneOf(s, b));
    if (zones.every((z) => z === 'win')) allWin += b.chance;
    if (zones.every((z) => z !== 'lose')) noneLose += b.chance;
    if (zones.some((z) => z === 'win')) anyWin += b.chance;
  }
  return { allWin: clean(allWin), noneLose: clean(noneLose), anyWin: clean(anyWin) };
}

/** Rounding must not push the reference point outside the range, or the low end above the high one. */
function span(low: number, high: number, ifUnrelated: number): Span {
  const hi = clean(Math.min(1, Math.max(0, high)));
  const lo = Math.min(hi, clean(Math.min(1, Math.max(0, low))));
  return { low: lo, high: hi, ifUnrelated: Math.min(hi, Math.max(lo, clean(ifUnrelated))), exact: hi - lo < SAME };
}

/**
 * Every one of several things happening, when each one's chance is known and how they move together is not. It cannot beat
 * the least likely of them; and the chances that each one fails can at worst all fall on different outcomes, which leaves
 * the sum of the chances less one for each thing after the first.
 */
function everyOf(ps: number[]): Span {
  const sum = ps.reduce((n, p) => n + p, 0);
  return span(sum - (ps.length - 1), Math.min(...ps), ps.reduce((n, p) => n * p, 1));
}

/** At least one of them happening: no less likely than the likeliest, and no more than all their chances added up. */
function someOf(ps: number[]): Span {
  const sum = ps.reduce((n, p) => n + p, 0);
  return span(Math.max(...ps), sum, 1 - ps.reduce((n, p) => n * (1 - p), 1));
}

/**
 * The basket's legs taken together. `legs` are in basket order, with null for a leg that has no market or levels yet;
 * `ladders` gives each ticker's rungs as the exchange lists them.
 */
export function together(legs: (JointLeg | null)[], ladders: Record<string, Rung[] | undefined>): Together {
  const read = new Map<string, Distribution | null>();
  const distribution = (ticker: string): Distribution | null => {
    if (!read.has(ticker)) read.set(ticker, distributionOf(ladders[ticker] ?? []));
    return read.get(ticker) ?? null;
  };

  const missing: number[] = [];
  const byTicker = new Map<string, number[]>();
  legs.forEach((leg, i) => {
    const d = leg ? distribution(leg.ticker) : null;
    if (!leg || !d || !readable(leg.shape, d)) {
      missing.push(i);
      return;
    }
    const on = byTicker.get(leg.ticker);
    if (on) on.push(i);
    else byTicker.set(leg.ticker, [i]);
  });

  const groups: LadderGroup[] = [...byTicker].map(([ticker, on]) => {
    const d = distribution(ticker)!;
    return { ticker, legs: on, ...onOneLadder(on.map((i) => legs[i]!.shape), d.buckets), adjusted: d.adjusted };
  });

  // From the strikes alone, so a pair that cannot both win is named even while its ladder has no prices.
  const impossible: Together['impossible'] = [];
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i];
      const b = legs[j];
      if (a && b && a.ticker === b.ticker && !canBothWin(a.shape, b.shape)) impossible.push({ legs: [i, j], ticker: a.ticker });
    }
  }

  const whole = groups.length > 0 && missing.length === 0;
  return {
    groups,
    allWin: whole ? everyOf(groups.map((g) => g.allWin)) : null,
    noneLose: whole ? everyOf(groups.map((g) => g.noneLose)) : null,
    anyWin: whole ? someOf(groups.map((g) => g.anyWin)) : null,
    impossible,
    missing,
    adjusted: groups.some((g) => g.adjusted),
  };
}

// ------------------------------------------------------------------ in words

/** A chance as a whole percent, without rounding a real chance down to "0%" or a real doubt up to "100%". */
export function chanceWords(x: number): string {
  if (x > 0 && x < 0.005) return 'under 1%';
  if (x < 1 && x >= 0.995) return 'over 99%';
  return pct(x);
}

/**
 * A span's ends as whole percents, rounded outward: the span is what can happen however the markets move together, so a
 * printed range must hold all of it. Rounded to the nearest, 4.51% to 31.49% would read "5% to 31%" and leave out values that
 * are possible.
 */
export function spanEnds(s: Pick<Span, 'low' | 'high'>): { low: number; high: number } {
  // The small allowance keeps a figure like 0.29 (which is 28.999999999999996 per hundred) from falling to 28.
  return { low: Math.floor(s.low * 100 + 1e-9), high: Math.ceil(s.high * 100 - 1e-9) };
}

/** A span in words: one figure when its ends meet, "between 4% and 31%" when they do not. */
export function spanWords(s: Span): string {
  if (s.exact) return chanceWords(s.low);
  const low = pct(s.low);
  const high = pct(s.high);
  if (low !== high) {
    const ends = spanEnds(s);
    return `between ${ends.low}% and ${ends.high}%`;
  }
  // Ends that differ by less than a percent: one figure, marked as rounded.
  const one = chanceWords(s.high);
  return one === high ? `about ${one}` : one;
}
