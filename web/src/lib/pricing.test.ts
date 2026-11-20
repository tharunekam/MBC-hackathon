import { describe, expect, it } from 'vitest';
import { allInPrice, cashOutPer100, estimate, mirrorBook, outcomesFor, rangeEstimate, rangeOutcomesFor, rangePrice, rangeUnitCost } from './pricing';

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

describe('the mirror a falling bet is priced on', () => {
  it('flips a book: what a NO buyer pays is what a YES seller receives', () => {
    expect(mirrorBook({ bid: 0.8, ask: 0.82 })).toEqual({ bid: 0.18, ask: 0.2 });
    expect(mirrorBook({ bid: null, ask: 0.5 })).toEqual({ bid: 0.5, ask: null });
    expect(mirrorBook(mirrorBook({ bid: 0.8, ask: 0.82 }))).toEqual({ bid: 0.8, ask: 0.82 });
  });
});
