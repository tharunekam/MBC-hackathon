import { describe, expect, it } from 'vitest';
import type { MarketEvent, Rung } from '../api/types';
import { across, hasPrices, listLadders, shortTitle, spacedLabels } from './ladders';

const rung = (strike: number, priced: boolean): Rung => ({
  symbol: `S${strike}`,
  label: `$${strike}`,
  strike,
  bid: priced ? 0.4 : null,
  ask: priced ? 0.44 : null,
  open: true,
  state: 'active/open',
});

const ladder = (ticker: string, o: { priced?: number; offerable?: number; outOfOrder?: boolean; rungs?: number; expiry?: string } = {}): MarketEvent => {
  const n = o.rungs ?? 6;
  return {
    ticker,
    title: `${ticker} price on November 18`,
    expiry: o.expiry ?? null,
    rungs: Array.from({ length: n }, (_, i) => rung(100 + i, i < (o.priced ?? 0))),
    ladderOutOfOrder: o.outOfOrder ?? false,
    pairs: [],
    offerableCount: o.offerable ?? 0,
    refusedCount: 0,
    refusedByReason: {},
    down: { pairs: [], offerableCount: 0, refusedCount: 0 },
  };
};

/** What Gemini's sandbox listed on 2026-11-18: four ladders with prices among thirty without. */
const sandbox = (): MarketEvent[] => [
  ladder('XRP', { priced: 6, outOfOrder: true }),
  ladder('ETH', { priced: 6, offerable: 3 }),
  ladder('SOL', { priced: 6 }),
  ladder('BTC', { priced: 6, offerable: 2, outOfOrder: true }),
  ...Array.from({ length: 30 }, (_, i) => ladder(`DEAD${i}`, { priced: i % 7 === 0 ? 1 : 0 })),
];

describe('a tab is named, not asked', () => {
  it('drops the exchange\'s "price on" and its question mark', () => {
    expect(shortTitle('Oil (Brent) price on November 18?')).toBe('Oil (Brent) · November 18');
    expect(shortTitle('XRP price on November 18')).toBe('XRP · November 18');
    expect(shortTitle('BTC price today at 5pm EST')).toBe('BTC · 5pm EST');
    expect(shortTitle('Will it rain?')).toBe('Will it rain');
  });
});

