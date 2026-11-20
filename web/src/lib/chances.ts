import type { Direction } from '../api/types';
import { wholePercents } from './shares';

/**
 * One set of whole percents per bet, for every place on a page that shows its chances.
 *
 * A builder shows the same chances four or five times: the bar on the ticket, the figures under it, the payoff table, the
 * labels on the chart's handles and the histogram. Rounding each on its own made them disagree by a point (38% + 2% + 61%),
 * and rounding each SET on its own still let two sets differ (the bar said 38%, the histogram 37%). So every bet on two levels
 * is rounded once, the same way everywhere: the two levels cut the ladder into three stretches of price (below the lower
 * level, between the two, at or above the higher), those three are rounded together with `wholePercents`, and every other
 * figure is a sum of them. They add to 100 wherever they are shown, and a figure reads the same in every place it appears.
 */

/** Chances are counted in ten-thousandths before rounding, so the dust left by float arithmetic cannot tip a tie one way here and the other way there. */
const UNITS = 10_000;
const units = (x: number): number => (Number.isFinite(x) && x > 0 ? Math.round(x * UNITS) : 0);

/** Whole percents for the three stretches, lowest prices first. */
export type Zones = [below: number, between: number, above: number];

export function zonePercents(below: number, between: number, above: number): Zones {
  const [a = 0, b = 0, c = 0] = wholePercents([units(below), units(between), units(above)]);
  return [a, b, c];
}

export interface ParlayPercents {
  win: number;
  back: number;
  lose: number;
  /** The first level holds: the bet is on, to win or to lose. Always `win + lose`. */
  holds: number;
  /** The same three along the ladder, lowest prices first, for a histogram drawn under the bet. */
  zones: Zones;
}

/**
 * A parlay's three results. `chanceFirst` is the chance its first level holds and `chanceBoth` the chance it wins, as the
 * quote gives them. A rising bet gets its stake back below the first level and wins above the target; a falling one is the
 * mirror image, so its three results lie the other way along the ladder.
 */
export function parlayPercents(direction: Direction, chanceFirst: number, chanceBoth: number): ParlayPercents {
  const back = 1 - chanceFirst;
  const lose = chanceFirst - chanceBoth;
  if (direction === 'down') {
    const [w, l, b] = zonePercents(chanceBoth, lose, back);
    return { win: w, lose: l, back: b, holds: w + l, zones: [w, l, b] };
  }
  const [b, l, w] = zonePercents(back, lose, chanceBoth);
  return { win: w, lose: l, back: b, holds: w + l, zones: [b, l, w] };
}

export interface LevelsPercents {
  below: number;
  between: number;
  above: number;
  /** Between the two levels for a range, outside them for a breakout. */
  win: number;
  lose: number;
}

/** A range (`in`) or a breakout (`out`), from the chance of finishing at or above each of its two levels. */
export function levelsPercents(side: 'in' | 'out', chanceLow: number, chanceHigh: number): LevelsPercents {
  const [below, between, above] = zonePercents(1 - chanceLow, chanceLow - chanceHigh, chanceHigh);
  return side === 'out' ? { below, between, above, win: below + above, lose: between } : { below, between, above, win: between, lose: below + above };
}

/**
 * A whole number shared out over parts in proportion to their sizes, so the parts add back up to it exactly: each part is
 * rounded down and what is left over goes to the parts that lost the most (the method `wholePercents` uses for 100).
 */
export function shareOut(total: number, shares: number[]): number[] {
  const clean = shares.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const sum = clean.reduce((n, s) => n + s, 0);
  if (!(sum > 0) || !(total > 0)) return clean.map(() => 0);
  const exact = clean.map((s) => (s / sum) * total);
  const out = exact.map((x) => Math.floor(x + 1e-9));
  let left = Math.round(total) - out.reduce((n, x) => n + x, 0);
  const order = exact.map((x, i) => ({ i, cut: x - out[i]!, share: x })).sort((a, b) => b.cut - a.cut || b.share - a.share || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k]!.i]! += 1;
  return out;
}

/**
 * Whole percents for a histogram's bars under a bet: the three stretches are rounded first, then each stretch's percent is
 * shared out over its own bars. The bars add to 100, and the bars of a stretch add to the figure shown for it. `zoneOf` says
 * which stretch a bar lies in: 0 below the lower level, 1 between, 2 at or above the higher.
 *
 * `given` is the ticket's own three figures, when the page has them. The ticket's come from the executor's quote and the
 * bars from the market list, two readings a moment apart, so on a moving market they can differ by a point; the bars are
 * then labelled to add up to what the ticket says, and the page shows one set of figures, not two.
 */
export function barPercents(chances: number[], zoneOf: (index: number) => 0 | 1 | 2, given?: Zones | null): { bars: number[]; zones: Zones } {
  const sums = [0, 0, 0];
  chances.forEach((c, i) => (sums[zoneOf(i)]! += Number.isFinite(c) && c > 0 ? c : 0));
  const zones = given ?? zonePercents(sums[0]!, sums[1]!, sums[2]!);
  const bars = chances.map(() => 0);
  for (const z of [0, 1, 2] as const) {
    const members = chances.map((_, i) => i).filter((i) => zoneOf(i) === z);
    shareOut(zones[z], members.map((i) => units(chances[i]!))).forEach((p, k) => (bars[members[k]!] = p));
  }
  return { bars, zones };
}
