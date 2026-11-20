import { describe, expect, it } from 'vitest';
import type { MarketEvent, Rung } from '../api/types';
import { assetKey, assetLabel, assetName, closesLabel, closesPhrase, groupByAsset, horizonOf, marketHeading, parlaysOnOffer, strikeSpan } from './markets';

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
    expect(assetName({ ticker: 'BRENT2611202200', title: 'Oil (Brent) · Nov 20, 10 PM' })).toBe('Oil (Brent)');
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

describe('the line over a ticket', () => {
  const now = new Date(2026, 10, 20, 20, 10).getTime();
  const local = (h: number, m: number, day = 20) => new Date(2026, 10, day, h, m).toISOString();

  it('says when a ladder closes in the viewer’s own time, with minutes only when there are some', () => {
    expect(closesPhrase(local(21, 35), now)).toBe('closes today 9:35 PM');
    expect(closesPhrase(local(21, 0), now)).toBe('closes today 9 PM');
    expect(closesPhrase(local(17, 0, 30), now)).toBe('closes Nov 30, 5 PM');
  });

  it('says closed once the time has passed', () => {
    expect(closesPhrase(local(20, 0), now)).toBe('closed 8 PM');
    expect(closesPhrase(local(21, 35, 19), now)).toBe('closed Nov 19, 9:35 PM');
    expect(closesPhrase(new Date(now).toISOString(), now)).toBe('closed 8:10 PM');
  });

  it('has nothing to say without a close time', () => {
    expect(closesPhrase(null, now)).toBeNull();
    expect(closesPhrase('nonsense', now)).toBeNull();
  });

  it('names the asset the way the picker does, not the exchange’s New York hour', () => {
    expect(marketHeading({ ticker: 'BTC2611210300', title: 'BTC price today at 10pm EST', expiry: local(21, 0) }, now)).toBe('Bitcoin · closes today 9 PM');
    expect(marketHeading({ ticker: 'BRENT2611302200', title: 'Oil (Brent) price on November 30?', expiry: local(17, 0, 30) }, now)).toBe('Oil (Brent) · closes Nov 30, 5 PM');
    expect(marketHeading({ ticker: 'ETH2611210300', title: 'ETH price today', expiry: null }, now)).toBe('Ethereum');
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
  it('counts the parlays on offer going either way', () => {
    const up = ev('BTC2611200100', 'BTC price today', '2026-11-20T01:00:00Z', { offerableCount: 3, down: { pairs: [], offerableCount: 2, refusedCount: 0 } });
    expect(parlaysOnOffer(up)).toBe(5);
    expect(parlaysOnOffer({ ...up, down: undefined })).toBe(3); // a session recorded before falling bets existed
    expect(groupByAsset([up])[0]!.offers).toBe(5);
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
