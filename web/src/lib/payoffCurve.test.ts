import { describe, expect, it } from 'vitest';
import type { Rung } from '../api/types';
import { distributionOf } from './distribution';
import { payIn, payoffCurves, type LegPay } from './payoffCurve';

const rung = (strike: number, chance: number | null, spread = 0.01): Rung => ({
  symbol: `S${strike}`,
  label: `$${strike}`,
  strike,
  bid: chance === null ? null : chance - spread,
  ask: chance === null ? null : chance + spread,
  open: true,
  state: 'active/open',
});

// Chances of finishing at or above: 62,000 92%, 62,500 82%, 63,000 62%, 63,500 41%, 64,000 20%.
const BTC = [rung(62000, 0.92), rung(62500, 0.82), rung(63000, 0.62), rung(63500, 0.41), rung(64000, 0.2)];
const ladders = { BTC, ETH: [rung(1800, 0.8), rung(1820, 0.6), rung(1840, 0.4)] };

const parlay: LegPay = { ticker: 'BTC', shape: { kind: 'up', condition: 62500, target: 63500 }, win: 10, lose: -10 };
const range: LegPay = { ticker: 'BTC', shape: { kind: 'range', low: 63000, high: 64000 }, win: 6, lose: -4 };
const breakout: LegPay = { ticker: 'BTC', shape: { kind: 'breakout', low: 63000, high: 64000 }, win: 5, lose: -8 };

describe('what one bet nets in a bar', () => {
  const { buckets } = distributionOf(BTC)!; // below 62,000 | 62,000 | 62,500 | 63,000 | 63,500 | 64,000 or more
  it('a parlay: nothing below its condition, its loss between, its win at or above its target', () => {
    expect(buckets.map((b) => payIn(parlay, b))).toEqual([0, 0, -10, -10, 10, 10]);
  });
  it('a range wins inside and a breakout outside', () => {
    expect(buckets.map((b) => payIn(range, b))).toEqual([-4, -4, -4, 6, 6, -4]);
    expect(buckets.map((b) => payIn(breakout, b))).toEqual([5, 5, 5, -8, -8, 5]);
  });
  it('uses the stake-back figure a bet gives', () => {
    expect(payIn({ ...parlay, back: -0.03 }, buckets[0]!)).toBe(-0.03);
  });
});

describe('several bets on one ladder, added up', () => {
  it('gives the whole position for each bar, and the chance of ending ahead, level and behind', () => {
    const { curves, missing } = payoffCurves([parlay, range], ladders);
    expect(missing).toEqual([]);
    expect(curves).toHaveLength(1);
    const c = curves[0]!;
    expect(c.legs).toEqual([0, 1]);
    expect(c.bars.map((b) => b.net)).toEqual([-4, -4, -14, -4, 16, 6]);
    // ahead: 63,500 to 64,000 (21%) and 64,000 or more (20%)
    expect(c.ahead).toBeCloseTo(0.41, 8);
    expect(c.behind).toBeCloseTo(0.59, 8);
    expect(c.level).toBeCloseTo(0, 8);
    expect(c.ahead + c.level + c.behind).toBeCloseTo(1, 8);
    expect([c.best, c.worst]).toEqual([16, -14]);
  });

  it('counts a stake that came back as level, not as a win or a loss', () => {
    const c = payoffCurves([parlay], ladders).curves[0]!;
    expect(c.level).toBeCloseTo(1 - 0.82, 8); // below the condition
    expect(c.ahead).toBeCloseTo(0.41, 8);
    expect(c.behind).toBeCloseTo(0.82 - 0.41, 8);
  });

  it('a range and a breakout on the same two levels cannot both lose, and cannot both win', () => {
    const c = payoffCurves([range, breakout], ladders).curves[0]!;
    expect(new Set(c.bars.map((b) => b.net))).toEqual(new Set([6 - 8, -4 + 5]));
    expect([c.best, c.worst]).toEqual([1, -2]);
  });

  it("works the average at the market's own odds from the bars", () => {
    const c = payoffCurves([parlay], ladders).curves[0]!;
    expect(c.average).toBeCloseTo(0.41 * 10 + (0.82 - 0.41) * -10, 8);
    // A bet priced at exactly fair value averages nothing: fair for this parlay is 41/82 = 50 cents, so $10 wins $10.
    expect(c.average).toBeCloseTo(0, 8);
  });
});

describe('bets on different ladders', () => {
  it('are never added together: each ladder has its own curve, in the order the list first uses them', () => {
    const eth: LegPay = { ticker: 'ETH', shape: { kind: 'range', low: 1800, high: 1840 }, win: 3, lose: -2 };
    const { curves } = payoffCurves([eth, parlay, range], ladders);
    expect(curves.map((c) => [c.ticker, c.legs])).toEqual([
      ['ETH', [0]],
      ['BTC', [1, 2]],
    ]);
    expect(curves[0]!.bars.map((b) => b.net)).toEqual([-2, 3, 3, -2]);
  });
});

describe('bets that cannot be drawn', () => {
  it('are left out and reported: not ready, no figures, a ladder with too few prices, or a level with no price', () => {
    const noLadder: LegPay = { ...parlay, ticker: 'SOL' };
    const offGrid: LegPay = { ...parlay, shape: { kind: 'up', condition: 62500, target: 63250 } };
    const noFigures: LegPay = { ...range, win: Number.NaN };
    const { curves, missing } = payoffCurves([null, noLadder, offGrid, noFigures, range], ladders);
    expect(missing).toEqual([0, 1, 2, 3]);
    expect(curves).toHaveLength(1);
    expect(curves[0]!.legs).toEqual([4]);
  });

  it('says when a ladder had to be evened out first', () => {
    const tangled = { BTC: [rung(62000, 0.9), rung(62500, 0.5), rung(63000, 0.6), rung(63500, 0.2)] };
    const leg: LegPay = { ticker: 'BTC', shape: { kind: 'range', low: 62000, high: 63500 }, win: 1, lose: -1 };
    expect(payoffCurves([leg], tangled).curves[0]!.adjusted).toBe(true);
    expect(payoffCurves([range], ladders).curves[0]!.adjusted).toBe(false);
  });
});
