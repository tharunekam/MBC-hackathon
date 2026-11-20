import { describe, expect, it } from 'vitest';
import type { MarketEvent, OfferQuote, Pair, Rung } from '../api/types';
import { distributionOf, marketView, viewOf, type Chance } from './distribution';
import { builderLink, ideasOn, MIN_WIN, rank, score, winsOn, type Idea } from './hunch';
import { breakoutEstimate, estimate, mirrorBook } from './pricing';

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
  it('lists rising parlays, falling parlays, ranges and breakouts, and nothing the offer rule refuses', () => {
    const kinds = new Set(ideas.map((i) => (i.product === 'parlay' ? i.direction : i.product)));
    expect(kinds).toEqual(new Set(['up', 'down', 'range', 'breakout']));
    const refused = ev.pairs.filter((p) => !p.quote.offerable).length;
    expect(refused).toBeGreaterThan(0);
    expect(ideas.filter((i) => i.product === 'parlay' && i.direction === 'up')).toHaveLength(ev.pairs.length - refused);
  });

  it('orders a falling parlay the way the exchange lists it: condition above target', () => {
    for (const i of ideas) if (i.product === 'parlay' && i.direction === 'down') expect(i.condition.strike).toBeGreaterThan(i.target.strike);
  });

  it('leaves ranges and breakouts out on rungs that are not open', () => {
    const closed = event(ladder.map((r) => ({ ...r, open: false, state: 'active/post_only' })));
    expect(ideasOn(closed, 0).some((i) => i.product !== 'parlay')).toBe(false);
  });

  it('lists a breakout only for two levels the offer rule would take, lower strike first, at the price the pair costs', () => {
    const breakouts = ideas.flatMap((i) => (i.product === 'breakout' ? [i] : []));
    expect(breakouts.length).toBeGreaterThan(0);
    for (const b of breakouts) {
      expect(b.low.strike).toBeLessThan(b.high.strike);
      const lo = ladder.find((r) => r.strike === b.low.strike)!;
      const hi = ladder.find((r) => r.strike === b.high.strike)!;
      const e = breakoutEstimate(lo, hi, 0)!;
      expect(e.verdict).not.toBe('refuse');
      expect(b.pricePaid).toBeCloseTo(1 - lo.bid! + hi.ask!, 8);
      expect(b.fairPrice).toBeCloseTo(e.chanceOutside, 8);
    }
    // Two neighbouring rungs near the bottom of the ladder: finishing outside them is all but sure, so it is not listed.
    expect(breakouts.some((b) => b.low.strike === 61500 && b.high.strike === 62000)).toBe(false);
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

  it('lists what the venue lets through, parlays, ranges and breakouts, each marked as waived and at its real price', () => {
    const got = ideasOn(waived, 0);
    expect(got.some((i) => i.product === 'parlay')).toBe(true);
    expect(got.some((i) => i.product === 'range')).toBe(true);
    expect(got.some((i) => i.product === 'breakout')).toBe(true);
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

  it('is worth exactly its price when it is priced at what the view thinks, so there is no difference to show', () => {
    const worth = ramp(63500) / ramp(62500);
    const s = score({ ...up, pricePaid: worth }, ramp)!;
    expect(s.edge).toBeCloseTo(0, 10);
    expect(s.edgeCents).toBe(0);
  });

  it('shows a difference that is the two rounded figures taken apart, never a third rounding of its own', () => {
    // Worth 36.4¢ and a price of 17.6¢ differ by 18.8¢: "36¢, 18¢, +19¢" would not add up on screen.
    const worth: Chance = (k) => (k >= 63500 ? 0.364 : 1);
    const s = score({ ...up, pricePaid: 0.176 }, worth)!;
    expect(s.worth).toBeCloseTo(0.364, 10);
    expect([s.worthCents, s.priceCents, s.edgeCents]).toEqual([36, 18, 18]);
    expect(s.edgeCents).toBe(s.worthCents - s.priceCents);
    expect(Math.round(s.edge * 100)).toBe(19);
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
    expect(s.win + s.lose).toBeCloseTo(1, 10);
    expect(s.edge).toBeCloseTo(inside - 0.3, 10);
  });

  it('values a breakout by the chance of finishing outside, on a pair that costs exactly its price', () => {
    const breakout: Idea = { product: 'breakout', low: { symbol: 'A', strike: 62500 }, high: { symbol: 'B', strike: 63500 }, pricePaid: 0.55, fairPrice: 0.6, warn: false, waived: false };
    const s = score(breakout, ramp)!;
    const outside = 1 - (ramp(62500) - ramp(63500));
    expect(s.win).toBeCloseTo(outside, 10);
    expect(s.worth).toBeCloseTo(outside, 10);
    expect(s.edge).toBeCloseTo(outside - 0.55, 10);
    expect(s.back).toBe(0);
    expect(s.win + s.lose).toBeCloseTo(1, 10);
    expect(score({ ...breakout, pricePaid: outside }, ramp)!.edge).toBeCloseTo(0, 10);
  });

  it('a range and a breakout on the same two levels are never both worth more than they cost', () => {
    const lo = ladder.find((r) => r.strike === 62500)!;
    const hi = ladder.find((r) => r.strike === 63500)!;
    const range = ideas.find((i) => i.product === 'range' && i.low.strike === lo.strike && i.high.strike === hi.strike)!;
    const breakout = ideas.find((i) => i.product === 'breakout' && i.low.strike === lo.strike && i.high.strike === hi.strike)!;
    for (const view of [ramp, viewOf(levels, { center: base.center, spread: base.spread * 3 }), viewOf(levels, { center: base.center, spread: base.spread / 3 })]) {
      const [r, b] = [score(range, view)!, score(breakout, view)!];
      expect(r.win + b.win).toBeCloseTo(1, 10);
      expect(r.edge > 0 && b.edge > 0).toBe(false);
    }
  });

  it('has nothing to say about a parlay whose first level the view rules out', () => {
    expect(score(up, () => 0)).toBeNull();
  });
});

describe('what a stake wins at the price', () => {
  it('is a fact about the price: the same sum for any view', () => {
    const parlay: Idea = { product: 'parlay', direction: 'up', condition: { symbol: 'A', strike: 62500 }, target: { symbol: 'B', strike: 63500 }, pricePaid: 0.4, fairPrice: 0.4, warn: false, waived: false };
    // $10 at 40¢ buys 25 contracts that pay $1 each: $25 back, $15 more than was staked.
    expect(winsOn(parlay, 10)).toBeCloseTo(15, 8);
    // A range's pair costs $1 more than its price: $10 buys 7.69 pairs at $1.30, and inside the range each pays $2.
    const range: Idea = { product: 'range', low: { symbol: 'A', strike: 62500 }, high: { symbol: 'B', strike: 63500 }, pricePaid: 0.3, fairPrice: 0.33, warn: false, waived: false };
    expect(winsOn(range, 10)).toBeCloseTo(2 * 7.69 - 7.69 * 1.3, 8);
    // A breakout's pair costs its price: $10 buys 18.18 pairs at 55¢, and outside the two levels each pays $1.
    const breakout: Idea = { product: 'breakout', low: { symbol: 'A', strike: 62500 }, high: { symbol: 'B', strike: 63500 }, pricePaid: 0.55, fairPrice: 0.6, warn: false, waived: false };
    expect(winsOn(breakout, 10)).toBeCloseTo(18.18 - 18.18 * 0.55, 8);
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

  it('lists a breakout around the centre for a view that is less sure than the market: the point of a bet on a move', () => {
    const wide = rank(ideas, moved(0, 2.5), { limit: 6, perKind: 2 });
    const breakouts = wide.flatMap((s) => (s.idea.product === 'breakout' ? [s] : []));
    expect(breakouts.length).toBeGreaterThan(0);
    expect(breakouts.some((s) => s.idea.product === 'breakout' && s.idea.low.strike <= base.center && s.idea.high.strike > base.center)).toBe(true);
    for (const s of breakouts) {
      expect(s.edge).toBeGreaterThan(0);
      expect(s.edgeCents).toBeGreaterThanOrEqual(1);
    }
    // The same view finds no range worth its price: it thinks the price is less likely to stay put than the market does.
    expect(wide.some((s) => s.idea.product === 'range' && s.idea.low.strike <= base.center && s.idea.high.strike > base.center)).toBe(false);
  });

  it('and lists no breakout around the centre for a view that is surer than the market', () => {
    const tight = rank(ideas, moved(0, 0.3), { limit: 12, perKind: 4 });
    expect(tight.some((s) => s.idea.product === 'breakout' && s.idea.low.strike <= base.center && s.idea.high.strike > base.center)).toBe(false);
  });

  it('lists only bets the view makes worth more than they cost, best first, and never more than asked', () => {
    const out = rank(ideas, moved(500), { limit: 4, perKind: 2 });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(4);
    for (const s of out) {
      expect(s.edge).toBeGreaterThan(0);
      expect(s.edgeCents).toBeGreaterThanOrEqual(1);
    }
    // Best first by the difference per $1, not by the return on the stake (which put long shots on top).
    for (let i = 1; i < out.length; i++) expect(out[i - 1]!.edge).toBeGreaterThanOrEqual(out[i]!.edge);
    const perKind: Record<string, number> = {};
    for (const s of out) {
      const k = s.idea.product === 'parlay' ? s.idea.direction : s.idea.product;
      perKind[k] = (perKind[k] ?? 0) + 1;
    }
    expect(Math.max(...Object.values(perKind))).toBeLessThanOrEqual(2);
  });

  it('counts breakouts as a kind of their own, and never lists two that share an edge', () => {
    const out = rank(ideas, moved(0, 3), { limit: 12, perKind: 3 });
    const breakouts = out.flatMap((s) => (s.idea.product === 'breakout' ? [s.idea] : []));
    expect(breakouts.length).toBeGreaterThan(1);
    expect(breakouts.length).toBeLessThanOrEqual(3);
    expect(new Set(breakouts.map((b) => b.low.strike)).size).toBe(breakouts.length);
    expect(new Set(breakouts.map((b) => b.high.strike)).size).toBe(breakouts.length);
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

describe('long shots', () => {
  const moved = (by: number, squeeze = 1) => viewOf(levels, { center: base.center + by, spread: base.spread * squeeze });
  const parlay = (target: number, pricePaid: number): Idea => ({ product: 'parlay', direction: 'up', condition: { symbol: 'A', strike: 61500 }, target: { symbol: `T${target}`, strike: target }, pricePaid, fairPrice: pricePaid, warn: false, waived: false });

  it('are not listed while a bet that wins reasonably often under the view is on offer, however good their odds look', () => {
    // A view a little above the market. Both bets are worth more than they cost: the long shot doubles its money on paper.
    const view = moved(120);
    const longShot = parlay(64500, 0.02);
    const likely = parlay(63000, 0.55);
    const [a, b] = [score(longShot, view)!, score(likely, view)!];
    expect(a.win).toBeLessThan(MIN_WIN);
    expect(b.win).toBeGreaterThan(MIN_WIN);
    expect(a.edge).toBeGreaterThan(0.01);
    expect(b.edge).toBeGreaterThan(0.01);
    expect(rank([longShot, likely], view).map((s) => s.idea)).toEqual([likely]);
  });

  it('every bet listed for a small nudge wins at least one time in five under the view', () => {
    for (const by of [120, -120, 250, -250, 460, -460]) {
      const out = rank(ideas, moved(by));
      expect(out.length).toBeGreaterThan(0);
      for (const s of out) expect(s.win).toBeGreaterThanOrEqual(MIN_WIN);
    }
  });

  it('are listed, best first, only when nothing likelier is worth its price', () => {
    const view = moved(120);
    const a = parlay(64500, 0.02);
    const b: Idea = { product: 'range', low: { symbol: 'L', strike: 64000 }, high: { symbol: 'H', strike: 64500 }, pricePaid: 0.05, fairPrice: 0.12, warn: false, waived: false };
    const out = rank([a, b], view);
    expect(out).toHaveLength(2);
    for (const s of out) expect(s.win).toBeLessThan(MIN_WIN);
    expect(out[0]!.edge).toBeGreaterThanOrEqual(out[1]!.edge);
    // With a likelier bet on offer the same two are left out.
    expect(rank([a, b, parlay(63000, 0.55)], view).map((s) => s.win >= MIN_WIN)).toEqual([true]);
  });

  it('a difference too small to matter, or too small to show as a cent, is not listed at all', () => {
    const view = moved(120);
    const worth = score(parlay(63000, 0.55), view)!.worth;
    // A fifth of a cent of difference, even where the two figures happen to round a cent apart.
    const barely = score(parlay(63000, worth - 0.002), view)!;
    expect(barely.edge).toBeGreaterThan(0);
    expect(rank([barely.idea], view)).toEqual([]);
    // Over half a cent of difference whose two figures round to the same cent would read "+0¢".
    const flat: Idea = { product: 'breakout', low: { symbol: 'L', strike: 62500 }, high: { symbol: 'H', strike: 63500 }, pricePaid: 0.679, fairPrice: 0.679, warn: false, waived: false };
    const outside: Chance = (k) => (k >= 63500 ? 0.3 : 0.6151); // 68.49% outside the two levels
    const unseen = score(flat, outside)!;
    expect(unseen.edge).toBeGreaterThan(0.005);
    expect([unseen.worthCents, unseen.priceCents, unseen.edgeCents]).toEqual([68, 68, 0]);
    expect(rank([flat], outside)).toEqual([]);
  });
});

describe('opening a bet in its builder', () => {
  it('carries the ladder and both strikes', () => {
    expect(builderLink('BTC1', { product: 'parlay', direction: 'up', condition: { symbol: 'A', strike: 1 }, target: { symbol: 'B', strike: 2 }, pricePaid: 0.5, fairPrice: 0.5, warn: false, waived: false })).toBe('/parlay?market=BTC1&condition=A&target=B');
    expect(builderLink('BTC1', { product: 'parlay', direction: 'down', condition: { symbol: 'B', strike: 2 }, target: { symbol: 'A', strike: 1 }, pricePaid: 0.5, fairPrice: 0.5, warn: false, waived: false })).toBe('/parlay?market=BTC1&condition=B&target=A&direction=down');
    expect(builderLink('BTC1', { product: 'range', low: { symbol: 'A', strike: 1 }, high: { symbol: 'B', strike: 2 }, pricePaid: 0.5, fairPrice: 0.5, warn: false, waived: false })).toBe('/range?market=BTC1&low=A&high=B');
  });

  it('opens a breakout on the Range page, on its other side', () => {
    expect(builderLink('BTC1', { product: 'breakout', low: { symbol: 'A', strike: 1 }, high: { symbol: 'B', strike: 2 }, pricePaid: 0.5, fairPrice: 0.5, warn: false, waived: false })).toBe('/range?market=BTC1&low=A&high=B&side=out');
  });
});
