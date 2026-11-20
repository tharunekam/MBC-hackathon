import { describe, expect, it } from 'vitest';
import type { MarketEvent, Rung } from '../api/types';
import { alongOf, halfWidth, levelsFor, outlookOf, pointOf, pointWords, priceSpan, priceTicks, wideningWords } from './outlook';

const NOW = Date.parse('2026-11-20T02:00:00Z');
const HOUR = 3_600_000;

/** A ladder whose mid prices are exactly `chances`, on strikes 100 apart from `lowest`. */
function ladder(ticker: string, closesInHours: number | null, chances: number[], lowest = 1000): Pick<MarketEvent, 'ticker' | 'expiry' | 'rungs'> {
  const rungs: Rung[] = chances.map((c, i) => ({
    symbol: `${ticker}-HI${lowest + i * 100}`,
    label: `${lowest + i * 100} or above`,
    strike: lowest + i * 100,
    bid: Math.round((c - 0.01) * 100) / 100,
    ask: Math.round((c + 0.01) * 100) / 100,
    open: true,
    state: 'open',
  }));
  return { ticker, expiry: closesInHours === null ? null : new Date(NOW + closesInHours * HOUR).toISOString(), rungs };
}

// Chances at 1000, 1100, ... 1600: the middle sits at 1300, the even band is 1200 to 1400, the wide band 1100 to 1500.
const NEAR = [0.95, 0.9, 0.75, 0.5, 0.25, 0.1, 0.05];

describe('pointOf', () => {
  it('reads the middle and both bands straight off the ladder', () => {
    const p = pointOf(ladder('A1', 1, NEAR), NOW)!;
    expect(p.middle).toBeCloseTo(1300, 6);
    expect(p.even).toEqual({ low: 1200, high: 1400 });
    expect(p.wide).toEqual({ low: 1100, high: 1500 });
    expect(p.at).toBe(NOW + HOUR);
  });

  it('picks the listed levels nearest the even band for a bet on it', () => {
    const p = pointOf(ladder('A1', 1, NEAR), NOW)!;
    expect(p.levels).toEqual({ low: { symbol: 'A1-HI1200', strike: 1200 }, high: { symbol: 'A1-HI1400', strike: 1400 } });
  });

  it('has no band where the prices do not reach that far', () => {
    // Never above 70% and never below 30%: the middle is known, neither band is.
    const p = pointOf(ladder('A1', 1, [0.7, 0.6, 0.5, 0.4, 0.3]), NOW)!;
    expect(p.middle).toBeCloseTo(1200, 6);
    expect(p.even).toBeNull();
    expect(p.wide).toBeNull();
    // Still two levels to open a builder on.
    expect(p.levels!.low.strike).toBeLessThan(p.levels!.high.strike);
  });

  it('keeps the even band when only the wide one runs off the ladder', () => {
    const p = pointOf(ladder('A1', 1, [0.8, 0.75, 0.5, 0.25, 0.2]), NOW)!;
    expect(p.even).toEqual({ low: 1100, high: 1300 });
    expect(p.wide).toBeNull();
  });

  it('is null for a ladder that has closed, has no close time, or has no middle', () => {
    expect(pointOf(ladder('A1', -1, NEAR), NOW)).toBeNull();
    expect(pointOf(ladder('A1', 0, NEAR), NOW)).toBeNull();
    expect(pointOf(ladder('A1', null, NEAR), NOW)).toBeNull();
    expect(pointOf(ladder('A1', 1, [0.4, 0.3, 0.2]), NOW)).toBeNull();
    expect(pointOf(ladder('A1', 1, [0.5]), NOW)).toBeNull();
    expect(pointOf({ ticker: 'A1', expiry: 'not a date', rungs: ladder('A1', 1, NEAR).rungs }, NOW)).toBeNull();
  });

  it('ignores rungs with one side of the book missing', () => {
    const l = ladder('A1', 1, NEAR);
    l.rungs[0]!.bid = null;
    const p = pointOf(l, NOW)!;
    expect(p.middle).toBeCloseTo(1300, 6);
    expect(p.levels!.low.symbol).toBe('A1-HI1200');
  });
});

describe('levelsFor', () => {
  const listed = [1000, 1100, 1200].map((strike) => ({ symbol: `S${strike}`, strike }));

  it('moves the upper level up a rung when a narrow band lands on one rung', () => {
    expect(levelsFor(listed, { low: 1090, high: 1110 })).toEqual({ low: listed[1], high: listed[2] });
  });

  it('moves the lower level down at the top of the ladder', () => {
    expect(levelsFor(listed, { low: 1190, high: 1500 })).toEqual({ low: listed[1], high: listed[2] });
  });

  it('needs two levels', () => {
    expect(levelsFor(listed.slice(0, 1), { low: 900, high: 1100 })).toBeNull();
  });
});

