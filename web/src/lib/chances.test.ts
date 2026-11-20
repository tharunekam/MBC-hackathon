import { describe, expect, it } from 'vitest';
import { barPercents, levelsPercents, parlayPercents, shareOut, zonePercents } from './chances';

const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);

describe('a parlay’s three chances', () => {
  it('add to 100 where rounding each on its own gave 101', () => {
    // The audit's case: stake back 37.6%, win 15.6%, lose 46.8% rounded to 38 + 16 + 47.
    const p = parlayPercents('up', 1 - 0.376, 0.156);
    expect(p.back + p.win + p.lose).toBe(100);
    expect(p).toMatchObject({ back: 38, win: 15, lose: 47 });
    expect(p.holds).toBe(p.win + p.lose);
  });

  it('add to 100 for every pair of half-cent prices, rising and falling', () => {
    for (let first = 0.02; first < 1; first += 0.005) {
      for (let both = 0.005; both < first; both += 0.035) {
        for (const direction of ['up', 'down'] as const) {
          const p = parlayPercents(direction, first, both);
          expect(p.win + p.back + p.lose).toBe(100);
          expect(Math.abs(p.win - both * 100)).toBeLessThanOrEqual(1);
          expect(Math.abs(p.back - (1 - first) * 100)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('are not tipped by the dust float arithmetic leaves: the same prices give the same figures however they were worked out', () => {
    // 0.53 - 0.375 is 0.15500000000000003 in floating point; a histogram that adds its bars up gets 0.155.
    const fromQuote = parlayPercents('up', 0.53, 0.375);
    const [back, lose, win] = zonePercents(0.47, 0.155, 0.375);
    expect(fromQuote).toMatchObject({ back, lose, win });
  });

  it('a falling bet is the mirror image: it wins at the low end of the ladder', () => {
    const up = parlayPercents('up', 0.8, 0.3);
    const down = parlayPercents('down', 0.8, 0.3);
    expect(up).toMatchObject({ win: 30, lose: 50, back: 20 });
    expect(down).toMatchObject({ win: 30, lose: 50, back: 20 });
  });
});

describe('a range and a breakout on the same two levels', () => {
  it('split the same three stretches, so one wins exactly where the other loses', () => {
    const inside = levelsPercents('in', 0.745, 0.3);
    const outside = levelsPercents('out', 0.745, 0.3);
    expect(inside.win + inside.lose).toBe(100);
    expect(outside.win).toBe(inside.lose);
    expect(outside.lose).toBe(inside.win);
    expect(inside.win).toBe(inside.between);
    expect(outside.win).toBe(outside.below + outside.above);
  });

  it('the chance of each handle and the chance inside agree: at or above the floor, less at or above the ceiling', () => {
    for (let low = 0.3; low < 1; low += 0.045) {
      for (let high = 0.005; high < low; high += 0.04) {
        const p = levelsPercents('in', low, high);
        expect(p.below + p.between + p.above).toBe(100);
        // "At or above the floor" is between + above, "below the ceiling" is below + between; together they overlap by the inside.
        expect(p.between + p.above + (p.below + p.between) - 100).toBe(p.win);
      }
    }
  });
});

describe('sharing a whole number out', () => {
  it('adds back up exactly, each part within one of its exact share', () => {
    expect(shareOut(100, [37.6, 15.6, 46.8])).toEqual([38, 15, 47]);
    expect(sum(shareOut(7, [1, 1, 1]))).toBe(7);
    expect(shareOut(2, [100, 50, 50])).toEqual([1, 1, 0]);
    expect(shareOut(0, [1, 2])).toEqual([0, 0]);
    expect(shareOut(5, [0, 0])).toEqual([0, 0]);
    expect(shareOut(10, [1, Number.NaN, -3])).toEqual([10, 0, 0]);
  });
});

describe('a histogram under a bet', () => {
  // Nine bars, as an eight-rung ladder gives: half-cent chances that each round up on their own (sum 104).
  const chances = [0.015, 0.035, 0.105, 0.205, 0.265, 0.185, 0.115, 0.055, 0.02];
  // A rising parlay with its first level at the third rung and its target at the sixth.
  const zoneOf = (i: number) => (i < 3 ? 0 : i < 6 ? 1 : 2);

  it('bars add to exactly 100, and each stretch’s bars add to the figure shown for that stretch', () => {
    expect(sum(chances.map((c) => Math.round(c * 100 + 1e-9)))).toBeGreaterThan(100);
    const { bars, zones } = barPercents(chances, zoneOf);
    expect(sum(bars)).toBe(100);
    for (const z of [0, 1, 2] as const) expect(sum(bars.filter((_, i) => zoneOf(i) === z))).toBe(zones[z]);
    bars.forEach((p, i) => expect(Math.abs(p - chances[i]! * 100)).toBeLessThan(1.5));
  });

  it('the stretches are the ticket’s own figures', () => {
    const { zones } = barPercents(chances, zoneOf);
    const first = 1 - (0.015 + 0.035 + 0.105);
    const both = 0.115 + 0.055 + 0.02;
    const p = parlayPercents('up', first, both);
    expect(zones).toEqual([p.back, p.lose, p.win]);
  });

  it('labels the bars to add up to the ticket’s figures when the page hands them over, even if the two were read a moment apart', () => {
    // The ticket (from the quote) says 17 / 49 / 34; the market list, a moment later, would round to 15 / 66 / 19.
    const { bars, zones } = barPercents(chances, zoneOf, [17, 49, 34]);
    expect(zones).toEqual([17, 49, 34]);
    expect(sum(bars)).toBe(100);
    for (const z of [0, 1, 2] as const) expect(sum(bars.filter((_, i) => zoneOf(i) === z))).toBe([17, 49, 34][z]);
    const p = parlayPercents('up', 0.83, 0.34);
    expect(p.zones).toEqual([p.back, p.lose, p.win]);
    const d = parlayPercents('down', 0.83, 0.34);
    expect(d.zones).toEqual([d.win, d.lose, d.back]);
  });

  it('copes with an empty stretch and with no chances at all', () => {
    expect(barPercents([0.4, 0.6], (i) => (i === 0 ? 0 : 2))).toEqual({ bars: [40, 60], zones: [40, 0, 60] });
    expect(barPercents([0, 0], () => 1)).toEqual({ bars: [0, 0], zones: [0, 0, 0] });
  });
});
