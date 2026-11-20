import { describe, expect, it } from 'vitest';
import type { Rung } from '../api/types';
import { distributionOf } from './distribution';
import { builderLink } from './hunch';
import { allInPrice, breakoutUnitCost, feeRate, outcomesFor, PRODUCTION_FEE_COEF, rangeEstimate, rangeUnitCost } from './pricing';
import { bandLevels, contractsText, handoverLink, handoverOf, MAX_PAY, orderText, paysIn, PRESET_PAY, PRESETS, presetShape, sketchOf, stepsOf, whereText, type Sketch, type SketchOrder } from './sketch';

const rung = (strike: number, bid: number | null, ask: number | null): Rung => ({
  symbol: `S${strike}`,
  label: `$${strike.toLocaleString('en-US')} or above`,
  strike,
  bid,
  ask,
  open: true,
  state: 'active/open',
});

// The README's example prices sit on this ladder: 62,500 at 0.80 / 0.82 and 63,500 at 0.40 / 0.42.
// Seven levels, so eight bars. The bars' chances are 3, 5, 11, 19, 21, 21, 12 and 8 percent.
const ladder = [rung(61500, 0.96, 0.98), rung(62000, 0.91, 0.93), rung(62500, 0.8, 0.82), rung(63000, 0.61, 0.63), rung(63500, 0.4, 0.42), rung(64000, 0.19, 0.21), rung(64500, 0.07, 0.09)];
const CHANCES = [0.03, 0.05, 0.11, 0.19, 0.21, 0.21, 0.12, 0.08];

const must = (rungs: Rung[], wanted: number[], coef = 0): Sketch => {
  const s = sketchOf(rungs, wanted, coef);
  if (!s) throw new Error('no sketch');
  return s;
};

/** Every number in a sketch, to check none of them is NaN or infinite. */
const numbers = (s: Sketch): number[] => [s.floor, s.back, s.pay, s.fees, s.atRisk, s.fair, s.over, s.chanceAhead, s.best.net, s.worst.net, ...s.shape, ...s.receive, ...s.net, ...s.orders.flatMap((o) => [o.contracts, o.price, o.fee, o.cost])];

/** A price inside each bar, so an order can be settled the way the exchange would: by the finishing price alone. */
function finishes(rungs: Rung[]): number[] {
  const strikes = distributionOf(rungs)!.levels.map((l) => l.strike);
  const out = [strikes[0]! - 1];
  for (let i = 0; i < strikes.length - 1; i++) out.push((strikes[i]! + strikes[i + 1]!) / 2);
  // The top bar starts AT the highest level: "at or above" includes the level itself.
  out.push(strikes[strikes.length - 1]!);
  return out;
}

/** What the orders pay at a finishing price: a YES pays at or above its strike, a NO below it. */
const settle = (orders: SketchOrder[], price: number): number => orders.reduce((n, o) => n + ((o.outcome === 'yes') === price >= o.strike ? o.contracts : 0), 0);

