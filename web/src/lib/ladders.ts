import type { MarketEvent, Rung } from '../api/types';

/**
 * What the builder does with the exchange's list of ladders, and where a ladder's prices sit on the chart.
 *
 * Written after the Gemini sandbox started listing 34 ladders (crypto, oil, metals, gas) of which four had prices. The tabs
 * ran thousands of pixels wide on a phone, the page could open on a ladder with nothing to quote, and a ladder that steps in
 * cents (XRP at $0.88 to $1.02) was drawn squashed into the left edge of its chart.
 */

const twoSided = (r: Rung): boolean => r.bid !== null && r.ask !== null;

/** Enough to draw a curve and quote a pair: at least two rungs with both a buy and a sell price. */
export const hasPrices = (e: MarketEvent): boolean => e.rungs.filter(twoSided).length >= 2;

export interface LadderList {
  /** The tabs, in a fixed order (soonest close first, then by name) so they do not jump about as prices move. */
  shown: MarketEvent[];
  /** Ladders the exchange lists that have no prices right now. Empty when none has prices (then all are shown). */
  unpriced: MarketEvent[];
  /** The ladder to open on: one you can bet on if there is one. */
  first: MarketEvent | undefined;
}

/** Lower is a better ladder to open on. */
function rank(e: MarketEvent): number {
  if (e.offerableCount > 0 && !e.ladderOutOfOrder) return 0;
  if (e.offerableCount > 0) return 1;
  if (hasPrices(e)) return e.ladderOutOfOrder ? 3 : 2;
  return 4;
}

const closes = (e: MarketEvent): number => (e.expiry ? new Date(e.expiry).getTime() : Infinity);

export function listLadders(events: MarketEvent[], showUnpriced = false): LadderList {
  // Not the exchange's order: Gemini's listing order changes between requests, and how many pairs are on offer changes
  // by the second.
  const ladders = events.filter((e) => e.rungs.length >= 2).sort((a, b) => closes(a) - closes(b) || a.title.localeCompare(b.title) || a.ticker.localeCompare(b.ticker));
  const priced = ladders.filter(hasPrices);
  // With nothing priced anywhere (the minutes after new ladders list) every ladder is shown, so the page is never empty.
  const unpriced = priced.length > 0 ? ladders.filter((e) => !hasPrices(e)) : [];
  const shown = priced.length === 0 ? ladders : showUnpriced ? [...priced, ...unpriced] : priced;
  const first = shown.reduce<MarketEvent | undefined>((best, e) => (best === undefined || rank(e) < rank(best) ? e : best), undefined);
  return { shown, unpriced, first };
}

/**
 * A round step for a price read off a ladder, between its rungs: a hundredth of a rung's gap, as a power of ten ($10 on a
 * $500 ladder, a tenth of a cent on a 2¢ one). A price worked out to the cent would claim more than the ladder knows.
 */
export function tickFor(gap: number): number {
  return gap > 0 ? 10 ** (Math.floor(Math.log10(gap)) - 1) : 1;
}

/** A price rounded to that step. */
export const snap = (x: number, tick: number): number => Math.round(x / tick) * tick;

/** The usual gap between a ladder's rungs: its span shared out over the gaps. Zero for fewer than two rungs. */
export function rungGap(strikes: number[]): number {
  if (strikes.length < 2) return 0;
  return (Math.max(...strikes) - Math.min(...strikes)) / (strikes.length - 1);
}

/**
 * Where a strike sits across the chart, from 0 (lowest rung) to 1 (highest). The span is used as it is: ladders step by
 * two cents as well as by hundreds of dollars.
 */
export function across(strike: number, lowest: number, highest: number): number {
  const span = highest - lowest;
  return span > 0 ? (strike - lowest) / span : 0.5;
}

/**
 * Which price labels fit under the chart. `xs` are the labels' positions in pixels, left to right.
 *
 * Evenly spaced rungs (nearly every ladder) are labelled at one steady stride, every second or third one, so the ticks along
 * an axis read as a scale and not as a list with a gap in it. The last rung is labelled too when it lands on the stride, or
 * when there is room for it (`lastGap`) beyond the last label kept; it is never forced in next to its neighbour.
 *
 * Rungs bunched unevenly (a far strike listed beside a cluster) are measured by their real positions instead: a label is
 * kept when it is at least `gap` from the last one kept, and the last rung is always labelled, taking its neighbour's place
 * if they would be closer than `lastGap`.
 */
export function spacedLabels(xs: number[], gap = 68, lastGap = 56): Set<number> {
  const kept = new Set<number>();
  const end = xs.length - 1;
  if (end < 0) return kept;
  const steps = xs.slice(1).map((x, i) => x - xs[i]!);
  if (steps.length > 0 && Math.max(...steps) <= Math.min(...steps) * 1.25 && Math.min(...steps) > 0) {
    const stride = Math.max(1, Math.ceil(gap / Math.min(...steps)));
    for (let i = 0; i <= end; i += stride) kept.add(i);
    const lastKept = Math.max(...kept);
    if (lastKept !== end && xs[end]! - xs[lastKept]! >= lastGap) kept.add(end);
    return kept;
  }
  let lastKept = -1;
  xs.forEach((x, i) => {
    if (lastKept < 0 || x - xs[lastKept]! >= gap) {
      kept.add(i);
      lastKept = i;
    }
  });
  if (!kept.has(end)) {
    if (xs[end]! - xs[lastKept]! < lastGap) kept.delete(lastKept);
    kept.add(end);
  }
  return kept;
}
