import type { MarketEvent, Rung } from '../api/types';

/** A sensible starting pair: a condition that is likely (so the refund is real) and a target with a fair chance. */
export function defaultPair(ev: MarketEvent): { c: string; t: string } | null {
  const ok = ev.pairs.filter((p) => p.quote.offerable && p.quote.chanceBothHappen !== null);
  if (ok.length === 0) {
    // Nothing is on offer right now (a closed or brand-new ladder). Still start somewhere sensible: a likely condition and a
    // target above it with a fair chance, taken from whatever two-sided prices exist, not the two lowest rungs, which on a real
    // ladder are both near-certain and show a price of almost a dollar.
    const r = [...ev.rungs].filter((x) => x.bid !== null && x.ask !== null).sort((a, b) => a.strike - b.strike);
    const mid = (x: Rung) => ((x.bid ?? 0) + (x.ask ?? 0)) / 2;
    const closest = (pool: Rung[], want: number) => pool.reduce<Rung | null>((best, x) => (best === null || Math.abs(mid(x) - want) < Math.abs(mid(best) - want) ? x : best), null);
    const c = closest(r.slice(0, -1), 0.74);
    const t = c ? closest(r.filter((x) => x.strike > c.strike), 0.36) : null;
    if (c && t) return { c: c.symbol, t: t.symbol };
    const all = [...ev.rungs].sort((a, b) => a.strike - b.strike);
    return all.length >= 2 ? { c: all[0]!.symbol, t: all[1]!.symbol } : null;
  }
  const score = (p: (typeof ok)[number]) => Math.abs((p.quote.chanceCondition ?? 0) - 0.74) + Math.abs((p.quote.chanceBothHappen ?? 0) - 0.36);
  ok.sort((a, b) => score(a) - score(b));
  const best = ok[0]!;
  return { c: best.condition.symbol, t: best.target.symbol };
}