describe('which ladders the builder lists', () => {
  it('a ladder needs two rungs with both prices to be drawn or quoted', () => {
    expect(hasPrices(ladder('A', { priced: 2 }))).toBe(true);
    expect(hasPrices(ladder('A', { priced: 1 }))).toBe(false);
    expect(hasPrices({ ...ladder('A'), rungs: [{ ...rung(1, true), ask: null }, rung(2, true)] })).toBe(false);
  });

  it('shows the ladders that have prices and counts the rest, instead of thirty-four tabs', () => {
    const l = listLadders(sandbox());
    expect(l.shown.map((e) => e.ticker)).toEqual(['BTC', 'ETH', 'SOL', 'XRP']);
    expect(l.unpriced).toHaveLength(30);
  });

  it('keeps the tabs in one order whatever order the exchange lists them in and whatever is on offer', () => {
    const before = listLadders(sandbox()).shown.map((e) => e.ticker);
    const moved = sandbox().reverse();
    moved[moved.findIndex((e) => e.ticker === 'SOL')] = ladder('SOL', { priced: 6, offerable: 9 });
    expect(listLadders(moved).shown.map((e) => e.ticker)).toEqual(before);
  });

  it('puts the ladder that closes soonest first', () => {
    const l = listLadders([
      ladder('ETH', { priced: 6, expiry: '2026-11-20T22:00:00.000Z' }),
      ladder('XRP', { priced: 6, expiry: '2026-11-18T22:00:00.000Z' }),
      ladder('BTC', { priced: 6, expiry: '2026-11-20T22:00:00.000Z' }),
      ladder('ZEC', { priced: 6 }),
    ]);
    expect(l.shown.map((e) => e.ticker)).toEqual(['XRP', 'BTC', 'ETH', 'ZEC']);
  });

  it('opens on a ladder you can bet on, not on the first one listed', () => {
    expect(listLadders(sandbox()).first?.ticker).toBe('ETH');
    // nothing in order is on offer: a ladder with offers still beats one with prices only
    expect(listLadders([ladder('A', { priced: 6 }), ladder('B', { priced: 6, offerable: 1, outOfOrder: true })]).first?.ticker).toBe('B');
    // nothing on offer anywhere: a priced ladder in order beats one out of order, and both beat an empty one
    expect(listLadders([ladder('DEAD'), ladder('X', { priced: 6, outOfOrder: true }), ladder('Y', { priced: 6 })]).first?.ticker).toBe('Y');
  });

  it('never opens on a ladder with no prices while another has them', () => {
    const l = listLadders([ladder('DEAD0'), ladder('DEAD1'), ladder('LIVE', { priced: 3, outOfOrder: true })]);
    expect(l.first?.ticker).toBe('LIVE');
    expect(l.shown.map((e) => e.ticker)).toEqual(['LIVE']);
  });

  it('shows the unpriced ladders after the priced ones when asked', () => {
    const l = listLadders(sandbox(), true);
    expect(l.shown).toHaveLength(34);
    expect(l.shown.slice(0, 4).map((e) => e.ticker)).toEqual(['BTC', 'ETH', 'SOL', 'XRP']);
    expect(l.unpriced).toHaveLength(30);
    expect(l.first?.ticker).toBe('ETH');
  });

  it('with no prices anywhere, lists every ladder so the page is not empty', () => {
    const l = listLadders([ladder('A'), ladder('B'), ladder('ONE', { rungs: 1 })]);
    expect(l.shown.map((e) => e.ticker)).toEqual(['A', 'B']);
    expect(l.unpriced).toEqual([]);
    expect(l.first?.ticker).toBe('A');
  });

  it('drops one-rung ladders and copes with an empty list', () => {
    expect(listLadders([ladder('ONE', { rungs: 1, priced: 1 })]).shown).toEqual([]);
    expect(listLadders([])).toEqual({ shown: [], unpriced: [], first: undefined });
  });
});

describe('where a rung sits on the chart', () => {
  it('a ladder that steps in cents fills the chart like one that steps in hundreds of dollars', () => {
    // XRP: $0.88 to $1.02. The old scale divided by at least 1, which drew this ladder in the left 14% of the plot.
    expect(across(0.88, 0.88, 1.02)).toBe(0);
    expect(across(1.02, 0.88, 1.02)).toBe(1);
    expect(across(0.95, 0.88, 1.02)).toBeCloseTo(0.5, 10);
    expect(across(63500, 63000, 64250)).toBeCloseTo(0.4, 10);
  });

  it('a single price sits in the middle', () => {
    expect(across(5, 5, 5)).toBe(0.5);
  });
});

describe('price labels under the chart', () => {
  const even = (n: number, width: number) => Array.from({ length: n }, (_, i) => 38 + (i * width) / (n - 1));

  it('labels every rung when there is room', () => {
    expect([...spacedLabels(even(8, 640))]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('on a phone skips rungs so no two labels touch, and always labels the last', () => {
    const xs = even(8, 290);
    const kept = [...spacedLabels(xs)].sort((a, b) => a - b);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(7);
    for (let i = 1; i < kept.length; i++) expect(xs[kept[i]!]! - xs[kept[i - 1]!]!).toBeGreaterThanOrEqual(56);
  });

  it('measures real positions, so a ladder with uneven steps does not stack labels', () => {
    // rungs bunched on the left, as when a far strike is listed
    const xs = [38, 44, 50, 56, 62, 400, 640];
    const kept = [...spacedLabels(xs)].sort((a, b) => a - b);
    expect(kept).toEqual([0, 5, 6]);
  });

  it('handles one rung and none', () => {
    expect([...spacedLabels([38])]).toEqual([0]);
    expect([...spacedLabels([])]).toEqual([]);
  });
});
