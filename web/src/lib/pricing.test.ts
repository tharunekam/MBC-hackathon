import { describe, expect, it } from 'vitest';
import { allInPrice, breakoutEstimate, breakoutOutcomesFor, breakoutPrice, breakoutUnitCost, cashOutPer100, estimate, feeRate, mirrorBook, outcomesFor, rangeEstimate, rangeOutcomesFor, rangePrice, rangeUnitCost } from './pricing';

// The worked example in executor/README.md (also executor/test/offer.test.ts):
// condition 0.80 / 0.84, outcome 0.40 / 0.42.
const cond = { bid: 0.8, ask: 0.84 };
const target = { bid: 0.4, ask: 0.42 };

describe('estimate matches the executor worked example', () => {
  it('fair price is 0.50', () => {
    expect(estimate(cond, target, 0)?.fairPrice).toBeCloseTo(0.5, 6);
  });
  it('price paid with no fees is 0.525', () => {
    expect(estimate(cond, target, 0)?.pricePaid).toBeCloseTo(0.525, 6);
  });
  it('all-in at production fees is about 0.554, a 5.4 cent / 10.8% markup, verdict warn', () => {
    const e = estimate(cond, target, 0)!;
    expect(e.allIn).toBeCloseTo(0.437052 / 0.7888, 6);
    expect(e.markup).toBeCloseTo(0.054, 3);
    expect(e.markupPct).toBeCloseTo(0.108, 3);
    expect(e.verdict).toBe('warn');
  });
  it('cash-out per $100 is 92.19 with no fees and 84.22 with production fees', () => {
    expect(cashOutPer100(0.525, 0.4, 0.84, 0)).toBe(92.19);
    expect(cashOutPer100(allInPrice(0.42, 0.8, 0.07)!, 0.4, 0.84, 0.07)).toBe(84.22);
  });
});

describe('refusals', () => {
  it('refuses when a side of a book is missing', () => {
    expect(estimate({ bid: null, ask: 0.5 }, target, 0)).toBeNull();
  });
  it('refuses a wide pair for markup', () => {
    const e = estimate({ bid: 0.6, ask: 0.8 }, { bid: 0.25, ask: 0.45 }, 0)!;
    expect(e.verdict).toBe('refuse');
    expect(e.refusal).toMatch(/spread/);
  });
  it('refuses when the all-in price reaches 0.95', () => {
    const e = estimate({ bid: 0.97, ask: 0.99 }, { bid: 0.93, ask: 0.96 }, 0)!;
    expect(e.verdict).toBe('refuse');
  });
});

describe('outcomesFor', () => {
  it('returns the stake if the condition fails and pays $1 per contract if both hit', () => {
    const o = outcomesFor(100, 0.5);
    expect(o.contracts).toBe(200);
    expect(o.ifBothHit).toBe(100);
    expect(o.ifConditionFails).toBe(0);
    expect(o.ifConditionOnly).toBe(-100);
  });
});

// Pinned to the worked example in executor/test/products.test.ts: lower strike 0.80 / 0.82, higher strike 0.40 / 0.42.
describe('a range matches the executor', () => {
  const low = { bid: 0.8, ask: 0.82 };
  const high = { bid: 0.4, ask: 0.42 };

  it('costs the second dollar: what the pair costs above the dollar that always comes back', () => {
    expect(rangePrice(0.82, 0.4, 0)).toBeCloseTo(0.42, 6);
    expect(rangeUnitCost(0.82, 0.4, 0)).toBeCloseTo(1.42, 6);
    expect(rangePrice(0.4, 0.8, 0)).toBeNull(); // a lower strike cheaper than a higher one is not a range
  });

  it('estimates the chance, the price, and the verdict at production fees', () => {
    const e = rangeEstimate(low, high, 0)!;
    expect(e.chanceInRange).toBeCloseTo(0.4, 6);
    expect(e.fairPrice).toBeCloseTo(0.4, 6);
    expect(e.pricePaid).toBeCloseTo(0.42, 6);
    expect(e.allIn).toBeCloseTo(0.82 + 0.07 * 0.82 * 0.18 + 0.6 + 0.07 * 0.6 * 0.4 - 1, 6);
    expect(e.verdict).toBe('ok');
    expect(e.unitCost).toBeCloseTo(1.42, 6);
  });

  it('refuses a wide pair of books for markup, and a missing side', () => {
    const wide = rangeEstimate({ bid: 0.83, ask: 0.97 }, { bid: 0.35, ask: 0.54 }, 0)!;
    expect(wide.verdict).toBe('refuse');
    expect(wide.code).toBe('markup_too_high');
    expect(rangeEstimate({ bid: null, ask: 0.8 }, high, 0)).toBeNull();
    expect(rangeEstimate(high, low, 0)).toBeNull(); // the floor cheaper than the ceiling: no chance of landing between
  });

  it('says what a stake buys: what comes back always, and what each result nets', () => {
    const o = rangeOutcomesFor(14.2, 1.42);
    expect(o.contracts).toBe(10);
    expect(o.cost).toBeCloseTo(14.2, 6);
    expect(o.backAlways).toBe(10);
    expect(o.ifInRange).toBeCloseTo(5.8, 6);
    expect(o.ifOutside).toBeCloseTo(-4.2, 6);
  });
});

