/**
 * Chances that are shown side by side must add up on screen.
 *
 * Rounding each one on its own does not do that: 37.6%, 15.6% and 46.8% add to 100 and round to 38, 16 and 47, which add to
 * 101, and a reader who checks the sum (people do) stops trusting every number near it. `wholePercents` rounds a set of shares
 * together: each is rounded down, and the points left over go to the shares that were rounded down the furthest (the
 * largest-remainder method), so the whole percents add to exactly 100 and no share moves by more than a point.
 */

/**
 * Whole percents for shares that together make a whole. The shares are scaled to their own sum first, so 0.376, 0.156 and
 * 0.468 and 37.6, 15.6 and 46.8 give the same answer, and prices that are a hair out of step still add to 100. Shares below
 * zero count as zero; if every share is zero, so is every percent.
 */
export function wholePercents(shares: number[]): number[] {
  const clean = shares.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const total = clean.reduce((n, s) => n + s, 0);
  if (!(total > 0)) return clean.map(() => 0);
  const exact = clean.map((s) => (s / total) * 100);
  const out = exact.map((x) => Math.floor(x + 1e-9));
  let left = 100 - out.reduce((n, x) => n + x, 0);
  // Hand the remaining points out by size of the part that was cut off; ties go to the larger share, then the earlier one.
  const order = exact
    .map((x, i) => ({ i, cut: x - out[i]!, share: x }))
    .sort((a, b) => b.cut - a.cut || b.share - a.share || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k]!.i]! += 1;
  return out;
}

/** The same as text: "38%". */
export const wholePercentText = (shares: number[]): string[] => wholePercents(shares).map((p) => `${p}%`);
