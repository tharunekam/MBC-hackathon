import { describe, expect, it } from 'vitest';
import type { MarketEvent, Pair, Rung } from '../api/types';
import { defaultPair } from './defaultPair';

const rung = (strike: number, mid: number, open = true): Rung => ({
  symbol: `S${strike}`,
  label: `$${strike}`,
  strike,
  bid: Math.max(0.01, mid - 0.01),
  ask: Math.min(0.99, mid + 0.01),
  open,
  state: open ? 'active/open' : 'settled',
});

const ladder = (mids: number[], open = true): Rung[] => mids.map((m, i) => rung(61500 + i * 500, m, open));
const event = (rungs: Rung[], pairs: Pair[] = []): MarketEvent => ({
  ticker: 'E',
  title: 'E',
  expiry: null,
  rungs,
  ladderOutOfOrder: false,
  pairs,
  offerableCount: pairs.length,
  refusedCount: 0,
  refusedByReason: {},
  down: { pairs: [], offerableCount: 0, refusedCount: 0 },
});

describe('the pair the builder starts on', () => {
  const mids = [0.97, 0.95, 0.85, 0.62, 0.38, 0.17, 0.06, 0.02];

  it('with nothing on offer (a closed ladder) it does not start on the two near-certain bottom rungs', () => {
    const ev = event(ladder(mids, false));
    const p = defaultPair(ev)!;
    const c = ev.rungs.find((r) => r.symbol === p.c)!;
    const t = ev.rungs.find((r) => r.symbol === p.t)!;
    expect(t.strike).toBeGreaterThan(c.strike);
    expect((c.bid! + c.ask!) / 2).toBeLessThan(0.9);
    expect((t.bid! + t.ask!) / 2).toBeLessThan((c.bid! + c.ask!) / 2);
    expect(p).not.toEqual({ c: 'S61500', t: 'S62000' });
  });

  it('prefers an offerable pair near a likely condition and a fair-chance target', () => {
    const rungs = ladder(mids);
    const mk = (a: number, b: number): Pair =>
      ({ condition: rungs[a]!, target: rungs[b]!, quote: { offerable: true, chanceCondition: mids[a]!, chanceBothHappen: mids[b]! } }) as unknown as Pair;
    const ev = event(rungs, [mk(0, 1), mk(2, 4), mk(5, 6)]);
    expect(defaultPair(ev)).toEqual({ c: 'S62500', t: 'S63500' });
  });

  it('copes with a ladder of fewer than two usable rungs', () => {
    expect(defaultPair(event([rung(61500, 0.5)]))).toBeNull();
    expect(defaultPair(event([]))).toBeNull();
  });
});

describe('the pair a falling parlay starts on', () => {
  const mids = [0.97, 0.95, 0.85, 0.62, 0.38, 0.17, 0.06, 0.02];

  it('puts the condition on the higher strike and the target on the lower one', () => {
    const ev = event(ladder(mids));
    const p = defaultPair(ev, 'down')!;
    const c = ev.rungs.find((r) => r.symbol === p.c)!;
    const t = ev.rungs.find((r) => r.symbol === p.t)!;
    expect(c.strike).toBeGreaterThan(t.strike);
    // a likely condition from the falling side: a high strike that the price is likely to stay under
    expect((c.bid! + c.ask!) / 2).toBeLessThan(0.4);
    expect((t.bid! + t.ask!) / 2).toBeGreaterThan((c.bid! + c.ask!) / 2);
  });

  it('prefers an offerable falling pair when there is one', () => {
    const rungs = ladder(mids);
    const pair = { condition: rungs[5]!, target: rungs[3]!, quote: { offerable: true, chanceCondition: 0.83, chanceBothHappen: 0.38 } } as unknown as Pair;
    const ev = { ...event(rungs), down: { pairs: [pair], offerableCount: 1, refusedCount: 0 } };
    expect(defaultPair(ev, 'down')).toEqual({ c: 'S64000', t: 'S63000' });
  });

  it('starts from the rungs alone when the session predates falling pairs', () => {
    const ev = { ...event(ladder(mids)), down: undefined };
    const p = defaultPair(ev, 'down')!;
    const c = ev.rungs.find((r) => r.symbol === p.c)!;
    const t = ev.rungs.find((r) => r.symbol === p.t)!;
    expect(c.strike).toBeGreaterThan(t.strike);
  });

  it('is not disturbed by the rising pairs', () => {
    const rungs = ladder(mids);
    const up = { condition: rungs[2]!, target: rungs[4]!, quote: { offerable: true, chanceCondition: 0.85, chanceBothHappen: 0.38 } } as unknown as Pair;
    expect(defaultPair({ ...event(rungs, [up]) }, 'up')).toEqual({ c: 'S62500', t: 'S63500' });
  });
});
