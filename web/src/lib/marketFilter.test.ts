import { describe, expect, it } from 'vitest';
import type { MarketEvent, Rung } from '../api/types';
import { categoriesOf, closesIn, filterGroups, updatedLabel } from './marketFilter';
import { groupByAsset } from './markets';

const rung = (strike: number, bid: number | null = 0.4, ask: number | null = 0.5): Rung => ({ symbol: `S${strike}`, label: `${strike}`, strike, bid, ask, open: true, state: 'open' });
const ev = (ticker: string, title: string, over: Partial<MarketEvent> = {}): MarketEvent => ({
  ticker,
  title,
  category: 'Crypto',
  expiry: '2026-11-20T20:00:00Z',
  rungs: [rung(100), rung(110), rung(120)],
  ladderOutOfOrder: false,
  pairs: [],
  offerableCount: 2,
  refusedCount: 0,
  refusedByReason: {},
  ...over,
});

const noPrices = [rung(100, null, null), rung(110, null, null)];
const groups = groupByAsset([
  ev('BTC2611200100', 'Bitcoin price on November 20?'),
  ev('BTC2611300100', 'Bitcoin price on November 30?', { rungs: noPrices, offerableCount: 0 }),
  ev('NGAS2611302200', 'Natural gas price on November 30?', { category: 'Commodities', rungs: noPrices, offerableCount: 0 }),
]);

describe('filterGroups', () => {
  it('returns everything for an empty filter', () => {
    expect(filterGroups(groups, { q: '', cat: '', priced: false }).flatMap((g) => g.events)).toHaveLength(3);
  });
  it('keeps only ladders with prices and recounts the group', () => {
    const out = filterGroups(groups, { q: '', cat: '', priced: true });
    expect(out).toHaveLength(1);
    expect(out[0]!.events).toHaveLength(1);
    expect(out[0]!.priced).toBe(1);
    expect(out[0]!.offers).toBe(2);
  });
  it('filters by category', () => {
    expect(filterGroups(groups, { q: '', cat: 'Commodities', priced: false }).map((g) => g.key)).toEqual(['NGAS']);
  });
  it('matches asset name, ticker and title, all words required', () => {
    expect(filterGroups(groups, { q: 'bitcoin', cat: '', priced: false })).toHaveLength(1);
    expect(filterGroups(groups, { q: 'ngas', cat: '', priced: false })).toHaveLength(1);
    expect(filterGroups(groups, { q: 'natural november', cat: '', priced: false })).toHaveLength(1);
    expect(filterGroups(groups, { q: 'bitcoin gas', cat: '', priced: false })).toHaveLength(0);
  });
  it('does not mutate its input', () => {
    filterGroups(groups, { q: 'zzz', cat: '', priced: true });
    expect(groups.flatMap((g) => g.events)).toHaveLength(3);
  });
});

describe('categoriesOf', () => {
  it('lists each category once', () => {
    expect(categoriesOf(groups).sort()).toEqual(['Commodities', 'Crypto']);
  });
});

describe('closesIn', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  it('counts minutes and hours without the leading verb', () => {
    expect(closesIn('2026-11-19T14:05:00Z', now)).toBe('in 2 h 5 min');
  });
  it('switches to days past two days out', () => {
    expect(closesIn('2026-11-30T12:00:00Z', now)).toBe('in 11 d');
  });
  it('handles closed, missing and unreadable times', () => {
    expect(closesIn('2026-11-19T11:00:00Z', now)).toBe('Closed');
    expect(closesIn(null, now)).toBeNull();
    expect(closesIn('nope', now)).toBeNull();
  });
});

describe('updatedLabel', () => {
  const now = Date.parse('2026-11-19T12:00:30Z');
  it('reads seconds, minutes and hours', () => {
    expect(updatedLabel('2026-11-19T12:00:18Z', now)).toBe('Updated 12s ago');
    expect(updatedLabel('2026-11-19T12:00:28Z', now)).toBe('Updated just now');
    expect(updatedLabel('2026-11-19T11:50:30Z', now)).toBe('Updated 10 min ago');
    expect(updatedLabel('2026-11-19T09:00:30Z', now)).toBe('Updated 3 h ago');
  });
  it('never goes negative and tolerates bad input', () => {
    expect(updatedLabel('2026-11-19T12:05:00Z', now)).toBe('Updated just now');
    expect(updatedLabel(undefined, now)).toBeNull();
    expect(updatedLabel('x', now)).toBeNull();
  });
});
