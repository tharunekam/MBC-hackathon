import type { Rung } from '../api/types';
import { bucketLabel, distributionOf, evenBand, type Bucket, type Level } from './distribution';
import { cents, money } from './format';
import { feeRate } from './pricing';

/**
 * From "what I want to receive at each finishing price" to the exact orders that pay it.
 *
 * A ladder read as a histogram has one bar per gap between neighbouring levels, plus one below the lowest level and one at or
 * above the highest: bars 0..n for n priced levels, with level i sitting between bar i and bar i+1. A YES at level i pays $1 a
 * contract in bars i+1..n and a NO pays $1 a contract in bars 0..i. So a shape that changes only at the levels is bought one
 * step at a time: where the wanted amount goes UP across a level, buy that many YES there; where it goes DOWN, buy that many
 * NO. Nothing else is needed, and nothing is modelled.
 *
 * The orders pay the shape plus a fixed amount in every bar (`back`), because each NO also pays in all the bars below it. That
 * amount returns wherever the price finishes, so what is really at risk is what the orders cost less that amount. The Range
 * page calls the same thing the dollar that always comes back.
 *
 * A shape is measured above its lowest bar. Wanting $3 everywhere and $13 in the middle is wanting $10 in the middle: the $3
 * is money a person simply keeps, and no order pays it. `floor` says how much was set aside that way.
 *
 * The three bets the app sells are the two-order cases of this, and `handover` names them so the page can open the builder.
 */

/** A slider runs from nothing to this many dollars, a dollar at a time. */
export const MAX_PAY = 20;
/** What a preset pays in the bars it lights. */
export const PRESET_PAY = 10;
/** A result has to beat this to count as ahead or behind: half a cent, so "+$0.00" is never called a win. */
const AHEAD = 0.005;
const SAME = 1e-9;

const clean = (x: number) => Math.round(x * 1e8) / 1e8;

export interface SketchOrder {
  /** Which level the order is on, counted from the lowest priced one. */
  level: number;
  symbol: string;
  /** The exchange's own name for the contract. */
  label: string;
  strike: number;
  outcome: 'yes' | 'no';
  contracts: number;
  /** One contract before the fee: the ask for a YES, a dollar less the bid for a NO. */
  price: number;
  /** The taker fee on one contract. */
  fee: number;
  /** contracts × (price + fee). */
  cost: number;
}

/** One end of a two-order bet: the contract and its price level. */
export interface SketchLeg {
  symbol: string;
  strike: number;
}

/**
 * What a set of orders is, as far as the app's builders go. `none` has nothing to buy, `single` is one plain contract (not
 * something the app sells on its own), `range`, `breakout` and `parlay` are the bets a builder places, and `other` is every
 * other shape, with how many orders it takes.
 */
export type Handover =
  | { kind: 'none' }
  | { kind: 'single'; order: SketchOrder }
  | { kind: 'range'; low: SketchLeg; high: SketchLeg }
  | { kind: 'breakout'; low: SketchLeg; high: SketchLeg }
  | { kind: 'parlay'; direction: 'up' | 'down'; condition: SketchLeg; target: SketchLeg }
  | { kind: 'other'; orders: number };

/** A net result and every bar that gives it. */
export interface Extreme {
  net: number;
  bars: number[];
}

export interface Sketch {
  /** True when every bar was asked to pay the same: there is nothing to buy. */
  flat: boolean;
  /** The amount asked for in every bar, which no order pays. The shape is what is wanted above it. */
  floor: number;
  /** The shape itself: what is wanted in each bar above the floor. */
  shape: number[];
  /** Lowest level first. */
  orders: SketchOrder[];
  /** What the orders pay in each bar: the shape plus `back`. */
  receive: number[];
  /** Dollars the orders pay wherever the price finishes. */
  back: number;
  /** What leaves the account now: every order's cost, fees included. */
  pay: number;
  /** The fees inside `pay`. */
  fees: number;
  /** pay − back: the most that can be lost. */
  atRisk: number;
  /** What each bar nets: receive − pay, which is the shape − atRisk. */
  net: number[];
  /** What the shape is worth at the market's own odds: each bar's amount times the market's chance of it. */
  fair: number;
  /** atRisk − fair: what the shape costs over the market's own odds. */
  over: number;
  /** The market's chance of finishing in a bar that nets more than nothing. */
  chanceAhead: number;
  best: Extreme;
  worst: Extreme;
  handover: Handover;
}

/** The step across each level: what is wanted just above it less what is wanted just below. One fewer than the bars. */
export function stepsOf(wanted: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < wanted.length - 1; i++) out.push(clean(wanted[i + 1]! - wanted[i]!));
  return out;
}

