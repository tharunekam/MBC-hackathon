import { describe, expect, it } from 'vitest';
import type { Rung } from '../api/types';
import { distributionOf, zoneChances, type Shape } from './distribution';
import { canAllWin, canBothWin, chanceWords, neverAllWin, shapeOf, spanWords, together, winsAt, type JointLeg, type Span } from './together';

const rung = (strike: number, chance: number | null, spread = 0.02): Rung => ({
  symbol: `S${strike}`,
  label: `$${strike}`,
  strike,
  bid: chance === null ? null : chance - spread,
  ask: chance === null ? null : chance + spread,
  open: true,
  state: 'active/open',
});

// The README's example prices sit on the first ladder: 62,500 at 82% and 63,500 at 41%.
// Its bars, lowest first: 3, 5, 10, 20, 21, 21, 12 and 8 percent.
const btc = [rung(61500, 0.97), rung(62000, 0.92), rung(62500, 0.82), rung(63000, 0.62), rung(63500, 0.41), rung(64000, 0.2), rung(64500, 0.08)];
const eth = [rung(3000, 0.9), rung(3100, 0.7), rung(3200, 0.45), rung(3300, 0.2)];
const sol = [rung(140, 0.85), rung(150, 0.6), rung(160, 0.3)];
const ladders = { BTC: btc, ETH: eth, SOL: sol };

const up = (ticker: string, condition: number, target: number): JointLeg => ({ ticker, shape: { kind: 'up', condition, target } });
const down = (ticker: string, condition: number, target: number): JointLeg => ({ ticker, shape: { kind: 'down', condition, target } });
const range = (ticker: string, low: number, high: number): JointLeg => ({ ticker, shape: { kind: 'range', low, high } });
const breakout = (ticker: string, low: number, high: number): JointLeg => ({ ticker, shape: { kind: 'breakout', low, high } });

/** Every number anywhere in a result, to check that none of them is NaN. */
const numbers = (x: unknown): number[] => (typeof x === 'number' ? [x] : x && typeof x === 'object' ? Object.values(x).flatMap(numbers) : []);

const expectSpan = (s: Span | null, want: { low: number; high: number; ifUnrelated: number; exact: boolean }) => {
  expect(s).not.toBeNull();
  expect(s!.low).toBeCloseTo(want.low, 8);
  expect(s!.high).toBeCloseTo(want.high, 8);
  expect(s!.ifUnrelated).toBeCloseTo(want.ifUnrelated, 8);
  expect(s!.exact).toBe(want.exact);
};

