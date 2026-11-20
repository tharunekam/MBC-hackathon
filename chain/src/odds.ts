/**
 * How the market's odds held up, across every verified call.
 *
 * Each reveal publishes the fair price the market gave the call when it was made (its chance of coming in) and, once the
 * market settled, whether it did. Grouped by that chance, the two together answer a question the per-player board cannot:
 * were the odds themselves any good? If calls the market gave about one chance in three came in about a third of the time,
 * its prices were honest and beating them took skill. A reader can rebuild this from the reveals on chain alone.
 */

export interface OddsBand {
  /** The band covers fair prices from `from` up to, not including, `to`. The last band includes 1. */
  from: number;
  to: number;
  /** Verified calls whose fair price fell in the band. */
  calls: number;
  /** How many of them came in. */
  cameIn: number;
  /** How many the market's own odds expected to come in: the sum of the calls' fair prices. */
  expected: number;
}

/** Four bands a person can read at a glance. Finer ones would be mostly empty at the size this board runs at. */
export const ODDS_EDGES = [0, 0.25, 0.5, 0.75, 1] as const;

export function oddsBands(calls: Iterable<{ fairPrice: number; outcome: 0 | 1 }>): OddsBand[] {
  const bands: OddsBand[] = [];
  for (let i = 0; i < ODDS_EDGES.length - 1; i++) bands.push({ from: ODDS_EDGES[i]!, to: ODDS_EDGES[i + 1]!, calls: 0, cameIn: 0, expected: 0 });
  for (const c of calls) {
    // A fair price is a chance. Anything else never came from this service's own reveals and is left out, not guessed at.
    if (!Number.isFinite(c.fairPrice) || c.fairPrice < 0 || c.fairPrice > 1) continue;
    const band = bands.find((b) => c.fairPrice < b.to) ?? bands[bands.length - 1]!;
    band.calls++;
    band.cameIn += c.outcome;
    band.expected += c.fairPrice;
  }
  for (const b of bands) b.expected = Math.round(b.expected * 10_000) / 10_000;
  return bands;
}
