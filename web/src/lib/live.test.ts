import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLive } from './live';
import type { EventSourceLike, LiveStatus } from './live';

/** A scriptable EventSource: the test decides what the server says and when the connection dies. */
class FakeSource implements EventSourceLike {
  static all: FakeSource[] = [];
  readyState = 0;
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  private handlers = new Map<string, Array<(e: { data?: string }) => void>>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: { data?: string }) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  say(type: string): void {
    this.readyState = 1;
    for (const h of this.handlers.get(type) ?? []) h({ data: '{}' });
  }
  /** The browser is retrying by itself (readyState CONNECTING). */
  blip(): void {
    this.readyState = 0;
    this.onerror?.({});
  }
  /** The server refused or the browser gave up (readyState CLOSED). */
  die(): void {
    this.readyState = 2;
    this.onerror?.({});
  }
}

beforeEach(() => {
  FakeSource.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const make = () => createLive('/api/stream', ['markets', 'bets'], { create: (u) => new FakeSource(u), random: () => 1 });
const last = () => FakeSource.all[FakeSource.all.length - 1]!;

describe('the shared connection', () => {
  it('opens only when someone subscribes, with the topics in the address, and shares one connection', () => {
    const live = make();
    expect(FakeSource.all).toHaveLength(0);
    live.subscribe('markets', () => {});
    live.subscribe('bets', () => {});
    expect(FakeSource.all).toHaveLength(1);
    expect(last().url).toBe('/api/stream?topics=markets,bets');
    expect(live.status()).toBe('connecting');
  });

  it('is live once the server says hello, and routes each topic only to its subscribers', () => {
    const live = make();
    const markets = vi.fn();
    const bets = vi.fn();
    live.subscribe('markets', markets);
    live.subscribe('bets', bets);
    last().say('hello');
    expect(live.status()).toBe('live');
    last().say('markets');
    expect(markets).toHaveBeenCalledTimes(1);
    expect(bets).not.toHaveBeenCalled();
  });

  it('rejects a topic it does not carry', () => {
    expect(() => make().subscribe('nonsense', () => {})).toThrow(/Unknown live topic/);
  });

  it('keeps the connection a moment after the last subscriber leaves, then closes it', () => {
    const live = make();
    const off = live.subscribe('markets', () => {});
    last().say('hello');
    off();
    vi.advanceTimersByTime(1000);
    expect(last().closed).toBe(false);
    const off2 = live.subscribe('markets', () => {}); // a quick page change: no reconnect
    expect(FakeSource.all).toHaveLength(1);
    off2();
    vi.advanceTimersByTime(2000);
    expect(last().closed).toBe(true);
    expect(live.status()).toBe('idle');
  });

  it('reports status changes, and a subscriber can stop listening', () => {
    const live = make();
    const seen: LiveStatus[] = [];
    const stop = live.onStatus((s) => seen.push(s));
    live.subscribe('markets', () => {});
    last().say('hello');
    stop();
    last().blip();
    expect(seen).toEqual(['connecting', 'live']);
  });
});

describe('outages', () => {
  it('while the browser retries by itself it is reported down and left alone, then everyone refetches on recovery', () => {
    const live = make();
    const a = vi.fn();
    const b = vi.fn();
    live.subscribe('markets', a);
    live.subscribe('bets', b);
    last().say('hello');
    last().blip();
    expect(live.status()).toBe('down');
    expect(FakeSource.all).toHaveLength(1);
    last().say('hello'); // the browser reconnected
    expect(live.status()).toBe('live');
    expect(a).toHaveBeenCalledTimes(1); // changes may have been missed: resync
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('a subscriber on two topics is told once on recovery, not twice', () => {
    const live = make();
    const both = vi.fn();
    live.subscribe('markets', both);
    live.subscribe('bets', both);
    last().say('hello');
    last().blip();
    last().say('hello');
    expect(both).toHaveBeenCalledTimes(1);
  });

  it('when the browser gives up (a 429 or 503), it reconnects itself with growing, capped delays', () => {
    const live = make();
    live.subscribe('markets', () => {});
    last().say('hello');
    last().die();
    expect(FakeSource.all).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(FakeSource.all).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(FakeSource.all).toHaveLength(2); // after 1s
    last().die();
    vi.advanceTimersByTime(1999);
    expect(FakeSource.all).toHaveLength(2);
    vi.advanceTimersByTime(2);
    expect(FakeSource.all).toHaveLength(3); // after 2s
    for (let i = 0; i < 12; i++) {
      last().die();
      vi.advanceTimersByTime(31_000);
    }
    const before = FakeSource.all.length;
    last().die();
    vi.advanceTimersByTime(29_000);
    expect(FakeSource.all.length).toBe(before); // never sooner than the cap allows
    vi.advanceTimersByTime(2000);
    expect(FakeSource.all.length).toBe(before + 1);
  });

  it('a successful hello resets the backoff', () => {
    const live = make();
    live.subscribe('markets', () => {});
    last().die();
    vi.advanceTimersByTime(1100);
    last().die();
    vi.advanceTimersByTime(2100);
    last().say('hello');
    last().die();
    vi.advanceTimersByTime(1100);
    expect(FakeSource.all).toHaveLength(4); // back to the 1s delay
  });
});

describe('hidden tabs', () => {
  it('pause drops the connection and keeps subscribers; resume reconnects and makes them refetch', () => {
    const live = make();
    const cb = vi.fn();
    live.subscribe('markets', cb);
    last().say('hello');
    live.pause();
    expect(last().closed).toBe(true);
    expect(live.status()).toBe('idle');
    live.resume();
    expect(FakeSource.all).toHaveLength(2);
    last().say('hello');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('nothing reconnects while paused, even after an error', () => {
    const live = make();
    live.subscribe('markets', () => {});
    last().die();
    live.pause();
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.all).toHaveLength(1);
  });
});