describe('legs on one ladder are decided by one price, so the answer is exact', () => {
  it('two rising parlays that nest: both win exactly when the higher target is reached', () => {
    const t = together([up('BTC', 62000, 63000), up('BTC', 62500, 63500)], ladders);
    expect(t.groups).toHaveLength(1);
    expect(t.groups[0]).toMatchObject({ ticker: 'BTC', legs: [0, 1], adjusted: false });
    expect(t.groups[0]!.allWin).toBeCloseTo(0.41, 8);
    expect(t.groups[0]!.anyWin).toBeCloseTo(0.62, 8);
    // Neither loses below 62,000 (both get the stake back) or at 63,500 and above (both win).
    expect(t.groups[0]!.noneLose).toBeCloseTo(0.08 + 0.41, 8);
    expectSpan(t.allWin, { low: 0.41, high: 0.41, ifUnrelated: 0.41, exact: true });
    expectSpan(t.anyWin, { low: 0.62, high: 0.62, ifUnrelated: 0.62, exact: true });
    expect(t.impossible).toEqual([]);
    expect(t.missing).toEqual([]);
  });

  it('a rising and a falling parlay whose winning prices do not overlap cannot both win: exactly 0', () => {
    const t = together([up('BTC', 62500, 63500), down('BTC', 63500, 62500)], ladders);
    expect(t.groups[0]!.allWin).toBe(0);
    expectSpan(t.allWin, { low: 0, high: 0, ifUnrelated: 0, exact: true });
    expect(t.impossible).toEqual([{ legs: [0, 1], ticker: 'BTC' }]);
    // One of them still can: at 63,500 or above, or below 62,500.
    expect(t.groups[0]!.anyWin).toBeCloseTo(0.41 + 0.18, 8);
    expect(t.groups[0]!.noneLose).toBeCloseTo(0.41 + 0.18, 8);
  });

  it('a rising and a falling parlay that cross can both win, in the stretch between their targets', () => {
    const t = together([up('BTC', 61500, 62000), down('BTC', 64500, 64000)], ladders);
    expect(t.impossible).toEqual([]);
    expect(t.groups[0]!.allWin).toBeCloseTo(0.92 - 0.2, 8);
  });

  it("a range inside a parlay's winning prices: both win whenever the range does", () => {
    const t = together([up('BTC', 62000, 62500), range('BTC', 63000, 64000)], ladders);
    expect(t.groups[0]!.allWin).toBeCloseTo(0.62 - 0.2, 8);
    expect(t.groups[0]!.anyWin).toBeCloseTo(0.82, 8);
    expect(t.groups[0]!.noneLose).toBeCloseTo(0.62 - 0.2, 8);
    expect(t.allWin!.exact).toBe(true);
    expect(t.impossible).toEqual([]);
  });

  it('a range that stops where a parlay starts to win shares no price with it', () => {
    const t = together([range('BTC', 62000, 62500), up('BTC', 61500, 62500)], ladders);
    expect(t.groups[0]!.allWin).toBe(0);
    expect(t.impossible).toEqual([{ legs: [0, 1], ticker: 'BTC' }]);
  });

  it('agrees with adding up the bars directly, for every bet the ladder can hold', () => {
    const { buckets, levels } = distributionOf(btc)!;
    const strikes = levels.map((l) => l.strike);
    const shapes: Shape[] = [];
    for (let i = 0; i < strikes.length; i++) {
      for (let j = i + 1; j < strikes.length; j++) {
        shapes.push({ kind: 'up', condition: strikes[i]!, target: strikes[j]! });
        shapes.push({ kind: 'down', condition: strikes[j]!, target: strikes[i]! });
        shapes.push({ kind: 'range', low: strikes[i]!, high: strikes[j]! });
      }
    }
    expect(shapes).toHaveLength(63);
    for (const shape of shapes) {
      const z = zoneChances(shape, buckets);
      const t = together([{ ticker: 'BTC', shape }], ladders);
      expect(t.groups[0]!.allWin).toBeCloseTo(z.win, 8);
      expect(t.groups[0]!.anyWin).toBeCloseTo(z.win, 8);
      expect(t.groups[0]!.noneLose).toBeCloseTo(z.win + z.back, 8);
      expectSpan(t.allWin, { low: z.win, high: z.win, ifUnrelated: z.win, exact: true });
    }
  });

  it('counts a shared win once: at least one wins is the two chances less the chance of both', () => {
    const { buckets } = distributionOf(btc)!;
    const pairs: [JointLeg, JointLeg][] = [
      [up('BTC', 62000, 63000), range('BTC', 62500, 63500)],
      [down('BTC', 64000, 63000), range('BTC', 62000, 64500)],
      [up('BTC', 61500, 64000), down('BTC', 64500, 62000)],
    ];
    for (const [a, b] of pairs) {
      const g = together([a, b], ladders).groups[0]!;
      const wa = zoneChances(a.shape, buckets).win;
      const wb = zoneChances(b.shape, buckets).win;
      expect(g.anyWin).toBeCloseTo(wa + wb - g.allWin, 8);
      expect(g.allWin).toBeLessThanOrEqual(Math.min(wa, wb) + 1e-9);
      expect(canBothWin(a.shape, b.shape)).toBe(g.allWin > 0);
    }
  });

  it('does not depend on the order of the legs or of the rungs', () => {
    const a = together([up('BTC', 62000, 63000), range('BTC', 62500, 64000)], ladders);
    const b = together([range('BTC', 62500, 64000), up('BTC', 62000, 63000)], { BTC: [...btc].reverse() });
    expect(b.allWin).toEqual(a.allWin);
    expect(b.anyWin).toEqual(a.anyWin);
    expect(b.noneLose).toEqual(a.noneLose);
  });
});

