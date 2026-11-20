import { describe, expect, it } from 'vitest';
import type { Rung } from '../api/types';
import { bucketLabel, chanceAt, distributionOf, evenBand, likeliest, marketView, moveText, neverRising, priceAtChance, viewBuckets, viewOf, zoneChances, zoneOf, type Shape } from './distribution';

const rung = (strike: number, chance: number | null, spread = 0.02): Rung => ({
  symbol: `S${strike}`,
  label: `$${strike}`,
  strike,
  bid: chance === null ? null : chance - spread,
  ask: chance === null ? null : chance + spread,
  open: true,
  state: 'active/open',
});

// The README's example prices sit on this ladder: 62,500 at 82% and 63,500 at 41%.
const ladder = [rung(61500, 0.97), rung(62000, 0.92), rung(62500, 0.82), rung(63000, 0.62), rung(63500, 0.41), rung(64000, 0.2), rung(64500, 0.08)];
const sum = (xs: { chance: number }[]) => xs.reduce((n, x) => n + x.chance, 0);

describe('a ladder read as a histogram', () => {
  it('has one bar per gap between rungs and one beyond each end, and the bars add up to 1', () => {
    const d = distributionOf(ladder)!;
    expect(d.levels).toHaveLength(7);
    expect(d.buckets).toHaveLength(8);
    expect(sum(d.buckets)).toBeCloseTo(1, 8);
    expect(d.adjusted).toBe(false);
  });

  it('gives each bar the difference of its two rungs', () => {
    const d = distributionOf(ladder)!;
    expect(d.buckets[0]).toEqual({ from: null, to: 61500, chance: 0.03 });
    expect(d.buckets[3]).toEqual({ from: 62500, to: 63000, chance: 0.2 });
    expect(d.buckets[7]).toEqual({ from: 64500, to: null, chance: 0.08 });
  });

  it('does not depend on the order the exchange lists the rungs in', () => {
    expect(distributionOf([...ladder].reverse())).toEqual(distributionOf(ladder));
  });

  it('leaves out rungs with one-sided books and needs two priced rungs', () => {
    const d = distributionOf([rung(1, 0.9), rung(2, null), rung(3, 0.4)])!;
    expect(d.levels.map((l) => l.strike)).toEqual([1, 3]);
    expect(d.buckets.map((b) => b.chance)).toEqual([0.1, 0.5, 0.4]);
    expect(distributionOf([rung(1, 0.9), rung(2, null)])).toBeNull();
  });

  it('averages rungs that are out of order, says so, and never draws a negative bar', () => {
    const d = distributionOf([rung(1, 0.9), rung(2, 0.5), rung(3, 0.6), rung(4, 0.2)])!;
    expect(d.adjusted).toBe(true);
    expect(d.levels.map((l) => l.chance)).toEqual([0.9, 0.55, 0.55, 0.2]);
    expect(d.buckets.every((b) => b.chance >= 0)).toBe(true);
    expect(sum(d.buckets)).toBeCloseTo(1, 8);
  });

  it('names the likeliest bar', () => {
    expect(likeliest(distributionOf(ladder)!.buckets)).toEqual({ from: 63000, to: 63500, chance: 0.21 });
  });
});

describe('the never-rising fit', () => {
  it('leaves a falling sequence alone', () => {
    expect(neverRising([0.9, 0.5, 0.5, 0.1])).toEqual([0.9, 0.5, 0.5, 0.1]);
  });
  it('pools a run of violations into one average', () => {
    const out = neverRising([0.5, 0.6, 0.7, 0.1]);
    out.slice(0, 3).forEach((x) => expect(x).toBeCloseTo(0.6, 10));
    expect(out[3]).toBe(0.1);
  });
});

describe('reading a price off the ladder', () => {
  const { levels } = distributionOf(ladder)!;
  it('finds the even-chance price between the two rungs that straddle it', () => {
    // 62% at 63,000 and 41% at 63,500: 50% is 12/21 of the way across.
    expect(priceAtChance(levels, 0.5)).toBeCloseTo(63000 + (12 / 21) * 500, 6);
  });
  it('returns a rung when the chance is exactly its own', () => {
    expect(priceAtChance(levels, 0.82)).toBeCloseTo(62500, 6);
  });
  it('is null beyond either end of the ladder', () => {
    expect(priceAtChance(levels, 0.99)).toBeNull();
    expect(priceAtChance(levels, 0.01)).toBeNull();
  });
});