/** A small seeded generator, so the random shapes are the same on every run. */
function seeded(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/** A ladder in order: chances that fall as the price rises, each with its own spread. */
function randomLadder(rand: () => number): Rung[] {
  const n = 2 + Math.floor(rand() * 9);
  const cuts = Array.from({ length: n }, () => 0.04 + rand() * 0.92).sort((a, b) => b - a);
  return cuts.map((mid, i) => {
    const half = 0.005 + rand() * 0.02;
    return rung(1000 + i * 50, Math.max(0.01, Math.round((mid - half) * 100) / 100), Math.min(0.99, Math.round((mid + half) * 100) / 100));
  });
}

describe('steps and what orders pay', () => {
  it('reads one step per level: the amount above it less the amount below', () => {
    expect(stepsOf([0, 0, 10, 10, 4])).toEqual([0, 10, 0, -6]);
    expect(stepsOf([5])).toEqual([]);
  });

  it('pays a YES in every bar above its level and a NO in every bar at or below it', () => {
    const yes = [{ level: 2, outcome: 'yes' as const, contracts: 4 }];
    const no = [{ level: 2, outcome: 'no' as const, contracts: 7 }];
    expect([0, 1, 2, 3, 4].map((b) => paysIn(yes, b))).toEqual([0, 0, 0, 4, 4]);
    expect([0, 1, 2, 3, 4].map((b) => paysIn(no, b))).toEqual([7, 7, 7, 0, 0]);
  });
});

describe('a sketch on the README ladder', () => {
  it('stands on the bars the chart draws', () => {
    expect(distributionOf(ladder)!.buckets.map((b) => b.chance)).toEqual(CHANCES);
    // A dollar in every bar but the lowest is one YES on the lowest level: worth that level's chance, and it costs its ask.
    const s = must(ladder, [0, 1, 1, 1, 1, 1, 1, 1]);
    expect(s.fair).toBeCloseTo(1 - CHANCES[0]!, 8);
    expect(s.pay).toBe(0.98);
  });

  it('prices a range as the README does: $14.20 for 10 of each, +$5.80 inside, −$4.20 outside, $10 back either way', () => {
    const s = must(ladder, [0, 0, 0, 10, 10, 0, 0, 0]);
    expect(s.orders).toEqual([
      { level: 2, symbol: 'S62500', label: '$62,500 or above', strike: 62500, outcome: 'yes', contracts: 10, price: 0.82, fee: 0, cost: 8.2 },
      { level: 4, symbol: 'S63500', label: '$63,500 or above', strike: 63500, outcome: 'no', contracts: 10, price: 0.6, fee: 0, cost: 6 },
    ]);
    expect(s.pay).toBe(14.2);
    expect(s.back).toBe(10);
    expect(s.atRisk).toBe(4.2);
    expect(s.receive).toEqual([10, 10, 10, 20, 20, 10, 10, 10]);
    expect(s.net).toEqual([-4.2, -4.2, -4.2, 5.8, 5.8, -4.2, -4.2, -4.2]);
    expect(s.best).toEqual({ net: 5.8, bars: [3, 4] });
    expect(s.worst).toEqual({ net: -4.2, bars: [0, 1, 2, 5, 6, 7] });
    // Worth at the market's odds: $10 times the 19% and 21% bars. The 20 cents over is the two half-spreads on 10 contracts.
    expect(s.fair).toBe(4);
    expect(s.over).toBe(0.2);
    expect(s.chanceAhead).toBe(0.4);
    expect(s.flat).toBe(false);
    expect(s.floor).toBe(0);
  });

  it('prices a breakout as the README does: 16.12 of each for $9.99, +$6.13 outside, −$9.99 between', () => {
    const c = 16.12;
    const s = must(ladder, [c, c, c, 0, 0, c, c, c]);
    expect(s.orders.map((o) => [o.symbol, o.outcome, o.contracts, o.price])).toEqual([
      ['S62500', 'no', 16.12, 0.2],
      ['S63500', 'yes', 16.12, 0.42],
    ]);
    expect(s.pay).toBeCloseTo(9.9944, 8);
    // Only one of the two can pay, so nothing comes back in every bar and all of it is at risk.
    expect(s.back).toBe(0);
    expect(s.atRisk).toBe(s.pay);
    expect(s.best.net).toBeCloseTo(6.1256, 8);
    expect(s.best.bars).toEqual([0, 1, 2, 5, 6, 7]);
    expect(s.worst.net).toBeCloseTo(-9.9944, 8);
    expect(s.worst.bars).toEqual([3, 4]);
    expect(s.chanceAhead).toBeCloseTo(0.6, 8);
  });

  it('agrees with the builders at the production fee: a range and a breakout cost what the page’s own port says', () => {
    const coef = PRODUCTION_FEE_COEF;
    const range = must(ladder, [0, 0, 0, 10, 10, 0, 0, 0], coef);
    expect(range.pay).toBeCloseTo(10 * rangeUnitCost(0.82, 0.4, coef), 7);
    expect(range.orders[0]!.fee).toBeCloseTo(feeRate(0.82, coef), 8);
    expect(range.orders[1]!.fee).toBeCloseTo(feeRate(0.6, coef), 8);
    expect(range.fees).toBeCloseTo(10 * (feeRate(0.82, coef) + feeRate(0.6, coef)), 7);
    // What is at risk for each $1 of "inside" payout is the Range builder's price per $1.
    expect(range.atRisk / 10).toBeCloseTo(rangeEstimate({ bid: 0.8, ask: 0.82 }, { bid: 0.4, ask: 0.42 }, coef)!.pricePaid, 7);

    const breakout = must(ladder, [10, 10, 10, 0, 0, 10, 10, 10], coef);
    expect(breakout.pay).toBeCloseTo(10 * breakoutUnitCost(0.8, 0.42, coef), 7);
    expect(breakout.back).toBe(0);
  });

  it('charges no fee when the exchange charges none', () => {
    const s = must(ladder, [0, 4, 9, 2, 0, 7, 7, 1], 0);
    expect(s.fees).toBe(0);
    expect(s.orders.every((o) => o.fee === 0)).toBe(true);
  });

  it('prices a Return Parlay drawn by hand as its builder would, rising and falling', () => {
    for (const coef of [0, PRODUCTION_FEE_COEF]) {
      const stake = 10;
      // Rising: first level 62,500 (its NO hands the stake back), target 63,500 (its YES is the bet).
      const up = allInPrice(0.42, 0.8, coef)!;
      const rising = must(ladder, [stake, stake, stake, 0, 0, stake / up, stake / up, stake / up], coef);
      expect(rising.pay).toBeCloseTo(stake, 6);
      expect(rising.net.slice(0, 3).every((x) => Math.abs(x) < 1e-6)).toBe(true);
      expect(rising.net[3]).toBeCloseTo(-stake, 6);
      expect(rising.net[7]).toBeCloseTo(outcomesFor(stake, up).ifBothHit, 6);
      // Getting the stake back is not ending ahead: only the bars at or above the target count.
      expect(rising.chanceAhead).toBeCloseTo(0.41, 8);
      expect(rising.handover).toEqual({ kind: 'parlay', direction: 'up', condition: { symbol: 'S62500', strike: 62500 }, target: { symbol: 'S63500', strike: 63500 } });

      // Falling: the same two contracts from their NO side. First level 63,500 (to stay under), target 62,500 (to fall below).
      const down = allInPrice(1 - 0.8, 1 - 0.42, coef)!;
      const falling = must(ladder, [stake / down, stake / down, stake / down, 0, 0, stake, stake, stake], coef);
      expect(falling.pay).toBeCloseTo(stake, 6);
      expect(falling.net.slice(5).every((x) => Math.abs(x) < 1e-6)).toBe(true);
      expect(falling.net[4]).toBeCloseTo(-stake, 6);
      expect(falling.net[0]).toBeCloseTo(outcomesFor(stake, down).ifBothHit, 6);
      expect(falling.handover).toEqual({ kind: 'parlay', direction: 'down', condition: { symbol: 'S63500', strike: 63500 }, target: { symbol: 'S62500', strike: 62500 } });
    }
  });

  it('says what the best and the worst result are and where each happens', () => {
    const s = must(ladder, [0, 0, 5, 10, 10, 5, 0, 0]);
    // 5 YES at 62,000 and at 62,500, 5 NO at 63,500 and at 64,000.
    expect(s.orders.map((o) => `${o.contracts} ${o.outcome} ${o.strike}`)).toEqual(['5 yes 62000', '5 yes 62500', '5 no 63500', '5 no 64000']);
    expect(s.pay).toBeCloseTo(5 * 0.93 + 5 * 0.82 + 5 * 0.6 + 5 * 0.81, 8);
    expect(s.back).toBe(10);
    expect(s.best.bars).toEqual([3, 4]);
    expect(s.worst.bars).toEqual([0, 1, 6, 7]);
    expect(s.best.net - s.worst.net).toBeCloseTo(10, 8);
  });
});

describe('the identity behind every sketch', () => {
  const shapes: number[][] = [
    [0, 0, 0, 10, 10, 0, 0, 0],
    [10, 10, 10, 0, 0, 10, 10, 10],
    [0, 0, 0, 0, 0, 10, 10, 10],
    [10, 10, 10, 0, 0, 0, 0, 0],
    [0, 1, 2, 3, 4, 5, 6, 7],
    [7, 6, 5, 4, 3, 2, 1, 0],
    [0, 20, 0, 20, 0, 20, 0, 20],
    [20, 0, 20, 0, 20, 0, 20, 0],
    [0, 0, 0, 0, 0, 0, 0, 20],
    [20, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 13, 0, 0, 0, 0],
    [4, 0, 9, 9, 2, 0, 17, 3],
    [0.5, 0, 2.25, 7.75, 0, 0, 1.1, 0.01],
  ];

  it('pays the wanted amount plus one fixed amount in every bar, for shapes that touch zero', () => {
    for (const p of shapes) {
      const s = must(ladder, p);
      expect(s.floor).toBe(0);
      expect(s.back).toBeGreaterThanOrEqual(0);
      const steps = stepsOf(p);
      const downs = steps.reduce((n, d) => n + (d < 0 ? -d : 0), 0);
      expect(s.back).toBeCloseTo(downs - p[0]!, 8);
      p.forEach((want, b) => {
        expect(s.receive[b]).toBeCloseTo(want + s.back, 8);
        expect(s.net[b]).toBeCloseTo(s.receive[b]! - s.pay, 8);
        expect(s.net[b]).toBeCloseTo(want - s.atRisk, 8);
      });
      // The amount that comes back is exactly the least the orders ever pay.
      expect(Math.min(...s.receive)).toBeCloseTo(s.back, 8);
    }
  });

  it('buys YES where the amount steps up and NO where it steps down, one order per step and none where it is level', () => {
    for (const p of shapes) {
      const s = must(ladder, p);
      const steps = stepsOf(p);
      expect(s.orders).toHaveLength(steps.filter((d) => d !== 0).length);
      for (const o of s.orders) {
        const d = steps[o.level]!;
        expect(o.outcome).toBe(d > 0 ? 'yes' : 'no');
        expect(o.contracts).toBeCloseTo(Math.abs(d), 8);
        expect(o.symbol).toBe(ladder[o.level]!.symbol);
        expect(o.price).toBeCloseTo(d > 0 ? ladder[o.level]!.ask! : 1 - ladder[o.level]!.bid!, 8);
      }
    }
  });

  it('holds for random shapes on random ladders, settled the way the exchange would settle them', () => {
    const rand = seeded(20261120);
    for (let run = 0; run < 400; run++) {
      const rungs = randomLadder(rand);
      const dist = distributionOf(rungs)!;
      const bars = dist.buckets.length;
      const whole = rand() < 0.5;
      const p = Array.from({ length: bars }, () => (rand() < 0.3 ? 0 : whole ? Math.floor(rand() * (MAX_PAY + 1)) : Math.round(rand() * MAX_PAY * 100) / 100));
      const coef = rand() < 0.5 ? 0 : PRODUCTION_FEE_COEF;
      const s = must(rungs, p, coef);

      expect(numbers(s).every(Number.isFinite)).toBe(true);
      expect(s.floor).toBeCloseTo(Math.min(...p), 8);
      expect(s.back).toBeGreaterThanOrEqual(0);

      const prices = finishes(rungs);
      p.forEach((want, b) => {
        // Settled order by order at a price inside the bar: nothing here uses the library's own bar arithmetic.
        expect(settle(s.orders, prices[b]!)).toBeCloseTo(s.receive[b]!, 6);
        expect(s.receive[b]).toBeCloseTo(want - s.floor + s.back, 6);
        expect(s.net[b]).toBeCloseTo(s.receive[b]! - s.pay, 6);
      });

      expect(s.pay).toBeCloseTo(s.orders.reduce((n, o) => n + o.contracts * (o.price + feeRate(o.price, coef)), 0), 6);
      expect(s.atRisk).toBeCloseTo(s.pay - s.back, 7);
      expect(s.fair).toBeCloseTo(p.reduce((n, want, b) => n + (want - s.floor) * dist.buckets[b]!.chance, 0), 6);
      // On average, at the market's own odds, a shape loses exactly what it costs over those odds.
      expect(s.net.reduce((n, x, b) => n + x * dist.buckets[b]!.chance, 0)).toBeCloseTo(-s.over, 6);

      // What it costs over the market's odds is each order's price over the market's chance of it paying: spread and fee.
      if (!dist.adjusted) {
        const perOrder = s.orders.reduce((n, o) => {
          const chanceYes = dist.levels[o.level]!.chance;
          return n + o.contracts * (o.price + o.fee - (o.outcome === 'yes' ? chanceYes : 1 - chanceYes));
        }, 0);
        expect(s.over).toBeCloseTo(perOrder, 6);
        expect(s.over).toBeGreaterThanOrEqual(-1e-9);
      }

      const ahead = s.net.reduce((n, x, b) => n + (x > 0.005 ? dist.buckets[b]!.chance : 0), 0);
      expect(s.chanceAhead).toBeCloseTo(ahead, 7);
      expect(s.chanceAhead).toBeGreaterThanOrEqual(0);
      expect(s.chanceAhead).toBeLessThanOrEqual(1 + 1e-9);
      expect(s.best.net).toBeCloseTo(Math.max(...s.net), 8);
      expect(s.worst.net).toBeCloseTo(Math.min(...s.net), 8);
      expect(s.best.bars.length).toBeGreaterThan(0);
      expect(s.worst.bars.length).toBeGreaterThan(0);
      // The worst result is losing all that is at risk, in a bar where the shape pays nothing.
      expect(s.worst.net).toBeCloseTo(-s.atRisk, 7);
    }
  });
});

describe('shapes with nothing to buy, and amounts asked for everywhere', () => {
  it('has no orders for an all-zero shape, and says so with zeros, not NaN', () => {
    const s = must(ladder, [0, 0, 0, 0, 0, 0, 0, 0]);
    expect(s.flat).toBe(true);
    expect(s.orders).toEqual([]);
    expect(s.handover).toEqual({ kind: 'none' });
    expect([s.pay, s.back, s.atRisk, s.fair, s.over, s.chanceAhead, s.fees, s.floor]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(s.net).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(s.best).toEqual({ net: 0, bars: [0, 1, 2, 3, 4, 5, 6, 7] });
    expect(numbers(s).every(Number.isFinite)).toBe(true);
  });

  it('has no orders for the same amount in every bar: that is money kept, not a bet', () => {
    const s = must(ladder, [5, 5, 5, 5, 5, 5, 5, 5]);
    expect(s.flat).toBe(true);
    expect(s.floor).toBe(5);
    expect(s.orders).toEqual([]);
    expect(s.pay).toBe(0);
    expect(numbers(s).every(Number.isFinite)).toBe(true);
  });

  it('measures a shape above its lowest bar, so an amount asked for everywhere changes no order and no figure', () => {
    const plain = must(ladder, [0, 0, 0, 10, 10, 0, 0, 0]);
    const lifted = must(ladder, [3, 3, 3, 13, 13, 3, 3, 3]);
    expect(lifted.floor).toBe(3);
    expect({ ...lifted, floor: 0 }).toEqual(plain);
    // The orders pay the wanted amounts less the $3 nobody has to buy, plus what comes back.
    expect(lifted.receive).toEqual([3, 3, 3, 13, 13, 3, 3, 3].map((w) => w - 3 + lifted.back));
    // Without that, a shape that only rises would "come back" a negative amount.
    expect(must(ladder, [10, 10, 12, 12, 12, 12, 12, 12]).back).toBe(0);
  });

  it('reads an amount below zero, or one that is not a number, as nothing', () => {
    expect(must(ladder, [0, -4, Number.NaN, 10, 10, Number.POSITIVE_INFINITY, 0, 0])).toEqual(must(ladder, [0, 0, 0, 10, 10, 0, 0, 0]));
  });
});

describe('levels and the exchange’s list', () => {
  it('needs two priced rungs and one amount per bar', () => {
    expect(sketchOf([rung(1, 0.9, 0.92)], [0, 10])).toBeNull();
    expect(sketchOf([rung(1, 0.9, 0.92), rung(2, null, 0.5)], [0, 10])).toBeNull();
    expect(sketchOf(ladder, [0, 10])).toBeNull();
    expect(sketchOf(ladder, [0, 0, 0, 10, 10, 0, 0, 0, 0])).toBeNull();
    expect(sketchOf([], [])).toBeNull();
  });

  it('skips rungs with one-sided books, so its levels are the chart’s levels', () => {
    const holed = [...ladder.slice(0, 3), rung(62750, 0.7, null), rung(63000, null, 0.63), ...ladder.slice(4)];
    const dist = distributionOf(holed)!;
    expect(dist.levels.map((l) => l.strike)).toEqual([61500, 62000, 62500, 63500, 64000, 64500]);
    // Seven bars now. Bar 3 runs from 62,500 to 63,500.
    const s = must(holed, [0, 0, 0, 10, 0, 0, 0]);
    expect(s.orders.map((o) => [o.symbol, o.outcome, o.level])).toEqual([
      ['S62500', 'yes', 2],
      ['S63500', 'no', 3],
    ]);
    expect(s.pay).toBeCloseTo(14.2, 8);
    expect(sketchOf(holed, [0, 0, 0, 10, 10, 0, 0, 0])).toBeNull();
  });

  it('reads each level’s prices from the rung with its symbol, whatever order the exchange lists them in', () => {
    const p = [4, 0, 9, 9, 2, 0, 17, 3];
    const shuffled = [ladder[4]!, ladder[0]!, ladder[6]!, ladder[2]!, ladder[5]!, ladder[1]!, ladder[3]!];
    expect(must(shuffled, p, PRODUCTION_FEE_COEF)).toEqual(must(ladder, p, PRODUCTION_FEE_COEF));
  });

  it('uses the market’s evened-out chances for a ladder whose prices are out of order, and still pays the shape exactly', () => {
    const crossed = [rung(100, 0.7, 0.72), rung(110, 0.74, 0.76), rung(120, 0.3, 0.32)];
    const dist = distributionOf(crossed)!;
    expect(dist.adjusted).toBe(true);
    const s = must(crossed, [0, 10, 10, 0]);
    expect(s.receive).toEqual([10, 20, 20, 10]);
    expect(s.fair).toBeCloseTo(10 * (dist.buckets[1]!.chance + dist.buckets[2]!.chance), 8);
    expect(numbers(s).every(Number.isFinite)).toBe(true);
  });
});

describe('shapes a builder can place', () => {
  const order = (level: number, outcome: 'yes' | 'no', contracts: number): SketchOrder => ({ level, symbol: ladder[level]!.symbol, label: ladder[level]!.label, strike: ladder[level]!.strike, outcome, contracts, price: 0.5, fee: 0, cost: contracts * 0.5 });
  const leg = (level: number) => ({ symbol: ladder[level]!.symbol, strike: ladder[level]!.strike });
  const terms = { pricePaid: 0.5, fairPrice: 0.5, warn: false, waived: false };

  it('knows a range: one step up, then the same step down at a higher level', () => {
    const s = must(ladder, [0, 0, 0, 10, 10, 0, 0, 0]);
    expect(s.handover).toEqual({ kind: 'range', low: leg(2), high: leg(4) });
    expect(handoverLink('BTC1', s.handover)).toBe('/range?market=BTC1&low=S62500&high=S63500');
    expect(handoverLink('BTC1', s.handover)).toBe(builderLink('BTC1', { product: 'range', low: leg(2), high: leg(4), ...terms }));
  });

  it('knows a breakout: one step down, then the same step up at a higher level', () => {
    const s = must(ladder, [7, 7, 0, 0, 0, 0, 7, 7]);
    expect(s.handover).toEqual({ kind: 'breakout', low: leg(1), high: leg(5) });
    expect(handoverLink('BTC1', s.handover)).toBe('/range?market=BTC1&low=S62000&high=S64000&side=out');
    expect(handoverLink('BTC1', s.handover)).toBe(builderLink('BTC1', { product: 'breakout', low: leg(1), high: leg(5), ...terms }));
  });

  it('knows a Return Parlay: a step down then a different step up, rising when the YES is the bigger order', () => {
    const rising = must(ladder, [10, 10, 10, 0, 0, 18, 18, 18]);
    expect(rising.handover).toEqual({ kind: 'parlay', direction: 'up', condition: leg(2), target: leg(4) });
    expect(handoverLink('BTC1', rising.handover)).toBe('/parlay?market=BTC1&condition=S62500&target=S63500');
    expect(handoverLink('BTC1', rising.handover)).toBe(builderLink('BTC1', { product: 'parlay', direction: 'up', condition: leg(2), target: leg(4), ...terms }));

    const falling = must(ladder, [18, 18, 18, 0, 0, 10, 10, 10]);
    expect(falling.handover).toEqual({ kind: 'parlay', direction: 'down', condition: leg(4), target: leg(2) });
    expect(handoverLink('BTC1', falling.handover)).toBe('/parlay?market=BTC1&condition=S63500&target=S62500&direction=down');
    expect(handoverLink('BTC1', falling.handover)).toBe(builderLink('BTC1', { product: 'parlay', direction: 'down', condition: leg(4), target: leg(2), ...terms }));
  });

  it('calls one step a single plain contract, which no builder places', () => {
    const yes = must(ladder, [0, 0, 0, 0, 0, 10, 10, 10]);
    expect(yes.handover.kind).toBe('single');
    expect(yes.orders).toHaveLength(1);
    expect(yes.orders[0]).toMatchObject({ symbol: 'S63500', outcome: 'yes', contracts: 10, price: 0.42 });
    expect(yes.pay).toBe(4.2);
    expect(yes.back).toBe(0);
    expect(handoverLink('BTC1', yes.handover)).toBeNull();

    const no = must(ladder, [10, 10, 10, 0, 0, 0, 0, 0]);
    expect(no.handover.kind).toBe('single');
    expect(no.orders[0]).toMatchObject({ symbol: 'S62500', outcome: 'no', contracts: 10, price: 0.2 });
    expect(no.back).toBe(0);
  });

  it('counts the orders of every other shape', () => {
    const three = must(ladder, [0, 0, 5, 10, 10, 0, 0, 0]);
    expect(three.handover).toEqual({ kind: 'other', orders: 3 });
    expect(handoverLink('BTC1', three.handover)).toBeNull();
    expect(must(ladder, [0, 20, 0, 20, 0, 20, 0, 20]).handover).toEqual({ kind: 'other', orders: 7 });
  });

  it('does not mistake the two-order shapes nobody builds for one that is built', () => {
    // YES on both levels: pays more the higher it finishes.
    expect(must(ladder, [0, 0, 5, 5, 10, 10, 10, 10]).handover).toEqual({ kind: 'other', orders: 2 });
    // NO on both.
    expect(must(ladder, [10, 10, 5, 5, 0, 0, 0, 0]).handover).toEqual({ kind: 'other', orders: 2 });
    // A range with unequal sides: YES on the lower, a smaller NO on the higher.
    const lopsided = must(ladder, [0, 0, 0, 10, 10, 4, 4, 4]);
    expect(lopsided.handover).toEqual({ kind: 'other', orders: 2 });
    expect(lopsided.back).toBe(6);
    expect(lopsided.receive).toEqual([6, 6, 6, 16, 16, 10, 10, 10]);
  });

  it('judges two orders by their levels, not by the order they are given in', () => {
    expect(handoverOf([order(4, 'no', 3), order(2, 'yes', 3)])).toEqual({ kind: 'range', low: leg(2), high: leg(4) });
    expect(handoverOf([order(4, 'yes', 3), order(2, 'no', 3)])).toEqual({ kind: 'breakout', low: leg(2), high: leg(4) });
    expect(handoverOf([])).toEqual({ kind: 'none' });
  });
});

describe('a sketch in words', () => {
  const buckets = distributionOf(ladder)!.buckets;

  it('says an order in one plain line, with the exchange’s own name for the contract', () => {
    const s = must(ladder, [0, 0, 0, 10, 10, 0, 0, 0]);
    expect(s.orders.map(orderText)).toEqual(['Buy 10 YES on $62,500 or above at 82¢', 'Buy 10 NO on $63,500 or above at 60¢']);
    expect(orderText({ contracts: 16.12, outcome: 'no', label: '', strike: 141.6, price: 0.2 })).toBe('Buy 16.12 NO on $141.60 or above at 20¢');
    expect(contractsText(3)).toBe('3');
    expect(contractsText(2.5)).toBe('2.50');
  });

  it('reads bars side by side as one price range', () => {
    expect(whereText(buckets, [3, 4])).toBe('$62,500 to $63,500');
    expect(whereText(buckets, [0, 1, 2, 5, 6, 7])).toBe('Below $62,500, or $63,500 or more');
    expect(whereText(buckets, [0])).toBe('Below $61,500');
    expect(whereText(buckets, [7])).toBe('$64,500 or more');
    expect(whereText(buckets, [1, 3, 5])).toBe('$61,500 to $62,000, or $62,500 to $63,000, or $63,500 to $64,000');
    expect(whereText(buckets, [0, 1, 2, 3, 4, 5, 6, 7])).toBe('Any price');
    expect(whereText(buckets, [4, 3])).toBe('$62,500 to $63,500');
    expect(whereText(buckets, [])).toBe('');
    expect(whereText(buckets, [99])).toBe('');
  });

  it('names where a range’s best and worst results happen', () => {
    const s = must(ladder, [0, 0, 0, 10, 10, 0, 0, 0]);
    expect(whereText(buckets, s.best.bars)).toBe('$62,500 to $63,500');
    expect(whereText(buckets, s.worst.bars)).toBe('Below $62,500, or $63,500 or more');
  });
});

describe('shapes to start from', () => {
  const levels = distributionOf(ladder)!.levels;

  it('snaps the market’s even-chance band to the two nearest levels', () => {
    // The band runs from about 62,658 to about 63,881 on this ladder.
    expect(bandLevels(levels)).toEqual([2, 5]);
  });

  it('"Stays put" pays between those levels and is a Range on them', () => {
    const p = presetShape('stays', levels);
    expect(p).toEqual([0, 0, 0, 10, 10, 10, 0, 0]);
    expect(must(ladder, p).handover).toEqual({ kind: 'range', low: { symbol: 'S62500', strike: 62500 }, high: { symbol: 'S64000', strike: 64000 } });
  });

  it('"Big move" pays outside them and is a Breakout on the same two', () => {
    const p = presetShape('moves', levels);
    expect(p).toEqual([10, 10, 10, 0, 0, 0, 10, 10]);
    expect(must(ladder, p).handover).toEqual({ kind: 'breakout', low: { symbol: 'S62500', strike: 62500 }, high: { symbol: 'S64000', strike: 64000 } });
  });

  it('"Higher" and "Lower" pay in the top and bottom third of the bars, each with one order', () => {
    expect(presetShape('higher', levels)).toEqual([0, 0, 0, 0, 0, 10, 10, 10]);
    expect(presetShape('lower', levels)).toEqual([10, 10, 10, 0, 0, 0, 0, 0]);
    expect(must(ladder, presetShape('higher', levels)).orders).toHaveLength(1);
    expect(must(ladder, presetShape('lower', levels)).orders).toHaveLength(1);
    // Nine bars, as on the demo ladders: three at each end.
    const nine = distributionOf([...ladder, rung(65000, 0.02, 0.04)])!.levels;
    expect(presetShape('higher', nine)).toEqual([0, 0, 0, 0, 0, 0, 10, 10, 10]);
    expect(presetShape('lower', nine)).toEqual([10, 10, 10, 0, 0, 0, 0, 0, 0]);
  });

  it('"Clear" pays nothing anywhere', () => {
    expect(presetShape('clear', levels)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(must(ladder, presetShape('clear', levels)).flat).toBe(true);
  });

  it('pays the amount asked for, and the usual one when none is given', () => {
    expect(PRESET_PAY).toBe(10);
    expect(presetShape('stays', levels, 4)).toEqual([0, 0, 0, 4, 4, 4, 0, 0]);
    expect(PRESETS.map((p) => p.name)).toEqual(['Stays put', 'Big move', 'Higher', 'Lower', 'Clear']);
  });

  it('still finds two levels on a ladder that has no even-chance band, by the levels’ own chances', () => {
    // Never reaches 75%: the nearest chances to 75% and 25% are the first level and the third.
    const low = distributionOf([rung(10, 0.59, 0.61), rung(20, 0.44, 0.46), rung(30, 0.29, 0.31), rung(40, 0.09, 0.11)])!.levels;
    expect(bandLevels(low)).toEqual([0, 2]);
    expect(presetShape('stays', low)).toEqual([0, 10, 10, 0, 0]);
    expect(presetShape('moves', low)).toEqual([10, 0, 0, 10, 10]);
  });

  it('always lights at least one bar, and never the same level twice, on the smallest and the most lopsided ladders', () => {
    const two = distributionOf([rung(10, 0.5, 0.52), rung(20, 0.48, 0.5)])!.levels;
    expect(bandLevels(two)).toEqual([0, 1]);
    expect(presetShape('stays', two)).toEqual([0, 10, 0]);
    expect(presetShape('higher', two)).toEqual([0, 0, 10]);
    // Every level far above an even chance: both ends of the band snap to the last level, and the band is widened downwards.
    const high = distributionOf([rung(10, 0.97, 0.99), rung(20, 0.95, 0.97), rung(30, 0.93, 0.95)])!.levels;
    const [lo, hi] = bandLevels(high);
    expect(hi).toBeGreaterThan(lo);
    expect(presetShape('stays', high).filter((x) => x > 0).length).toBeGreaterThan(0);
  });

  it('gives every preset one amount per bar on random ladders, each a shape the library can price', () => {
    const rand = seeded(7);
    for (let run = 0; run < 200; run++) {
      const rungs = randomLadder(rand);
      const dist = distributionOf(rungs)!;
      const [lo, hi] = bandLevels(dist.levels);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThan(dist.levels.length);
      expect(hi).toBeGreaterThan(lo);
      for (const { id } of PRESETS) {
        const p = presetShape(id, dist.levels);
        expect(p).toHaveLength(dist.buckets.length);
        const s = must(rungs, p);
        expect(numbers(s).every(Number.isFinite)).toBe(true);
        if (id === 'stays') expect(s.handover.kind).toBe('range');
        if (id === 'moves') expect(s.handover.kind).toBe('breakout');
        if (id === 'higher' || id === 'lower') expect(s.handover.kind).toBe('single');
        if (id === 'clear') expect(s.handover.kind).toBe('none');
      }
    }
  });
});
