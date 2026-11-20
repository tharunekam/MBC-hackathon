import { describe, expect, it } from 'vitest';
import type { MarketEvent, Rung } from '../api/types';
import { defaultRange } from './defaultRange';

const rung = (strike: number, chance: number, open = true, spread = 0.02): Rung => ({
  symbol: `S${strike}`,
  label: `$${strike}`,
  strike,
  bid: Math.max(0.01, chance - spread),
  ask: Math.min(0.99, chance + spread),
  open,
  state: open ? 'active/open' : 'active/post_only',
});

const ev = (rungs: Rung[]): MarketEvent => ({
  ticker: 'E',
  title: 'E',
  expiry: null,
  rungs,
  ladderOutOfOrder: false,
  pairs: [],
  offerableCount: 0,
  refusedCount: 0,
  refusedByReason: {},
  down: { pairs: [], offerableCount: 0, refusedCount: 0 },
});

// A real-looking ladder: the low end near-certain, the high end near-impossible.
const ladder = [
  rung(60000, 0.97),
  rung(61000, 0.95),
  rung(62000, 0.88),
  rung(63000, 0.76),
  rung(64000, 0.58),
  rung(65000, 0.31),
  rung(66000, 0.12),
  rung(67000, 0.04),
];

const chanceOf = (e: MarketEvent, sel: { low: string; high: string }) => {
  const m = (s: string) => {
    const r = e.rungs.find((x) => x.symbol === s)!;
    return (r.bid! + r.ask!) / 2;
  };
  return m(sel.low) - m(sel.high);
};

describe('the default range', () => {
  it('aims for a floor near 75% and a ceiling near 30%, lower strike first', () => {
    const e = ev(ladder);
    const sel = defaultRange(e)!;
    expect(sel).toEqual({ low: 'S63000', high: 'S65000' });
    const inside = chanceOf(e, sel);
    expect(inside).toBeGreaterThanOrEqual(0.4);
    expect(inside).toBeLessThanOrEqual(0.5);
  });

  it('does not depend on the order the exchange lists the rungs in', () => {
    expect(defaultRange(ev([...ladder].reverse()))).toEqual({ low: 'S63000', high: 'S65000' });
  });

  it('never takes the two ends of the ladder', () => {
    const e = ev([rung(1, 0.8), rung(2, 0.5), rung(3, 0.3)]);
    const sel = defaultRange(e)!;
    expect(sel).not.toEqual({ low: 'S1', high: 'S3' });
  });

  it('never takes two near-certain rungs, even next to each other', () => {
    const e = ev([rung(1, 0.98), rung(2, 0.96), rung(3, 0.94), rung(4, 0.92)]);
    expect(defaultRange(e)).toBeNull();
    const sel = defaultRange(ev([rung(1, 0.98), rung(2, 0.96), rung(3, 0.6), rung(4, 0.2)]))!;
    expect([sel.low, sel.high]).not.toEqual(['S1', 'S2']);
  });

  it('skips rungs that are not open or have only one side', () => {
    const e = ev([rung(1, 0.9), rung(2, 0.75, false), rung(3, 0.6), { ...rung(4, 0.3), bid: null }, rung(5, 0.25), rung(6, 0.1)]);
    const sel = defaultRange(e)!;
    expect([sel.low, sel.high]).not.toContain('S2');
    expect([sel.low, sel.high]).not.toContain('S4');
  });

  it('is null for fewer than three usable rungs', () => {
    expect(defaultRange(ev([]))).toBeNull();
    expect(defaultRange(ev([rung(1, 0.7), rung(2, 0.3)]))).toBeNull();
    expect(defaultRange(ev([rung(1, 0.7), rung(2, 0.5, false), rung(3, 0.3)]))).toBeNull();
  });

  it('can still pick from a ladder that is not open yet when asked to', () => {
    const closed = ladder.map((r) => ({ ...r, open: false, state: 'active/post_only' }));
    expect(defaultRange(ev(closed))).toBeNull();
    expect(defaultRange(ev(closed), { openOnly: false })).toEqual({ low: 'S63000', high: 'S65000' });
  });

  it('prefers a range the offer rule would accept over a slightly closer one it would refuse', () => {
    // The 65000 rung has a spread too wide to be fair; the next one up is accepted.
    const e = ev([rung(60000, 0.95), rung(63000, 0.75), rung(64000, 0.5), rung(65000, 0.3, true, 0.25), rung(66000, 0.25), rung(67000, 0.05)]);
    expect(defaultRange(e)).toEqual({ low: 'S63000', high: 'S66000' });
  });
});
