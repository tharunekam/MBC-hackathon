/**
 * A keyed, shared cache of fetched data with stale-while-revalidate behaviour, independent of React.
 *
 *  - A page that mounts again (or another page asking for the same thing) paints from the last answer at once and
 *    refreshes behind it.
 *  - One request in flight per key. A change that arrives while one is running schedules exactly one more after it, so a
 *    burst of updates cannot stack requests and the last word is never lost.
 *  - A refresh that returns the same data keeps the same object, so nothing re-renders for an answer that did not change.
 *  - A failed refresh keeps the last good data and records the error.
 *  - Unused entries are dropped after a while, so the cache cannot grow for ever.
 */
export interface ResourceState<T> {
  data: T | null;
  error: Error | null;
  /** True only until the first answer: nothing to show yet. */
  loading: boolean;
  /** True whenever a request is in flight, including a background refresh. */
  refreshing: boolean;
  /** ms epoch of the last successful answer. */
  updatedAt: number | null;
}

export interface Resource<T> {
  getState(): ResourceState<T>;
  subscribe(listener: () => void): () => void;
  /** Fetches now, or joins the request already running. Resolves when this refresh has finished. */
  refresh(): Promise<void>;
  setFetcher(fetcher: () => Promise<T>): void;
}

export function createResource<T>(initialFetcher: () => Promise<T>, now: () => number = Date.now): Resource<T> {
  let fetcher = initialFetcher;
  let state: ResourceState<T> = { data: null, error: null, loading: true, refreshing: false, updatedAt: null };
  const listeners = new Set<() => void>();
  let inflight: Promise<void> | null = null;
  let again = false;

  const set = (patch: Partial<ResourceState<T>>): void => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };

  function run(): Promise<void> {
    set({ refreshing: true });
    return Promise.resolve()
      .then(() => fetcher())
      .then(
        (next) => {
          const same = state.data !== null && JSON.stringify(state.data) === JSON.stringify(next);
          set({ data: same ? state.data : next, error: null, loading: false, refreshing: false, updatedAt: now() });
        },
        (err: unknown) => set({ error: err instanceof Error ? err : new Error(String(err)), loading: false, refreshing: false }),
      )
      .finally(() => {
        inflight = null;
        if (again) {
          again = false;
          void res.refresh();
        }
      });
  }

  const res: Resource<T> = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh() {
      if (inflight) {
        again = true; // something changed while a request was running: one more after it, not one per change
        return inflight;
      }
      inflight = run();
      return inflight;
    },
    setFetcher(next) {
      fetcher = next;
    },
  };
  return res;
}

/**
 * Slows a poll down while it keeps failing, so a server that is restarting or unreachable is not hit at full speed by every
 * open tab, and returns to the normal pace on the first success. Counts in poll ticks: after the first failure it skips 1
 * tick, then 3, 7, 15, and stays at 15.
 */
export function createBackoff(maxLevel = 4): { skip(): boolean; record(ok: boolean): void; level(): number } {
  let level = 0;
  let wait = 0;
  return {
    /** True when this tick should not poll. Call once per tick. */
    skip() {
      if (wait > 0) {
        wait--;
        return true;
      }
      return false;
    },
    record(ok) {
      if (ok) {
        level = 0;
        wait = 0;
      } else {
        level = Math.min(level + 1, maxLevel);
        wait = 2 ** level - 1;
      }
    },
    level: () => level,
  };
}

// ---------------------------------------------------------------------------------------------------- registry

interface Entry {
  resource: Resource<unknown>;
  users: number;
  evict: unknown;
}

const registry = new Map<string, Entry>();
/** How long an unused answer is kept for an instant repaint. */
export const KEEP_MS = 5 * 60_000;

/**
 * Gets (or creates) the resource for a key without retaining it, so it can be read while rendering. An entry that is
 * created but never retained (an aborted render) is dropped like any unused one.
 */
export function resourceFor<T>(key: string, fetcher: () => Promise<T>): Resource<T> {
  let entry = registry.get(key);
  if (!entry) {
    entry = { resource: createResource(fetcher) as Resource<unknown>, users: 0, evict: null };
    registry.set(key, entry);
    scheduleEviction(key, entry);
  } else entry.resource.setFetcher(fetcher as () => Promise<unknown>);
  return entry.resource as Resource<T>;
}

function scheduleEviction(key: string, entry: Entry): void {
  if (entry.evict) clearTimeout(entry.evict as number);
  entry.evict = setTimeout(() => {
    if (entry.users <= 0 && registry.get(key) === entry) registry.delete(key);
  }, KEEP_MS);
}

/** Marks a key as in use (from an effect). Returns the release. */
export function retain(key: string): () => void {
  const entry = registry.get(key);
  if (!entry) return () => {};
  entry.users++;
  if (entry.evict) {
    clearTimeout(entry.evict as number);
    entry.evict = null;
  }
  return () => {
    entry.users--;
    if (entry.users <= 0) scheduleEviction(key, entry);
  };
}

export function acquire<T>(key: string, fetcher: () => Promise<T>): { resource: Resource<T>; release: () => void } {
  const resource = resourceFor(key, fetcher);
  return { resource, release: retain(key) };
}

/** Drops every cached answer (used when the user or the backend changes, and by tests). */
export function clearResources(): void {
  for (const e of registry.values()) if (e.evict) clearTimeout(e.evict as number);
  registry.clear();
}

export const resourceCount = (): number => registry.size;
