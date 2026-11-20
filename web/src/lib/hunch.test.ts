import { describe, expect, it } from 'vitest';
import type { MarketEvent, OfferQuote, Pair, Rung } from '../api/types';
import { distributionOf, marketView, viewOf, type Chance } from './distribution';
import { builderLink, ideasOn, rank, score, type Idea } from './hunch';
import { estimate, mirrorBook } from './pricing';

const rung = (strike: number, chance: number, open = true, spread = 0.01): Rung => ({
  symbol: `S${strike}`,
  label: `$${strike}`,
  strike,
  bid: chance - spread,
  ask: chance + spread,
  open,
  state: open ? 'active/open' : 'active/post_only',
});

const ladder = [rung(61500, 0.97), rung(62000, 0.92), rung(62500, 0.82), rung(63000, 0.62), rung(63500, 0.41), rung(64000, 0.2), rung(64500, 0.08)];

/** The offer the exchange would list for a pair, built with the page's own port of the executor's rule. */
function pairOf(c: Rung, t: Rung, direction: 'up' | 'down'): Pair {
  const see = (r: Rung) => (direction === 'down' ? { ...r, ...mirrorBook(r) } : r);
  const e = estimate(see(c), see(t), 0);
  const quote: OfferQuote = {
    verdict: e?.verdict ?? 'refuse',
    reasons: [],
    warnings: [],
    offerable: !!e && e.verdict !== 'refuse',
    overridden: false,
    chanceCondition: e?.chanceCondition ?? null,
    chanceBothHappen: e?.chanceBothHappen ?? null,
    fairPrice: e?.fairPrice ?? null,
    pricePaid: e?.pricePaid ?? null,
    allInPrice: e?.allIn ?? null,
    markup: e?.markup ?? null,
    markupPct: e?.markupPct ?? null,
    cashOutPer100: e?.cashOutPer100 ?? null,
    cashOutPer100AtProductionFees: null,
    feeCoefCharged: 0,
  };
  const leg = (r: Rung) => ({ symbol: r.symbol, label: r.label, strike: r.strike, bid: r.bid, ask: r.ask });
  return { condition: leg(c), target: leg(t), quote };
}

function event(rungs: Rung[]): MarketEvent {
  const up: Pair[] = [];
  const down: Pair[] = [];
  for (let i = 0; i < rungs.length; i++)
    for (let j = i + 1; j < rungs.length; j++) {
      up.push(pairOf(rungs[i]!, rungs[j]!, 'up'));
      down.push(pairOf(rungs[j]!, rungs[i]!, 'down'));
    }
  return { ticker: 'BTC1', title: 'Bitcoin price today at 9pm?', expiry: null, rungs, ladderOutOfOrder: false, pairs: up, offerableCount: 0, refusedCount: 0, refusedByReason: {}, down: { pairs: down, offerableCount: 0, refusedCount: 0 } };
}

const ev = event(ladder);
const ideas = ideasOn(ev, 0);

describe('the bets a ladder has on offer', () => {
  it('lists rising parlays, falling parlays and ranges, and nothing the offer rule refuses', () => {
    const kinds = new Set(ideas.map((i) => (i.product === 'range' ? 'range' : i.direction)));
    expect(kinds).toEqual(new Set(['up', 'down', 'range']));
    const refused = ev.pairs.filter((p) => !p.quote.offerable).length;
    expect(refused).toBeGreaterThan(0);
    expect(ideas.filter((i) => i.product === 'parlay' && i.direction === 'up')).toHaveLength(ev.pairs.length - refused);
  });

  it('orders a falling parlay the way the exchange lists it: condition above target', () => {
    for (const i of ideas) if (i.product === 'parlay' && i.direction === 'down') expect(i.condition.strike).toBeGreaterThan(i.target.strike);
  });

  it('leaves ranges out on rungs that are not open', () => {
    const closed = event(ladder.map((r) => ({ ...r, open: false, state: 'active/post_only' })));
    expect(ideasOn(closed, 0).some((i) => i.product === 'range')).toBe(false);
  });
});