/** What a set of orders pays if the price finishes in a bar: every YES below the bar and every NO at or above it. */
export function paysIn(orders: Pick<SketchOrder, 'level' | 'outcome' | 'contracts'>[], bar: number): number {
  let total = 0;
  for (const o of orders) if (o.outcome === 'yes' ? o.level < bar : o.level >= bar) total += o.contracts;
  return clean(total);
}

/**
 * Which of the app's bets a set of orders is. Two orders make four patterns. YES on the lower level with NO on the higher, the
 * same size, is a Range. NO on the lower with YES on the higher is a Breakout when they are the same size and a Return Parlay
 * when they are not: the bigger order is the one the bet is about and the smaller one is what hands the stake back, so a bigger
 * YES is a rising parlay (first level the lower, target the higher) and a bigger NO is a falling one (first level the higher,
 * target the lower). The rest are not built.
 */
export function handoverOf(orders: SketchOrder[]): Handover {
  if (orders.length === 0) return { kind: 'none' };
  if (orders.length === 1) return { kind: 'single', order: orders[0]! };
  if (orders.length === 2) {
    const [lower, higher] = [...orders].sort((a, b) => a.level - b.level) as [SketchOrder, SketchOrder];
    const low = { symbol: lower.symbol, strike: lower.strike };
    const high = { symbol: higher.symbol, strike: higher.strike };
    const same = Math.abs(lower.contracts - higher.contracts) < SAME;
    if (lower.outcome === 'yes' && higher.outcome === 'no' && same) return { kind: 'range', low, high };
    if (lower.outcome === 'no' && higher.outcome === 'yes') {
      if (same) return { kind: 'breakout', low, high };
      return higher.contracts > lower.contracts ? { kind: 'parlay', direction: 'up', condition: low, target: high } : { kind: 'parlay', direction: 'down', condition: high, target: low };
    }
  }
  return { kind: 'other', orders: orders.length };
}

/** Where the builder for a recognised shape opens with its levels already chosen. Null for a shape no builder places. */
export function handoverLink(ticker: string, h: Handover): string | null {
  const q = new URLSearchParams({ market: ticker });
  if (h.kind === 'range' || h.kind === 'breakout') {
    q.set('low', h.low.symbol);
    q.set('high', h.high.symbol);
    // A breakout is built on the Range page, on its other side.
    if (h.kind === 'breakout') q.set('side', 'out');
    return `/range?${q}`;
  }
  if (h.kind === 'parlay') {
    q.set('condition', h.condition.symbol);
    q.set('target', h.target.symbol);
    if (h.direction === 'down') q.set('direction', 'down');
    return `/parlay?${q}`;
  }
  return null;
}

/**
 * The orders that pay a wanted shape on a ladder, and what they cost at the exchange's prices.
 *
 * `wanted` is dollars per bar, lowest prices first, one more than the ladder's priced levels. Only rungs with both a buy and a
 * sell price are levels, the same ones `distributionOf` keeps, so the bars here are the bars the chart draws. Null when the
 * ladder has fewer than two such rungs or `wanted` does not have one amount per bar.
 */
export function sketchOf(rungs: Rung[], wanted: number[], feeCoef = 0): Sketch | null {
  const dist = distributionOf(rungs);
  if (!dist || wanted.length !== dist.buckets.length) return null;
  const { levels, buckets } = dist;

  // An amount that is not a number, or is below zero, is nothing.
  const asked = wanted.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const floor = Math.min(...asked);
  const shape = asked.map((w) => clean(w - floor));

  const orders: SketchOrder[] = [];
  stepsOf(shape).forEach((d, i) => {
    if (Math.abs(d) < SAME) return;
    const level = levels[i]!;
    // Each level's prices come from the rung with its symbol, never from its place in the exchange's list.
    const rung = rungs.find((r) => r.symbol === level.symbol)!;
    const outcome = d > 0 ? 'yes' : 'no';
    const price = outcome === 'yes' ? rung.ask! : clean(1 - rung.bid!);
    const fee = clean(feeRate(price, feeCoef));
    const contracts = Math.abs(d);
    orders.push({ level: i, symbol: rung.symbol, label: rung.label, strike: rung.strike, outcome, contracts, price, fee, cost: clean(contracts * (price + fee)) });
  });

  const receive = buckets.map((_, b) => paysIn(orders, b));
  // Every NO pays in the lowest bar, and the shape wants `shape[0]` there. What is left over is paid in every other bar too.
  const back = clean(orders.reduce((n, o) => n + (o.outcome === 'no' ? o.contracts : 0), 0) - shape[0]!);
  const pay = clean(orders.reduce((n, o) => n + o.cost, 0));
  const fees = clean(orders.reduce((n, o) => n + o.contracts * o.fee, 0));
  const atRisk = clean(pay - back);
  const net = shape.map((s) => clean(s - atRisk));
  const fair = clean(shape.reduce((n, s, b) => n + s * buckets[b]!.chance, 0));

  const extreme = (pick: (...xs: number[]) => number): Extreme => {
    const value = pick(...net);
    return { net: value, bars: net.flatMap((x, b) => (Math.abs(x - value) < AHEAD ? [b] : [])) };
  };

  return {
    flat: orders.length === 0,
    floor,
    shape,
    orders,
    receive,
    back,
    pay,
    fees,
    atRisk,
    net,
    fair,
    over: clean(atRisk - fair),
    chanceAhead: clean(net.reduce((n, x, b) => n + (x > AHEAD ? buckets[b]!.chance : 0), 0)),
    best: extreme(Math.max),
    worst: extreme(Math.min),
    handover: handoverOf(orders),
  };
}