// Pinned to the worked example in the README (also the executor's tests): lower strike 0.80 / 0.82, higher strike 0.40 / 0.42.
describe('a breakout matches the executor', () => {
  const low = { bid: 0.8, ask: 0.82 };
  const high = { bid: 0.4, ask: 0.42 };

  it('costs what the pair costs: a NO on the lower strike and a YES on the higher', () => {
    expect(breakoutUnitCost(0.8, 0.42, 0)).toBeCloseTo(0.62, 8);
    expect(breakoutPrice(0.8, 0.42, 0)).toBeCloseTo(0.62, 8);
    expect(breakoutUnitCost(0.8, 0.42, 0.07)).toBeCloseTo(0.648252, 8);
    expect(breakoutPrice(0.5, 0.52, 0)).toBeNull(); // a pair that costs a dollar or more for the dollar it can win
    expect(breakoutPrice(0, 0.42, 0)).toBeNull(); // nobody bidding on the lower strike: the NO has no price
  });

  it('estimates the chance, the price, and the verdict at production fees', () => {
    const e = breakoutEstimate(low, high, 0)!;
    expect(e.chanceOutside).toBeCloseTo(0.6, 8);
    expect(e.fairPrice).toBeCloseTo(0.6, 8);
    expect(e.pricePaid).toBeCloseTo(0.62, 8);
    expect(e.unitCost).toBeCloseTo(0.62, 8);
    expect(e.allIn).toBeCloseTo(0.648252, 8);
    expect(e.markup).toBeCloseTo(0.048252, 8);
    expect(e.markupPct).toBeCloseTo(0.048252 / 0.6, 6);
    expect(e.verdict).toBe('ok');
    expect(e.code).toBeNull();
    // Selling straight back: the NO at 1 - 0.82 and the YES at 0.40, on 100 / 0.62 pairs.
    expect(e.cashOutPer100).toBe(93.55);
  });

  it('charges the venue fee in the price paid and on the way back out', () => {
    const e = breakoutEstimate(low, high, 0.07)!;
    expect(e.pricePaid).toBeCloseTo(0.648252, 8);
    expect(e.allIn).toBeCloseTo(e.pricePaid, 8);
    const back = (100 / 0.648252) * (0.18 - feeRate(0.18, 0.07) + 0.4 - feeRate(0.4, 0.07));
    expect(e.cashOutPer100).toBeCloseTo(back, 2);
  });

  it('is the other side of the range on the same two levels', () => {
    const r = rangeEstimate(low, high, 0)!;
    const b = breakoutEstimate(low, high, 0)!;
    expect(r.chanceInRange + b.chanceOutside).toBeCloseTo(1, 8);
    // Buying both sides costs the dollar one of them pays, plus the two spreads.
    expect(r.pricePaid + b.pricePaid).toBeCloseTo(1 + (0.82 - 0.8) + (0.42 - 0.4), 8);
  });

  it('says what a stake buys: a dollar a contract outside the two levels, nothing between them', () => {
    const o = breakoutOutcomesFor(10, 0.62);
    expect(o.contracts).toBe(16.12);
    expect(o.cost.toFixed(2)).toBe('9.99');
    expect(o.ifOutside.toFixed(2)).toBe('6.13');
    expect(o.ifInRange.toFixed(2)).toBe('-9.99');
    expect(o.ifOutside - o.ifInRange).toBeCloseTo(o.contracts, 8);
  });

  it('refuses a near-certain breakout for its price and a wide pair of books for markup', () => {
    // Both levels far below where the price is: finishing outside them is all but sure.
    const sure = breakoutEstimate({ bid: 0.97, ask: 0.99 }, { bid: 0.93, ask: 0.95 }, 0)!;
    expect(sure.verdict).toBe('refuse');
    expect(sure.code).toBe('price_too_high');
    expect(sure.refusal).toMatch(/further apart/);
    const wide = breakoutEstimate({ bid: 0.7, ask: 0.9 }, { bid: 0.1, ask: 0.3 }, 0)!;
    expect(wide.verdict).toBe('refuse');
    expect(wide.code).toBe('markup_too_high');
  });

  it('warns when it costs a little over fair, by the same thresholds as every other bet', () => {
    const e = breakoutEstimate({ bid: 0.79, ask: 0.83 }, { bid: 0.17, ask: 0.21 }, 0)!;
    expect(e.markup).toBeGreaterThanOrEqual(0.05);
    expect(e.markup).toBeLessThanOrEqual(0.08);
    expect(e.verdict).toBe('warn');
  });

  it('has no price with a side missing, no chance between the levels, or a pair that costs a dollar', () => {
    expect(breakoutEstimate({ bid: null, ask: 0.8 }, high, 0)).toBeNull();
    expect(breakoutEstimate(high, low, 0)).toBeNull(); // the "lower" level less likely than the "higher": nothing in between
    expect(breakoutEstimate({ bid: 0.5, ask: 0.56 }, { bid: 0.46, ask: 0.52 }, 0)).toBeNull();
  });
});

describe('the mirror a falling bet is priced on', () => {
  it('flips a book: what a NO buyer pays is what a YES seller receives', () => {
    expect(mirrorBook({ bid: 0.8, ask: 0.82 })).toEqual({ bid: 0.18, ask: 0.2 });
    expect(mirrorBook({ bid: null, ask: 0.5 })).toEqual({ bid: 0.5, ask: null });
    expect(mirrorBook(mirrorBook({ bid: 0.8, ask: 0.82 }))).toEqual({ bid: 0.8, ask: 0.82 });
  });
});