const { levels } = distributionOf(ladder)!;
const base = marketView(levels);
/** A plain bell-free stand-in for a view: certain below 62,000, impossible above 65,000, a straight line between. */
const ramp: Chance = (k) => Math.min(1, Math.max(0, (65000 - k) / 3000));

describe('on a venue that waives the markup rule (the sandbox demo)', () => {
  // Books 20¢ wide, as the sandbox's are: the rule refuses every pair for its markup.
  const wide = ladder.map((r) => ({ ...r, bid: r.bid! - 0.09, ask: r.ask! + 0.09 })).filter((r) => r.bid > 0.02 && r.ask < 0.98);
  const strict = event(wide);
  const waived: MarketEvent = {
    ...strict,
    pairs: strict.pairs.map((p) => (p.quote.pricePaid !== null && p.quote.allInPrice !== null && p.quote.allInPrice < 0.95 ? { ...p, quote: { ...p.quote, offerable: true, overridden: true } } : p)),
  };

  it('lists nothing where the rule stands', () => {
    expect(ideasOn(strict, 0)).toEqual([]);
  });

  it('lists what the venue lets through, parlays and ranges, each marked as waived and at its real price', () => {
    const got = ideasOn(waived, 0);
    expect(got.some((i) => i.product === 'parlay')).toBe(true);
    expect(got.some((i) => i.product === 'range')).toBe(true);
    for (const i of got) {
      expect(i.waived).toBe(true);
      expect(i.pricePaid).toBeGreaterThan(i.fairPrice);
    }
  });
});

describe('a bet valued under a view', () => {
  const up: Idea = { product: 'parlay', direction: 'up', condition: { symbol: 'A', strike: 62500 }, target: { symbol: 'B', strike: 63500 }, pricePaid: 0.5, fairPrice: 0.5, warn: false, waived: false };

  it('is worth the chance of the target once the condition holds, and its three chances add up to 1', () => {
    const s = score(up, ramp)!;
    const holds = ramp(62500);
    const hits = ramp(63500);
    expect(hits).toBeCloseTo(0.5, 10);
    expect(s.worth).toBeCloseTo(hits / holds, 10);
    expect(s.edge).toBeCloseTo(hits / holds - 0.5, 10);
    expect(s.win + s.back + s.lose).toBeCloseTo(1, 10);
    expect(s.back).toBeCloseTo(1 - holds, 10);
  });

  it('expects nothing from a bet priced at exactly what the view thinks it is worth', () => {
    const worth = ramp(63500) / ramp(62500);
    expect(score({ ...up, pricePaid: worth }, ramp)!.expectedPer100).toBeCloseTo(0, 10);
  });

  it('works the expected result from the three outcomes of a $100 bet', () => {
    const s = score(up, ramp)!;
    const byHand = s.win * (100 / up.pricePaid - 100) + s.back * 0 + s.lose * -100;
    expect(s.expectedPer100).toBeCloseTo(byHand, 10);
  });

  it('values a falling parlay from the other side of the same prices', () => {
    const down: Idea = { product: 'parlay', direction: 'down', condition: { symbol: 'B', strike: 63500 }, target: { symbol: 'A', strike: 62500 }, pricePaid: 0.4, fairPrice: 0.4, warn: false, waived: false };
    const s = score(down, ramp)!;
    expect(s.win).toBeCloseTo(1 - ramp(62500), 10);
    expect(s.back).toBeCloseTo(ramp(63500), 10);
    expect(s.worth).toBeCloseTo(s.win / (1 - s.back), 10);
  });

  it('values a range by the chance of finishing inside, on a pair that costs $1 more than its price', () => {
    const range: Idea = { product: 'range', low: { symbol: 'A', strike: 62500 }, high: { symbol: 'B', strike: 63500 }, pricePaid: 0.3, fairPrice: 0.33, warn: false, waived: false };
    const s = score(range, ramp)!;
    const inside = ramp(62500) - ramp(63500);
    expect(s.win).toBeCloseTo(inside, 10);
    expect(s.back).toBe(0);
    // 100 / 1.3 pairs: each nets 70¢ inside and loses 30¢ outside
    expect(s.expectedPer100).toBeCloseTo((100 / 1.3) * (inside * 0.7 - (1 - inside) * 0.3), 10);
  });

  it('has nothing to say about a parlay whose condition the view rules out', () => {
    expect(score(up, () => 0)).toBeNull();
  });
});