describe('outlookOf', () => {
  it('orders closing times soonest first and drops ladders that say nothing', () => {
    const points = outlookOf([ladder('C', 30, NEAR), ladder('A', 1, NEAR), ladder('gone', -2, NEAR), ladder('B', 4, NEAR), ladder('flat', 2, [0.2, 0.1])], NOW);
    expect(points.map((p) => p.ticker)).toEqual(['A', 'B', 'C']);
  });

  it('keeps the ladder that says more when two close at the same moment', () => {
    const points = outlookOf([ladder('thin', 1, [0.7, 0.6, 0.5, 0.4, 0.3]), ladder('full', 1, NEAR)], NOW);
    expect(points.map((p) => p.ticker)).toEqual(['full']);
  });

  it('is empty with nothing to read', () => {
    expect(outlookOf([], NOW)).toEqual([]);
  });
});

describe('alongOf', () => {
  it('runs from now to the last close on a square-root scale', () => {
    const last = NOW + 100 * HOUR;
    expect(alongOf(NOW, NOW, last)).toBe(0);
    expect(alongOf(last, NOW, last)).toBe(1);
    expect(alongOf(NOW + 25 * HOUR, NOW, last)).toBeCloseTo(0.5, 9);
    expect(alongOf(NOW + HOUR, NOW, last)).toBeCloseTo(0.1, 9);
  });

  it('puts a single close at the right edge and never leaves the chart', () => {
    expect(alongOf(NOW + HOUR, NOW, NOW)).toBe(1);
    expect(alongOf(NOW - HOUR, NOW, NOW + HOUR)).toBe(0);
    expect(alongOf(NOW + 9 * HOUR, NOW, NOW + HOUR)).toBe(1);
  });
});

describe('words', () => {
  it('says what one closing time gives, with only the bands it has', () => {
    const full = pointWords(pointOf(ladder('A', 1, NEAR), NOW)!, NOW);
    expect(full).toContain('the middle of the market’s view is $1,300');
    expect(full).toContain('an even chance of finishing between $1,200 and $1,400');
    expect(full).toContain('four chances in five of finishing between $1,100 and $1,500');
    const bare = pointWords(pointOf(ladder('A', 1, [0.7, 0.6, 0.5, 0.4, 0.3]), NOW)!, NOW);
    expect(bare).toContain('do not reach far enough');
    expect(bare).not.toContain('even chance');
  });

  it('measures a band as a share of its middle', () => {
    expect(halfWidth({ low: 1200, high: 1400 })).toBeCloseTo(100 / 1300, 9);
  });

  it('says how the view widens from the soonest close to the furthest', () => {
    // The later ladder has rungs 200 apart around the same middle, so its even band is twice as wide.
    const later = ladder('B', 24, NEAR);
    later.rungs.forEach((r, i) => (r.strike = 700 + i * 200));
    const words = wideningWords(outlookOf([ladder('A', 1, NEAR), later], NOW), NOW)!;
    expect(words).toMatch(/^The even-chance band widens from ±7\.7% by .+ to ±15% by .+\.$/);
  });

  it('says so when it narrows or holds, and nothing with one close', () => {
    const wider = ladder('A', 1, NEAR);
    wider.rungs.forEach((r, i) => (r.strike = 700 + i * 200));
    expect(wideningWords(outlookOf([wider, ladder('B', 24, NEAR)], NOW), NOW)).toContain('narrows');
    expect(wideningWords(outlookOf([ladder('A', 1, NEAR), ladder('B', 24, NEAR)], NOW), NOW)).toContain('holds steady at about ±7.7%');
    expect(wideningWords(outlookOf([ladder('A', 1, NEAR)], NOW), NOW)).toBeNull();
    expect(wideningWords([], NOW)).toBeNull();
  });
});

describe('the chart’s price axis', () => {
  it('spans the widest band with air either side', () => {
    const span = priceSpan(outlookOf([ladder('A', 1, NEAR)], NOW))!;
    expect(span.low).toBeCloseTo(1100 - 48, 6);
    expect(span.high).toBeCloseTo(1500 + 48, 6);
    expect(priceSpan([])).toBeNull();
  });

  it('still has height when every point is a bare middle', () => {
    const span = priceSpan(outlookOf([ladder('A', 1, [0.7, 0.6, 0.5, 0.4, 0.3])], NOW))!;
    expect(span.high).toBeGreaterThan(span.low);
  });

  it('lists round prices inside the span', () => {
    expect(priceTicks({ low: 1052, high: 1548 })).toEqual([1200, 1400]);
    expect(priceTicks({ low: 61800, high: 64900 })).toEqual([62000, 63000, 64000]);
    expect(priceTicks({ low: 0.951, high: 0.989 })).toEqual([0.96, 0.97, 0.98]);
    expect(priceTicks({ low: 5, high: 5 })).toEqual([]);
  });
});
