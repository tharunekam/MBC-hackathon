import type { OddsBand } from '../api/types';
import { pct } from './format';

/**
 * The leaderboard's second question: were the market's odds any good?
 *
 * Every revealed call publishes the chance the market gave it when it was made and whether it came in. The chain service
 * groups them by that chance (`odds` on the leaderboard answer). If calls given about one chance in three came in about a
 * third of the time, the prices were honest and an edge above zero was earned against a fair yardstick.
 */

/** "Under 25%", "25% to 50%", "75% or more". */
export function bandLabel(b: Pick<OddsBand, 'from' | 'to'>): string {
  if (b.from <= 0) return `Under ${pct(b.to)}`;
  if (b.to >= 1) return `${pct(b.from)} or more`;
  return `${pct(b.from)} to ${pct(b.to)}`;
}

export interface OddsTotals {
  calls: number;
  cameIn: number;
  expected: number;
}

export const oddsTotals = (bands: readonly OddsBand[]): OddsTotals =>
  bands.reduce<OddsTotals>((t, b) => ({ calls: t.calls + b.calls, cameIn: t.cameIn + b.cameIn, expected: t.expected + b.expected }), { calls: 0, cameIn: 0, expected: 0 });

/** A count the odds expected: a whole number when it is one, otherwise to one decimal ("4.8"). */
export const expectedText = (n: number): string => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));

/** A share of a band's calls, or a dash for a band with none. */
export const shareText = (count: number, calls: number): string => (calls > 0 ? pct(count / calls) : '–');

/** Below this many calls the table is shown but the page does not draw a conclusion from it. */
export const ENOUGH_CALLS = 20;

export type OddsVerdict = 'too_few' | 'in_line' | 'more' | 'fewer';

/**
 * Whether the calls came in about as often as the odds said. The yardstick is two standard deviations of the count the odds
 * expected, worked from the average chance (which can only overstate the spread, so it errs towards "in line").
 */
export function oddsVerdict(t: OddsTotals): OddsVerdict {
  if (t.calls < ENOUGH_CALLS) return 'too_few';
  const mean = t.expected / t.calls;
  const spread = Math.sqrt(t.calls * mean * (1 - mean));
  if (Math.abs(t.cameIn - t.expected) <= 2 * spread) return 'in_line';
  return t.cameIn > t.expected ? 'more' : 'fewer';
}

/** The table in a sentence or two. Null with no calls, when there is nothing to say and the card is not shown. */
export function oddsWords(bands: readonly OddsBand[]): string | null {
  const t = oddsTotals(bands);
  if (t.calls === 0) return null;
  const head = `Of ${t.calls} revealed ${t.calls === 1 ? 'call' : 'calls'}, ${t.cameIn} came in; the market’s own odds expected about ${expectedText(t.expected)}.`;
  switch (oddsVerdict(t)) {
    case 'too_few':
      return `${head} That is too few to say whether its odds were right.`;
    case 'in_line':
      return `${head} That is in line with its odds, so an edge above zero was earned against a fair yardstick.`;
    case 'more':
      return `${head} More came in than its odds allowed for: the players who revealed, taken together, beat the market.`;
    case 'fewer':
      return `${head} Fewer came in than its odds allowed for: taken together, the market beat the players who revealed.`;
  }
}