describe('ranking a ladder for a view', () => {
  const moved = (by: number, squeeze = 1) => viewOf(levels, { center: base.center + by, spread: base.spread * squeeze });

  it('finds nothing for a view that has not been moved, because every bet costs a little over fair', () => {
    expect(rank(ideas, moved(0))).toEqual([]);
  });

  it('favours rising bets for a view above the market and falling bets for one below it', () => {
    const high = rank(ideas, moved(700));
    const low = rank(ideas, moved(-700));
    expect(high.length).toBeGreaterThan(0);
    expect(low.length).toBeGreaterThan(0);
    expect(high[0]!.idea.product === 'parlay' && high[0]!.idea.direction).toBe('up');
    expect(low[0]!.idea.product === 'parlay' && low[0]!.idea.direction).toBe('down');
  });

  it('lists a range around the centre for a view that is surer than the market', () => {
    const tight = rank(ideas, moved(0, 0.3), { limit: 6, perKind: 2 });
    expect(tight.some((s) => s.idea.product === 'range' && s.idea.low.strike <= base.center && s.idea.high.strike > base.center)).toBe(true);
  });

  it('lists only bets the view makes worth more than they cost, best first, and never more than asked', () => {
    const out = rank(ideas, moved(500), { limit: 4, perKind: 2 });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(4);
    for (const s of out) {
      expect(s.edge).toBeGreaterThan(0);
      expect(s.expectedPer100).toBeGreaterThan(0);
    }
    for (let i = 1; i < out.length; i++) expect(out[i - 1]!.expectedPer100).toBeGreaterThanOrEqual(out[i]!.expectedPer100);
    const perKind: Record<string, number> = {};
    for (const s of out) {
      const k = s.idea.product === 'range' ? 'range' : s.idea.direction;
      perKind[k] = (perKind[k] ?? 0) + 1;
    }
    expect(Math.max(...Object.values(perKind))).toBeLessThanOrEqual(2);
  });

  it('never lists two parlays to the same target, or two ranges that share an edge', () => {
    const out = rank(ideas, moved(600), { limit: 9, perKind: 3 });
    const targets = out.filter((s) => s.idea.product === 'parlay').map((s) => (s.idea.product === 'parlay' ? `${s.idea.direction}:${s.idea.target.strike}` : ''));
    expect(new Set(targets).size).toBe(targets.length);
    const ranges = out.flatMap((s) => (s.idea.product === 'range' ? [s.idea] : []));
    expect(new Set(ranges.map((r) => r.low.strike)).size).toBe(ranges.length);
    expect(new Set(ranges.map((r) => r.high.strike)).size).toBe(ranges.length);
  });
});

describe('opening a bet in its builder', () => {
  it('carries the ladder and both strikes', () => {
    expect(builderLink('BTC1', { product: 'parlay', direction: 'up', condition: { symbol: 'A', strike: 1 }, target: { symbol: 'B', strike: 2 }, pricePaid: 0.5, fairPrice: 0.5, warn: false, waived: false })).toBe('/parlay?market=BTC1&condition=A&target=B');
    expect(builderLink('BTC1', { product: 'parlay', direction: 'down', condition: { symbol: 'B', strike: 2 }, target: { symbol: 'A', strike: 1 }, pricePaid: 0.5, fairPrice: 0.5, warn: false, waived: false })).toBe('/parlay?market=BTC1&condition=B&target=A&direction=down');
    expect(builderLink('BTC1', { product: 'range', low: { symbol: 'A', strike: 1 }, high: { symbol: 'B', strike: 2 }, pricePaid: 0.5, fairPrice: 0.5, warn: false, waived: false })).toBe('/range?market=BTC1&low=A&high=B');
  });
});