describe('how far the market expects the price to travel', () => {
  const { levels } = distributionOf(ladder)!;

  it('is the band between the prices it gives a 75% and a 25% chance of finishing at or above', () => {
    const band = evenBand(levels)!;
    // 82% at 62,500 and 62% at 63,000: 75% is 7/20 of the way across. 41% at 63,500 and 20% at 64,000: 25% is 16/21.
    expect(band.low).toBeCloseTo(62500 + (7 / 20) * 500, 6);
    expect(band.high).toBeCloseTo(63500 + (16 / 21) * 500, 6);
    expect(band.low).toBeCloseTo(priceAtChance(levels, 0.75)!, 6);
    expect(band.high).toBeCloseTo(priceAtChance(levels, 0.25)!, 6);
  });

  it('holds half of the market’s weight: an even chance inside, an even chance outside', () => {
    const band = evenBand(levels)!;
    expect(chanceAt(levels, band.low) - chanceAt(levels, band.high)).toBeCloseTo(0.5, 8);
  });

  it('gives its half-width as a fraction of its middle price', () => {
    const band = evenBand(levels)!;
    const middle = (band.low + band.high) / 2;
    expect(band.halfWidth).toBeCloseTo((band.high - band.low) / 2 / middle, 10);
    expect(band.halfWidth).toBeCloseTo(0.00953, 4);
  });

  it('is wider for a market that is less sure, on the same strikes', () => {
    const calm = distributionOf([rung(100, 0.99), rung(101, 0.9), rung(102, 0.5), rung(103, 0.1), rung(104, 0.01)])!;
    const jumpy = distributionOf([rung(100, 0.8), rung(101, 0.65), rung(102, 0.5), rung(103, 0.35), rung(104, 0.2)])!;
    expect(evenBand(jumpy.levels)!.halfWidth).toBeGreaterThan(evenBand(calm.levels)!.halfWidth * 2);
  });

  it('is unknown when the ladder does not reach those chances, and on a ladder too short to read', () => {
    // Every rung is likelier than not: the ladder says nothing about where a 25% chance lies.
    expect(evenBand(distributionOf([rung(1, 0.95), rung(2, 0.8), rung(3, 0.6)])!.levels)).toBeNull();
    expect(evenBand(distributionOf([rung(1, 0.4), rung(2, 0.2), rung(3, 0.1)])!.levels)).toBeNull();
    expect(evenBand([])).toBeNull();
    expect(evenBand([{ symbol: 'a', strike: 1, chance: 0.5 }])).toBeNull();
  });

  it('still reads a ladder whose prices were out of order, after they are evened out', () => {
    const crossed = distributionOf([rung(1, 0.9), rung(2, 0.5), rung(3, 0.6), rung(4, 0.2)])!;
    const band = evenBand(crossed.levels)!;
    expect(band.low).toBeGreaterThan(1);
    expect(band.high).toBeLessThan(4);
    expect(band.high).toBeGreaterThan(band.low);
  });

  it('is written as plus or minus a percent, and as a dash when it is not known', () => {
    expect(moveText(evenBand(levels))).toBe('±1.0%');
    expect(moveText({ halfWidth: 0.0061 })).toBe('±0.6%');
    expect(moveText({ halfWidth: 0.0995 })).toBe('±10%');
    expect(moveText({ halfWidth: 0.237 })).toBe('±24%');
    expect(moveText(null)).toBe('–');
    expect(moveText({ halfWidth: Number.NaN })).toBe('–');
  });
});

describe('the market between and beyond its rungs', () => {
  const { levels } = distributionOf(ladder)!;
  it('is the rung itself at a rung and a straight line between two', () => {
    for (const l of levels) expect(chanceAt(levels, l.strike)).toBeCloseTo(l.chance, 10);
    expect(chanceAt(levels, 63250)).toBeCloseTo((0.62 + 0.41) / 2, 10);
  });
  it('fades towards certainty below the ladder and towards nothing above it, never rising', () => {
    const prices = [50000, 60000, 61000, 61500, 62750, 64500, 65000, 66000, 80000];
    const at = prices.map((p) => chanceAt(levels, p));
    for (let i = 1; i < at.length; i++) expect(at[i]!).toBeLessThanOrEqual(at[i - 1]!);
    expect(at[0]).toBeGreaterThan(0.999);
    expect(at[at.length - 1]).toBeLessThan(0.001);
  });
});

