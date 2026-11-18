import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

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
