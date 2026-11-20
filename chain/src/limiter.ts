/**
 * A per-client rate limiter that cannot grow without bound: clients with no recent hits are swept, so a flood of
 * distinct addresses (or a long-lived server) does not leak memory.
 */
export interface RateLimit {
  max: number;
  windowMs: number;
}

export function createLimiter(rate: RateLimit | undefined, now: () => number) {
  const hits = new Map<string, number[]>();
  let lastSweep = 0;

  const sweep = (t: number) => {
    lastSweep = t;
    for (const [who, times] of hits) {
      if (times.length === 0 || t - times[times.length - 1]! >= rate!.windowMs) hits.delete(who);
    }
  };

  return {
    /** True when this client is over the limit. Counts the request otherwise. */
    limited(who: string): boolean {
      if (!rate) return false;
      const t = now();
      if (t - lastSweep >= rate.windowMs) sweep(t);
      const recent = (hits.get(who) ?? []).filter((x) => t - x < rate.windowMs);
      if (recent.length >= rate.max) {
        hits.set(who, recent);
        return true;
      }
      recent.push(t);
      hits.set(who, recent);
      return false;
    },
    /** Clients currently tracked (for tests and metrics). */
    size: (): number => hits.size,
  };
}