// ------------------------------------------------------------------ in words

/** A number of contracts: whole when it is whole, otherwise to the hundredth, which is the smallest the exchange trades. */
export const contractsText = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** An order as one plain line, with the exchange's own name for the contract: "Buy 10 YES on $62,500 or above at 82¢". */
export function orderText(o: Pick<SketchOrder, 'contracts' | 'outcome' | 'label' | 'strike' | 'price'>): string {
  // A contract the exchange gave no name is named by what every rung on a ladder is: its price level, or above.
  const name = o.label.trim() || `${money(o.strike)} or above`;
  return `Buy ${contractsText(o.contracts)} ${o.outcome === 'yes' ? 'YES' : 'NO'} on ${name} at ${cents(o.price)}`;
}

/**
 * Where a set of bars is, in words. Bars side by side are read as one price range, so the two bars of a range say
 * "$62,500 to $63,500" and the bars either side of it "Below $62,500, or $63,500 or more".
 */
export function whereText(buckets: Bucket[], bars: number[]): string {
  const runs: Bucket[] = [];
  let last = -2;
  for (const b of [...bars].sort((x, y) => x - y)) {
    const bucket = buckets[b];
    if (!bucket) continue;
    const open = runs[runs.length - 1];
    if (open && b === last + 1) runs[runs.length - 1] = { from: open.from, to: bucket.to, chance: open.chance + bucket.chance };
    else runs.push({ ...bucket });
    last = b;
  }
  return runs.map(bucketLabel).join(', or ');
}

// ------------------------------------------------------------------ shapes to start from

export type PresetId = 'stays' | 'moves' | 'higher' | 'lower' | 'clear';

export const PRESETS: readonly { id: PresetId; name: string }[] = [
  { id: 'stays', name: 'Stays put' },
  { id: 'moves', name: 'Big move' },
  { id: 'higher', name: 'Higher' },
  { id: 'lower', name: 'Lower' },
  { id: 'clear', name: 'Clear' },
];

/**
 * The two levels nearest the ends of the band the market gives an even chance of holding (`evenBand`), as places in `levels`.
 * A ladder that does not reach a 75% or a 25% chance has no such band; then the levels whose own chances are nearest those
 * two are used. Given two levels or more, the two are always different levels, lower first.
 */
export function bandLevels(levels: Level[]): [number, number] {
  if (levels.length < 2) return [0, 0];
  const nearest = (value: number, of: (l: Level) => number): number => levels.reduce((best, l, i) => (Math.abs(of(l) - value) < Math.abs(of(levels[best]!) - value) ? i : best), 0);
  const band = evenBand(levels);
  let lo = band ? nearest(band.low, (l) => l.strike) : nearest(0.75, (l) => l.chance);
  let hi = band ? nearest(band.high, (l) => l.strike) : nearest(0.25, (l) => l.chance);
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) {
    if (lo < levels.length - 1) hi = lo + 1;
    else lo = hi - 1;
  }
  return [lo, hi];
}

/**
 * A shape to start from, as dollars per bar over a ladder's levels. "Stays put" pays in the bars inside the market's
 * even-chance band and "Big move" in the bars outside it; "Higher" and "Lower" pay in the top and bottom third of the bars.
 */
export function presetShape(id: PresetId, levels: Level[], pay = PRESET_PAY): number[] {
  const bars = levels.length + 1;
  if (id === 'clear' || levels.length === 0) return Array<number>(bars).fill(0);
  if (id === 'higher' || id === 'lower') {
    const third = Math.max(1, Math.round(bars / 3));
    return Array.from({ length: bars }, (_, b) => ((id === 'higher' ? b >= bars - third : b < third) ? pay : 0));
  }
  if (levels.length < 2) return Array<number>(bars).fill(0);
  const [lo, hi] = bandLevels(levels);
  // Level i sits under bar i+1, so the bars between the two levels are lo+1..hi.
  return Array.from({ length: bars }, (_, b) => ((b > lo && b <= hi) === (id === 'stays') ? pay : 0));
}