describe('a breakout wins on two stretches of the price line: below its lower level, and at or above its higher one', () => {
  it('a breakout and a range on the same two levels can never both win, and exactly one always does', () => {
    const t = together([breakout('BTC', 62500, 63500), range('BTC', 62500, 63500)], ladders);
    expect(canBothWin({ kind: 'breakout', low: 62500, high: 63500 }, { kind: 'range', low: 62500, high: 63500 })).toBe(false);
    expect(t.impossible).toEqual([{ legs: [0, 1], ticker: 'BTC' }]);
    expect(t.groups[0]!.allWin).toBe(0);
    expect(t.groups[0]!.anyWin).toBe(1);
    // Wherever the price finishes, one of the two has lost: neither has a stake that comes back.
    expect(t.groups[0]!.noneLose).toBe(0);
    expectSpan(t.allWin, { low: 0, high: 0, ifUnrelated: 0, exact: true });
    expectSpan(t.anyWin, { low: 1, high: 1, ifUnrelated: 1, exact: true });
  });

  it('with a rising parlay whose target is at or above its higher level: both win exactly when the parlay does', () => {
    // The parlay's target is the breakout's own higher level, then one above it.
    for (const [target, both] of [
      [63500, 0.41],
      [64000, 0.2],
    ] as const) {
      const t = together([breakout('BTC', 62500, 63500), up('BTC', 62000, target)], ladders);
      expect(t.impossible).toEqual([]);
      expect(t.groups[0]!.allWin).toBeCloseTo(both, 8);
      // The parlay wins only where the breakout already does, so at least one winning is the breakout winning.
      expect(t.groups[0]!.anyWin).toBeCloseTo(0.18 + 0.41, 8);
      expect(t.allWin!.exact).toBe(true);
    }
    // Neither loses below 62,000 (the breakout wins, the parlay's stake comes back) or where both win.
    const t = together([breakout('BTC', 62500, 63500), up('BTC', 62000, 64000)], ladders);
    expect(t.groups[0]!.noneLose).toBeCloseTo(0.08 + 0.2, 8);
  });

  it('with a rising parlay whose target is inside its band: both win only at or above the higher level', () => {
    const t = together([breakout('BTC', 62500, 64000), up('BTC', 62000, 63000)], ladders);
    expect(t.impossible).toEqual([]);
    expect(t.groups[0]!.allWin).toBeCloseTo(0.2, 8);
    expect(t.groups[0]!.anyWin).toBeCloseTo(0.18 + 0.62, 8);
  });

  it('with a falling parlay: both win below whichever of the two levels is lower', () => {
    expect(together([breakout('BTC', 62500, 63500), down('BTC', 63500, 63000)], ladders).groups[0]!.allWin).toBeCloseTo(0.18, 8);
    expect(together([breakout('BTC', 62500, 63500), down('BTC', 63000, 62000)], ladders).groups[0]!.allWin).toBeCloseTo(0.08, 8);
  });

  it('with a range that lies wholly inside its band, the two cannot both win; one that reaches past an edge can', () => {
    expect(together([breakout('BTC', 62000, 64000), range('BTC', 62500, 63500)], ladders).impossible).toEqual([{ legs: [0, 1], ticker: 'BTC' }]);
    const t = together([breakout('BTC', 62500, 63500), range('BTC', 62000, 63000)], ladders);
    expect(t.impossible).toEqual([]);
    expect(t.groups[0]!.allWin).toBeCloseTo(0.92 - 0.82, 8);
  });

  it('two breakouts both win outside the wider of the two bands', () => {
    const t = together([breakout('BTC', 62500, 63500), breakout('BTC', 62000, 64000)], ladders);
    expect(t.impossible).toEqual([]);
    expect(t.groups[0]!.allWin).toBeCloseTo(0.08 + 0.2, 8);
    expect(t.groups[0]!.anyWin).toBeCloseTo(0.18 + 0.41, 8);
  });

  it('agrees with adding up the bars directly, for every breakout the ladder can hold', () => {
    const { buckets, levels } = distributionOf(btc)!;
    const strikes = levels.map((l) => l.strike);
    let seen = 0;
    for (let i = 0; i < strikes.length; i++) {
      for (let j = i + 1; j < strikes.length; j++) {
        const shape: Shape = { kind: 'breakout', low: strikes[i]!, high: strikes[j]! };
        const z = zoneChances(shape, buckets);
        const t = together([{ ticker: 'BTC', shape }], ladders);
        expect(t.groups[0]!.allWin).toBeCloseTo(z.win, 8);
        expect(t.groups[0]!.noneLose).toBeCloseTo(z.win, 8);
        expect(z.win).toBeCloseTo(1 - (levels[i]!.chance - levels[j]!.chance), 8);
        seen++;
      }
    }
    expect(seen).toBe(21);
  });

  it('says from the strikes alone whether two legs can both win, the same as the bars do', () => {
    const { levels } = distributionOf(btc)!;
    const strikes = levels.map((l) => l.strike);
    const b: JointLeg = breakout('BTC', 62500, 63500);
    for (let i = 0; i < strikes.length; i++) {
      for (let j = i + 1; j < strikes.length; j++) {
        for (const other of [up('BTC', strikes[i]!, strikes[j]!), down('BTC', strikes[j]!, strikes[i]!), range('BTC', strikes[i]!, strikes[j]!), breakout('BTC', strikes[i]!, strikes[j]!)]) {
          // Every bar of this ladder has some chance, so the two can both win exactly when some bar wins both.
          expect(canBothWin(b.shape, other.shape)).toBe(together([b, other], ladders).groups[0]!.allWin > 0);
        }
      }
    }
  });

  it('three legs can win two by two and still never all win, and that is named', () => {
    // The breakout wins with the first range only below 62,500 and with the second only at 63,500 or above; the two ranges
    // win together only between 62,500 and 63,000, where the breakout loses.
    const legs = [breakout('BTC', 62500, 63500), range('BTC', 62000, 63000), range('BTC', 62500, 64000)];
    const t = together(legs, ladders);
    expect(t.impossible).toEqual([]);
    expect(canAllWin(legs.map((l) => l.shape))).toBe(false);
    expect(t.groups[0]!.allWin).toBe(0);
    expectSpan(t.allWin, { low: 0, high: 0, ifUnrelated: 0, exact: true });
    expect(neverAllWin(legs)).toEqual([{ legs: [0, 1, 2], ticker: 'BTC' }]);
  });

  it('names nothing when the legs do share a winning price, when a pair already cannot, or when they are on other ladders', () => {
    expect(neverAllWin([breakout('BTC', 62500, 63500), up('BTC', 62000, 64000), range('BTC', 63500, 64500)])).toEqual([]);
    // The pair that cannot both win is reported as a pair, not twice.
    const clash = [breakout('BTC', 62500, 63500), range('BTC', 62500, 63500), up('BTC', 61500, 62000)];
    expect(together(clash, ladders).impossible).toHaveLength(1);
    expect(neverAllWin(clash)).toEqual([]);
    expect(neverAllWin([breakout('BTC', 62500, 63500), range('ETH', 3000, 3100), range('SOL', 140, 150), null])).toEqual([]);
  });
});

