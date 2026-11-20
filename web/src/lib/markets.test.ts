import { describe, expect, it } from 'vitest';
import type { MarketEvent, Rung } from '../api/types';
import { assetKey, assetLabel, assetName, closesLabel, groupByAsset, horizonOf, strikeSpan } from './markets';

const rung = (strike: number, bid: number | null = 0.4, ask: number | null = 0.5): Rung => ({ symbol: `S${strike}`, label: `${strike}`, strike, bid, ask, open: true, state: 'open' });
const ev = (ticker: string, title: string, expiry: string | null, over: Partial<MarketEvent> = {}): MarketEvent => ({
  ticker,
  title,
  category: 'Crypto',
  expiry,
  rungs: [rung(100), rung(110), rung(120)],
  ladderOutOfOrder: false,
  pairs: [],
  offerableCount: 0,
  refusedCount: 0,
  refusedByReason: {},
  down: { pairs: [], offerableCount: 0, refusedCount: 0 },
  ...over,
});

describe('asset naming', () => {
  it('takes the asset from the ticker and the exchange title', () => {
    expect(assetKey({ ticker: 'BTC2611200100' })).toBe('BTC');
    expect(assetKey({ ticker: 'NGAS2611302200' })).toBe('NGAS');
    expect(assetName({ ticker: 'BRENT2611202200', title: 'Oil (Brent) price on November 20?' })).toBe('Oil (Brent)');
    expect(assetLabel({ ticker: 'BTC2611200100', title: 'BTC price today at 8pm EST' })).toBe('Bitcoin');
    expect(assetLabel({ ticker: 'COPPER2611202200', title: 'Copper price on November 20?' })).toBe('Copper');
  });
});

describe('horizonOf', () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  it('sorts a close into hour, day or month', () => {
    expect(horizonOf({ expiry: '2026-11-20T01:00:00Z' }, now)).toBe('hour');
    expect(horizonOf({ expiry: '2026-11-20T22:00:00Z' }, now)).toBe('day');
    expect(horizonOf({ expiry: '2026-11-30T22:00:00Z' }, now)).toBe('month');
    expect(horizonOf({ expiry: null }, now)).toBe('month');
  });
});

describe('closesLabel', () => {
  it('says "No close time" when there is none', () => {
    expect(closesLabel(null)).toBe('No close time');
    expect(closesLabel('nonsense')).toBe('No close time');
  });
  it('prefixes a same-day close with Today', () => {
    const now = new Date(2026, 10, 20, 9, 0).getTime();
    expect(closesLabel(new Date(2026, 10, 20, 20, 0).toISOString(), now)).toBe('Today 8 PM');
    expect(closesLabel(new Date(2026, 10, 30, 17, 0).toISOString(), now)).toMatch(/^Nov 30, 5 PM$/);
  });
});

describe('groupByAsset', () => {
  it('groups ladders by asset, soonest first, and puts assets with offers first', () => {
    const groups = groupByAsset([
      ev('ETH2611302200', 'ETH price on November 30', '2026-11-30T22:00:00Z'),
      ev('SOL2611200100', 'SOL price today at 8pm EST', '2026-11-20T01:00:00Z', { offerableCount: 4 }),
      ev('ETH2611200100', 'ETH price today at 8pm EST', '2026-11-20T01:00:00Z'),
      ev('XRP2611200100', 'XRP price today at 8pm EST', '2026-11-20T01:00:00Z', { rungs: [rung(1)] }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['SOL', 'ETH']); // XRP has one rung, so it is not a ladder
    expect(groups[1]!.events.map((e) => e.ticker)).toEqual(['ETH2611200100', 'ETH2611302200']);
    expect(groups[0]!.offers).toBe(4);
    expect(groups[1]!.priced).toBe(2);
  });
  it('counts a ladder with no two-sided prices as unpriced', () => {
    const g = groupByAsset([ev('BTC2611200100', 'BTC price today', '2026-11-20T01:00:00Z', { rungs: [rung(1, null, null), rung(2, null, null)] })]);
    expect(g[0]!.priced).toBe(0);
  });
});

describe('strikeSpan', () => {
  it('reports the lowest and highest strike', () => {
    expect(strikeSpan(ev('A1', 'A', null))).toEqual({ low: 100, high: 120 });
  });
});
