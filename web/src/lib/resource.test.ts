import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEP_MS, acquire, clearResources, createBackoff, createResource, resourceCount } from './resource';

/** A fetcher the test settles by hand. */
function manual<T>() {
  const calls: Array<{ resolve: (v: T) => void; reject: (e: Error) => void }> = [];
  const fetcher = () => new Promise<T>((resolve, reject) => calls.push({ resolve, reject }));
  return { fetcher, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('a resource', () => {
  it('starts empty and loading, and a first answer fills it', async () => {
    const m = manual<number>();
    const r = createResource(m.fetcher, () => 1000);
    expect(r.getState()).toMatchObject({ data: null, loading: true, updatedAt: null });
    const done = r.refresh();
    await tick();
    expect(r.getState().refreshing).toBe(true);
    m.calls[0]!.resolve(7);
    await done;
    expect(r.getState()).toMatchObject({ data: 7, loading: false, refreshing: false, error: null, updatedAt: 1000 });
  });

  it('shares one request among simultaneous callers', async () => {
    const m = manual<number>();
    const r = createResource(m.fetcher);
    const a = r.refresh();
    const b = r.refresh();
    await tick();
    expect(m.calls).toHaveLength(1);
    m.calls[0]!.resolve(1);
    await Promise.all([a, b]);
    // the second call asked for fresher data while one was running: exactly one more follows, not one per ask
    await tick();
    expect(m.calls).toHaveLength(2);
    m.calls[1]!.resolve(2);
    await tick();
    expect(r.getState().data).toBe(2);
  });

  it('a burst of changes during one request produces one follow-up request, and the last answer wins', async () => {
    const m = manual<number>();
    const r = createResource(m.fetcher);
    void r.refresh();
    await tick();
    for (let i = 0; i < 20; i++) void r.refresh();
    m.calls[0]!.resolve(1);
    await tick();
    await tick();
    expect(m.calls).toHaveLength(2);
    m.calls[1]!.resolve(99);
    await tick();
    expect(r.getState().data).toBe(99);
  });

  it('keeps the same object when the answer is the same, so nothing re-renders', async () => {
    let n = 0;
    const r = createResource(async () => ({ list: [1, 2, 3], n: ++n * 0 }));
    await r.refresh();
    const first = r.getState().data;
    const listener = vi.fn();
    r.subscribe(listener);
    await r.refresh();
    expect(r.getState().data).toBe(first);
    // listeners still hear about the refresh finishing (refreshing flag), but the data reference is stable
    expect(listener).toHaveBeenCalled();
  });

  it('a changed answer is a new object', async () => {
    let v = 1;
    const r = createResource(async () => ({ v }));
    await r.refresh();
    const first = r.getState().data;
    v = 2;
    await r.refresh();
    expect(r.getState().data).not.toBe(first);
    expect(r.getState().data).toEqual({ v: 2 });
  });

  it('a failed refresh keeps the last good data and records the error; the next success clears it', async () => {
    let fail = false;
    const r = createResource(async () => {
      if (fail) throw new Error('offline');
      return 5;
    });
    await r.refresh();
    fail = true;
    await r.refresh();
    expect(r.getState()).toMatchObject({ data: 5, loading: false });
    expect(r.getState().error?.message).toBe('offline');
    fail = false;
    await r.refresh();
    expect(r.getState().error).toBeNull();
  });

  it('a fetcher that throws synchronously is an error, not a crash', async () => {
    const r = createResource<number>(() => {
      throw new Error('boom');
    });
    await r.refresh();
    expect(r.getState().error?.message).toBe('boom');
  });

  it('uses the newest fetcher, so a changed parameter is picked up by the next refresh', async () => {
    const r = createResource(async () => 'old');
    r.setFetcher(async () => 'new');
    await r.refresh();
    expect(r.getState().data).toBe('new');
  });

  it('can be unsubscribed from', async () => {
    const r = createResource(async () => 1);
    const l = vi.fn();
    const off = r.subscribe(l);
    off();
    await r.refresh();
    expect(l).not.toHaveBeenCalled();
  });
});

describe('the shared cache', () => {
  beforeEach(() => {
    clearResources();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('the same key gives the same resource, so a returning page paints from the last answer', async () => {
    const a = acquire('k', async () => 'x');
    await a.resource.refresh();
    a.release();
    const b = acquire('k', async () => 'y');
    expect(b.resource).toBe(a.resource);
    expect(b.resource.getState().data).toBe('x');
  });

  it('different keys do not share data', async () => {
    const a = acquire('a', async () => 1);
    const b = acquire('b', async () => 2);
    await a.resource.refresh();
    expect(b.resource.getState().data).toBeNull();
  });

  it('unused entries are dropped after a while and kept until then', () => {
    const a = acquire('gone', async () => 1);
    a.release();
    vi.advanceTimersByTime(KEEP_MS - 1000);
    expect(resourceCount()).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(resourceCount()).toBe(0);
  });

  it('an entry that is used again before it expires is not dropped', () => {
    const a = acquire('again', async () => 1);
    a.release();
    vi.advanceTimersByTime(KEEP_MS - 1000);
    const b = acquire('again', async () => 1);
    vi.advanceTimersByTime(KEEP_MS);
    expect(resourceCount()).toBe(1);
    b.release();
  });

  it('cannot grow without bound: many keys that are all released are all eventually dropped', () => {
    for (let i = 0; i < 500; i++) acquire(`quote:${i}`, async () => i).release();
    expect(resourceCount()).toBe(500);
    vi.advanceTimersByTime(KEEP_MS + 1000);
    expect(resourceCount()).toBe(0);
  });
});

describe('poll backoff', () => {
  /** How many polls actually happen over n ticks when every one fails. */
  const polls = (b: ReturnType<typeof createBackoff>, n: number, ok: boolean) => {
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (b.skip()) continue;
      count++;
      b.record(ok);
    }
    return count;
  };

  it('polls every tick while things work', () => {
    expect(polls(createBackoff(), 20, true)).toBe(20);
  });

  it('backs off while polls keep failing, to a ceiling, instead of hitting a dead server every tick', () => {
    const b = createBackoff();
    const attempts = polls(b, 100, false);
    expect(attempts).toBeLessThan(15);
    expect(attempts).toBeGreaterThan(4);
    expect(b.level()).toBe(4);
  });

  it('the gaps grow 1, 3, 7, 15 ticks and then hold', () => {
    const b = createBackoff();
    const gaps: number[] = [];
    let since = 0;
    for (let i = 0; i < 80; i++) {
      if (b.skip()) {
        since++;
        continue;
      }
      if (i > 0) gaps.push(since);
      since = 0;
      b.record(false);
    }
    expect(gaps.slice(0, 5)).toEqual([1, 3, 7, 15, 15]);
  });

  it('returns to the normal pace on the first success', () => {
    const b = createBackoff();
    polls(b, 30, false);
    while (b.skip()) { /* wait out the gap */ }
    b.record(true);
    expect(b.level()).toBe(0);
    expect(polls(b, 10, true)).toBe(10);
  });
});