describe('legs on different ladders: only a range is certain', () => {
  it('three ladders: at most the least likely, at least what is left when they are pushed apart, the product in between', () => {
    // 82%, 70% and 55%.
    const t = together([up('BTC', 61500, 62500), up('ETH', 3000, 3100), range('SOL', 140, 160)], ladders);
    expect(t.groups.map((g) => g.ticker)).toEqual(['BTC', 'ETH', 'SOL']);
    expect(t.groups.map((g) => g.legs)).toEqual([[0], [1], [2]]);
    expectSpan(t.allWin, { low: 0.82 + 0.7 + 0.55 - 2, high: 0.55, ifUnrelated: 0.82 * 0.7 * 0.55, exact: false });
    expect(t.allWin!.low).toBeLessThanOrEqual(t.allWin!.ifUnrelated);
    expect(t.allWin!.ifUnrelated).toBeLessThanOrEqual(t.allWin!.high);
    // At least one wins: no less than the likeliest, no more than certain.
    expectSpan(t.anyWin, { low: 0.82, high: 1, ifUnrelated: 1 - 0.18 * 0.3 * 0.45, exact: false });
    // None loses: 85%, 80% and 55%.
    expectSpan(t.noneLose, { low: 0.85 + 0.8 + 0.55 - 2, high: 0.55, ifUnrelated: 0.85 * 0.8 * 0.55, exact: false });
  });

  it('the low end stops at 0 when the chances are too small to force an overlap', () => {
    const t = together([up('BTC', 64000, 64500), up('ETH', 3200, 3300)], ladders);
    expectSpan(t.allWin, { low: 0, high: 0.08, ifUnrelated: 0.08 * 0.2, exact: false });
  });

  it('keeps the range in order for every choice of legs: low, then the unrelated figure, then high', () => {
    const tops = (rungs: Rung[]) => rungs.slice(1).map((r) => r.strike);
    for (const b of tops(btc)) {
      for (const e of tops(eth)) {
        for (const s of tops(sol)) {
          const t = together([up('BTC', 61500, b), down('ETH', e, 3000), up('SOL', 140, s)], ladders);
          for (const sp of [t.allWin!, t.anyWin!, t.noneLose!]) {
            expect(sp.low).toBeGreaterThanOrEqual(0);
            expect(sp.low).toBeLessThanOrEqual(sp.ifUnrelated);
            expect(sp.ifUnrelated).toBeLessThanOrEqual(sp.high);
            expect(sp.high).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('groups legs by ladder first: two on one ladder are worked out exactly, then bounded against the other', () => {
    const t = together([up('BTC', 62000, 63000), up('ETH', 3000, 3200), up('BTC', 62500, 63500)], ladders);
    expect(t.groups.map((g) => [g.ticker, g.legs])).toEqual([
      ['BTC', [0, 2]],
      ['ETH', [1]],
    ]);
    // Both BTC legs win at 41%; the ETH leg at 45%.
    expectSpan(t.allWin, { low: 0, high: 0.41, ifUnrelated: 0.41 * 0.45, exact: false });
    // At least one BTC leg wins at 62%.
    expectSpan(t.anyWin, { low: 0.62, high: 1, ifUnrelated: 1 - 0.38 * 0.55, exact: false });
  });

  it('two legs on one ladder that cannot both win make every leg winning exactly 0, whatever the other ladders do', () => {
    const t = together([up('BTC', 62500, 63500), up('ETH', 3000, 3100), down('BTC', 63500, 62500)], ladders);
    expectSpan(t.allWin, { low: 0, high: 0, ifUnrelated: 0, exact: true });
    expect(t.impossible).toEqual([{ legs: [0, 2], ticker: 'BTC' }]);
    expect(t.anyWin!.exact).toBe(false);
  });

  it('never calls legs on different ladders impossible, however far apart they look', () => {
    const t = together([up('BTC', 62500, 63500), down('ETH', 3100, 3000)], ladders);
    expect(t.impossible).toEqual([]);
  });
});

describe('a leg that cannot be read is left out and reported', () => {
  it('a ladder with fewer than two priced rungs: its leg is missing, the rest still read, nothing is NaN', () => {
    const thin = [rung(1, 0.9), rung(2, null), rung(3, null)];
    const t = together([up('BTC', 62500, 63500), up('THIN', 1, 2)], { ...ladders, THIN: thin });
    expect(t.missing).toEqual([1]);
    expect(t.groups).toHaveLength(1);
    expect(t.groups[0]!.legs).toEqual([0]);
    expect(t.groups[0]!.allWin).toBeCloseTo(0.41, 8);
    // "Every leg" cannot be said without the leg that is missing.
    expect(t.allWin).toBeNull();
    expect(t.anyWin).toBeNull();
    expect(t.noneLose).toBeNull();
    expect(numbers(t).every(Number.isFinite)).toBe(true);
  });

  it('a leg built on a rung with a one-sided book is left out, and other legs on that ladder are not', () => {
    const gap = btc.map((r) => (r.strike === 63000 ? rung(63000, null) : r));
    const t = together([up('BTC', 62500, 63000), up('BTC', 62500, 63500)], { BTC: gap });
    expect(t.missing).toEqual([0]);
    expect(t.groups[0]!.legs).toEqual([1]);
    expect(t.groups[0]!.allWin).toBeCloseTo(0.41, 8);
    expect(t.allWin).toBeNull();
    expect(numbers(t).every(Number.isFinite)).toBe(true);
  });

  it('a leg with nothing chosen yet, or on a ladder that is not listed, is missing too', () => {
    const t = together([null, up('GONE', 1, 2), range('SOL', 140, 150)], ladders);
    expect(t.missing).toEqual([0, 1]);
    expect(t.groups.map((g) => g.ticker)).toEqual(['SOL']);
    expect(t.allWin).toBeNull();
  });

  it('with every leg missing there are no groups and no figures', () => {
    const t = together([null, null], {});
    expect(t).toEqual({ groups: [], allWin: null, noneLose: null, anyWin: null, impossible: [], missing: [0, 1], adjusted: false });
  });

  it('still names a pair that cannot both win while their ladder has no prices: the strikes alone say so', () => {
    const dark = btc.map((r) => rung(r.strike, null));
    const t = together([up('BTC', 62500, 63500), down('BTC', 63500, 62500)], { BTC: dark });
    expect(t.missing).toEqual([0, 1]);
    expect(t.impossible).toEqual([{ legs: [0, 1], ticker: 'BTC' }]);
  });

  it('says when a ladder was out of order and had to be averaged', () => {
    const crossed = [rung(1, 0.9), rung(2, 0.5), rung(3, 0.6), rung(4, 0.2)];
    const t = together([up('X', 1, 3), up('BTC', 62500, 63500)], { ...ladders, X: crossed });
    expect(t.groups.map((g) => g.adjusted)).toEqual([true, false]);
    expect(t.adjusted).toBe(true);
    expect(t.groups[0]!.allWin).toBeCloseTo(0.55, 8);
  });
});

describe('in words', () => {
  it('builds a shape from a leg kind and its two levels', () => {
    expect(shapeOf('up', 62500, 63500)).toEqual({ kind: 'up', condition: 62500, target: 63500 });
    expect(shapeOf('down', 63500, 62500)).toEqual({ kind: 'down', condition: 63500, target: 62500 });
    expect(shapeOf('range', 62500, 63500)).toEqual({ kind: 'range', low: 62500, high: 63500 });
    expect(shapeOf('breakout', 62500, 63500)).toEqual({ kind: 'breakout', low: 62500, high: 63500 });
  });

  it('says where each kind of leg wins', () => {
    expect(winsAt({ kind: 'up', condition: 62500, target: 63500 })).toBe('at $63,500 or above');
    expect(winsAt({ kind: 'down', condition: 63500, target: 62500 })).toBe('below $62,500');
    expect(winsAt({ kind: 'range', low: 62500, high: 63500 })).toBe('between $62,500 and $63,500');
    expect(winsAt({ kind: 'breakout', low: 62500, high: 63500 })).toBe('outside $62,500 to $63,500');
  });

  it('never rounds a real chance to 0% or a real doubt to 100%', () => {
    expect(chanceWords(0)).toBe('0%');
    expect(chanceWords(0.004)).toBe('under 1%');
    expect(chanceWords(0.23)).toBe('23%');
    expect(chanceWords(0.996)).toBe('over 99%');
    expect(chanceWords(1)).toBe('100%');
  });

  it('gives one figure when the ends meet and a range when they do not', () => {
    expect(spanWords({ low: 0.23, high: 0.23, ifUnrelated: 0.23, exact: true })).toBe('23%');
    expect(spanWords({ low: 0, high: 0, ifUnrelated: 0, exact: true })).toBe('0%');
    expect(spanWords({ low: 0.04, high: 0.31, ifUnrelated: 0.12, exact: false })).toBe('between 4% and 31%');
    expect(spanWords({ low: 0, high: 0.31, ifUnrelated: 0.12, exact: false })).toBe('between 0% and 31%');
    expect(spanWords({ low: 0.121, high: 0.124, ifUnrelated: 0.122, exact: false })).toBe('about 12%');
    expect(spanWords({ low: 0, high: 0.003, ifUnrelated: 0.001, exact: false })).toBe('under 1%');
  });
});
