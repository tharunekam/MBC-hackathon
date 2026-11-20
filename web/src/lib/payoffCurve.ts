import type { Rung } from '../api/types';
import { distributionOf, zoneOf, type Bucket, type Shape } from './distribution';

/**
 * What several bets on one ladder pay, taken together, at each price the ladder can finish at.
 *
 * One finishing price decides every bet on a ladder, so adding the bets up bar by bar gives the whole position's result for
 * each bar exactly: no model, only the exchange's prices and what each bet wins or loses. It is the picture of the shape a
 * basket makes. A rising parlay and a range around its target, say, pay most in one band and lose a known amount elsewhere;
 * a breakout with a range inside it cannot lose both.
 *
 * Bets on different ladders are decided by different prices, so they are never added together here: each ladder gets its own
 * curve.
 */

/** One bet, as far as its result goes: its ladder, the strikes that decide it, and what it nets in each of its results. */
export interface LegPay {
  ticker: string;
  shape: Shape;
  /** Dollars won if it wins (after what it cost). */
  win: number;
  /** Dollars lost if it loses, as a negative number. */
  lose: number;
  /** Net result when the stake comes back. Zero unless the bet says otherwise. */
  back?: number;
}

export interface CurveBar {
  bucket: Bucket;
  /** The bets' net result, added up, if the price finishes in this bar. */
  net: number;
}

export interface LadderCurve {
  ticker: string;
  /** Which bets, by their place in the list, from 0. */
  legs: number[];
  /** One per bar of the ladder's histogram, lowest prices first. */
  bars: CurveBar[];
  /** The market's chance these bets end ahead, level, and behind, taken together. They add up to 1. */
  ahead: number;
  level: number;
  behind: number;
  best: number;
  worst: number;
  /**
   * The average result at the market's own odds. With no spread or fees it would be zero, so this number is what the bets
   * cost over fair value, in dollars.
   */
  average: number;
  /** True when this ladder's prices were out of order and had to be evened out first. */
  adjusted: boolean;
}

const clean = (x: number) => Math.round(x * 1e8) / 1e8;
/** A result this close to nothing is "level": a stake that came back, not a win or a loss. */
const LEVEL = 0.005;

/** What one bet nets in one bar. */
export function payIn(leg: LegPay, bucket: Bucket): number {
  const zone = zoneOf(leg.shape, bucket);
  return zone === 'win' ? leg.win : zone === 'lose' ? leg.lose : (leg.back ?? 0);
}

/**
 * The curve for each ladder the bets use, in the order the list first uses them. `legs` are in list order, with null for a
 * bet that is not ready (no market, no levels, no figures yet); those, and bets on a ladder with too few prices or on a rung
 * with no two-sided price, are left out and reported in `missing`.
 */
export function payoffCurves(legs: (LegPay | null)[], ladders: Record<string, Rung[] | undefined>): { curves: LadderCurve[]; missing: number[] } {
  const missing: number[] = [];
  const groups = new Map<string, number[]>();
  const dists = new Map<string, ReturnType<typeof distributionOf>>();
  legs.forEach((leg, i) => {
    if (!leg || !Number.isFinite(leg.win) || !Number.isFinite(leg.lose)) return void missing.push(i);
    if (!dists.has(leg.ticker)) dists.set(leg.ticker, distributionOf(ladders[leg.ticker] ?? []));
    const d = dists.get(leg.ticker);
    const strikes = leg.shape.kind === 'up' || leg.shape.kind === 'down' ? [leg.shape.condition, leg.shape.target] : [leg.shape.low, leg.shape.high];
    // A bar is judged by its lower edge, which is only right when the bet's strikes are edges of bars.
    if (!d || !strikes.every((k) => d.levels.some((l) => l.strike === k))) return void missing.push(i);
    const on = groups.get(leg.ticker);
    if (on) on.push(i);
    else groups.set(leg.ticker, [i]);
  });

  const curves: LadderCurve[] = [...groups].map(([ticker, on]) => {
    const d = dists.get(ticker)!;
    const bars = d.buckets.map((bucket) => ({ bucket, net: clean(on.reduce((sum, i) => sum + payIn(legs[i]!, bucket), 0)) }));
    let ahead = 0;
    let behind = 0;
    let average = 0;
    for (const b of bars) {
      if (b.net > LEVEL) ahead += b.bucket.chance;
      else if (b.net < -LEVEL) behind += b.bucket.chance;
      average += b.bucket.chance * b.net;
    }
    return {
      ticker,
      legs: on,
      bars,
      ahead: clean(ahead),
      behind: clean(behind),
      level: clean(Math.max(0, 1 - ahead - behind)),
      best: Math.max(...bars.map((b) => b.net)),
      worst: Math.min(...bars.map((b) => b.net)),
      average: clean(average),
      adjusted: d.adjusted,
    };
  });
  return { curves, missing };
}