describe("a person's view: the market's curve, moved and squeezed", () => {
  const { levels, buckets } = distributionOf(ladder)!;
  const base = marketView(levels);

  it('centres the market where it gives an even chance, as wide as the middle half of its prices', () => {
    expect(base.center).toBeCloseTo(priceAtChance(levels, 0.5)!, 6);
    expect(base.spread).toBeCloseTo((priceAtChance(levels, 0.25)! - priceAtChance(levels, 0.75)!) / 1.349, 6);
  });

  it('is the market itself, rung for rung, until it is moved', () => {
    const same = viewOf(levels, base);
    for (const l of levels) expect(same(l.strike)).toBeCloseTo(l.chance, 10);
    expect(viewBuckets(same, levels)).toEqual(buckets);
  });

  it('gives every price a better chance when moved up and a worse one when moved down', () => {
    const up = viewOf(levels, { ...base, center: base.center + 400 });
    const down = viewOf(levels, { ...base, center: base.center - 400 });
    for (const l of levels) {
      expect(up(l.strike)).toBeGreaterThan(l.chance);
      expect(down(l.strike)).toBeLessThan(l.chance);
    }
    expect(up(base.center + 400)).toBeCloseTo(0.5, 6);
  });

  it('piles the chance up around its centre when squeezed and spreads it out when widened', () => {
    const inside = (c: (k: number) => number) => c(63000) - c(63500);
    const sure = viewOf(levels, { center: 63250, spread: base.spread / 4 });
    const unsure = viewOf(levels, { center: 63250, spread: base.spread * 3 });
    expect(inside(sure)).toBeGreaterThan(0.6);
    expect(inside(unsure)).toBeLessThan(0.21);
  });

  it('draws over the same bars as the market, never negative, adding up to 1', () => {
    for (const v of [{ center: 61000, spread: 100 }, { center: 63200, spread: 600 }, { center: 66000, spread: 2000 }]) {
      const mine = viewBuckets(viewOf(levels, v), levels);
      expect(mine.map((b) => [b.from, b.to])).toEqual(buckets.map((b) => [b.from, b.to]));
      expect(mine.every((b) => b.chance >= 0)).toBe(true);
      expect(sum(mine)).toBeCloseTo(1, 6);
    }
  });

  it('still gives a usable view on a ladder that never crosses an even chance', () => {
    const v = marketView(distributionOf([rung(1, 0.3), rung(2, 0.2), rung(3, 0.1)])!.levels);
    expect(v.center).toBe(1);
    expect(v.spread).toBeGreaterThan(0);
  });
});

describe('a bar in words', () => {
  it('names the two open ends and the bars between', () => {
    const { buckets } = distributionOf(ladder)!;
    expect(bucketLabel(buckets[0]!)).toBe('Below $61,500');
    expect(bucketLabel(buckets[3]!)).toBe('$62,500 to $63,000');
    expect(bucketLabel(buckets[7]!)).toBe('$64,500 or more');
  });
});

describe('what a bet does in each bar', () => {
  const { buckets, levels } = distributionOf(ladder)!;
  const chanceAt = (k: number) => levels.find((l) => l.strike === k)!.chance;

  it('a rising parlay: stake back below the condition, a loss between, a win at or above the target', () => {
    const shape: Shape = { kind: 'up', condition: 62500, target: 63500 };
    expect(buckets.map((b) => zoneOf(shape, b))).toEqual(['back', 'back', 'back', 'lose', 'lose', 'win', 'win', 'win']);
    const z = zoneChances(shape, buckets);
    expect(z.win).toBeCloseTo(chanceAt(63500), 8);
    expect(z.back).toBeCloseTo(1 - chanceAt(62500), 8);
    expect(z.win + z.back + z.lose).toBeCloseTo(1, 8);
  });

  it('a falling parlay is the mirror image', () => {
    const shape: Shape = { kind: 'down', condition: 63500, target: 62500 };
    expect(buckets.map((b) => zoneOf(shape, b))).toEqual(['win', 'win', 'win', 'lose', 'lose', 'back', 'back', 'back']);
    const z = zoneChances(shape, buckets);
    expect(z.win).toBeCloseTo(1 - chanceAt(62500), 8);
    expect(z.back).toBeCloseTo(chanceAt(63500), 8);
  });

  it('a range wins inside and loses outside, with nothing paid back', () => {
    const shape: Shape = { kind: 'range', low: 62500, high: 63500 };
    expect(buckets.map((b) => zoneOf(shape, b))).toEqual(['lose', 'lose', 'lose', 'win', 'win', 'lose', 'lose', 'lose']);
    const z = zoneChances(shape, buckets);
    expect(z.win).toBeCloseTo(chanceAt(62500) - chanceAt(63500), 8);
    expect(z.back).toBe(0);
  });

  it('a breakout is the range turned inside out: it wins outside, either way, and loses inside', () => {
    const shape: Shape = { kind: 'breakout', low: 62500, high: 63500 };
    expect(buckets.map((b) => zoneOf(shape, b))).toEqual(['win', 'win', 'win', 'lose', 'lose', 'win', 'win', 'win']);
    const z = zoneChances(shape, buckets);
    expect(z.win).toBeCloseTo(1 - chanceAt(62500) + chanceAt(63500), 8);
    expect(z.lose).toBeCloseTo(chanceAt(62500) - chanceAt(63500), 8);
    expect(z.back).toBe(0);
  });

  it('a range and a breakout on the same two levels split every bar between them', () => {
    const range: Shape = { kind: 'range', low: 62000, high: 64000 };
    const breakout: Shape = { kind: 'breakout', low: 62000, high: 64000 };
    for (const b of buckets) expect(zoneOf(range, b) === 'win').toBe(zoneOf(breakout, b) === 'lose');
    expect(zoneChances(range, buckets).win + zoneChances(breakout, buckets).win).toBeCloseTo(1, 8);
  });
});
