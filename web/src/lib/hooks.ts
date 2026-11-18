import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Live } from './live';
import { createBackoff, resourceFor, retain } from './resource';

export interface Async<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/** Loads on mount and (optionally) every `everyMs`. Keeps the last good data while refreshing. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[], everyMs?: number): Async<T> {
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let alive = true;
    const run = () =>
      loadRef.current().then(
        (data) => alive && setState({ data, error: null, loading: false }),
        (error: Error) => alive && setState((s) => ({ data: s.data, error, loading: false })),
      );
    run();
    const id = everyMs ? window.setInterval(run, everyMs) : undefined;
    return () => {
      alive = false;
      if (id) window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, everyMs]);
  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) };
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Width of an element in CSS pixels, kept current. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => entry && setW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function useNow(everyMs = 15000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

export interface ResourceOptions {
  /** Live topics that mean "this changed": `[connection, topic]`. A null connection (demo mode) is ignored. */
  live?: Array<[Live | null, string]>;
  /** Fallback refresh interval, used whenever any listed live connection is not up (and always when there is none). */
  pollMs?: number;
  /** Shortest gap between refreshes caused by live events, so a burst of changes is one request. Default 400. */
  minGapMs?: number;
  /** An answer younger than this is not refetched when the page mounts. Default 2000. */
  staleMs?: number;
}

export interface ResourceView<T> {
  data: T | null;
  error: Error | null;
  /** True only until the first answer. */
  loading: boolean;
  /** True while any request is in flight, including a quiet background refresh. */
  refreshing: boolean;
  updatedAt: number | null;
  reload: () => void;
}

/**
 * Shared, cached data that keeps itself current. The answer for a key is painted at once if it was seen before and is
 * refreshed behind it; it refetches when a live event says it changed, when the tab regains focus, and by polling only
 * while the live connection is down. Hidden tabs do not poll.
 */
export function useResource<T>(key: string, fetcher: () => Promise<T>, options: ResourceOptions = {}): ResourceView<T> {
  const res = resourceFor<T>(key, fetcher);
  const state = useSyncExternalStore(res.subscribe, res.getState, res.getState);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const release = retain(key);
    const o = optionsRef.current;
    const s = res.getState();
    if (s.updatedAt === null || Date.now() - s.updatedAt > (o.staleMs ?? 2000)) void res.refresh();

    // Live events: at most one refresh per minGap, leading edge immediately, trailing edge so the last change is never lost.
    const gap = o.minGapMs ?? 400;
    let last = 0;
    let trailing: number | undefined;
    const kick = (): void => {
      const wait = last + gap - Date.now();
      if (wait <= 0) {
        last = Date.now();
        void res.refresh();
      } else if (trailing === undefined) {
        trailing = window.setTimeout(() => {
          trailing = undefined;
          last = Date.now();
          void res.refresh();
        }, wait);
      }
    };
    const lives = (o.live ?? []).filter((x): x is [Live, string] => x[0] !== null);
    const unsubs = lives.map(([l, topic]) => l.subscribe(topic, kick));

    const backoff = createBackoff();
    const poll = o.pollMs
      ? window.setInterval(() => {
          if (document.hidden) return;
          if (lives.length > 0 && lives.every(([l]) => l.status() === 'live')) return; // live events are covering it
          if (backoff.skip()) return; // the last tries failed: wait longer before the next
          void res.refresh().then(() => backoff.record(res.getState().error === null));
        }, o.pollMs)
      : undefined;

    const wake = (): void => {
      if (document.hidden) return;
      const u = res.getState().updatedAt;
      if (u === null || Date.now() - u > 5000) void res.refresh();
    };
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);

    return () => {
      for (const off of unsubs) off();
      if (poll !== undefined) window.clearInterval(poll);
      if (trailing !== undefined) window.clearTimeout(trailing);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      release();
    };
  }, [key, res]);

  return { data: state.data, error: state.error, loading: state.loading, refreshing: state.refreshing, updatedAt: state.updatedAt, reload: useCallback(() => void res.refresh(), [res]) };
}

/** The live status of a connection, for a badge. `null` (demo mode) is reported as 'idle'. */
export function useLiveStatus(live: Live | null): 'idle' | 'connecting' | 'live' | 'down' {
  return useSyncExternalStore(
    (cb) => (live ? live.onStatus(cb) : () => {}),
    () => (live ? live.status() : 'idle'),
    () => 'idle',
  );
}
