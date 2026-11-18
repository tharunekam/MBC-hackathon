/**
 * One shared server-sent-events connection per backend, reference-counted and self-healing.
 *
 * A topic message means only "this changed, refetch". Pages subscribe to a topic and refetch; nothing here carries data,
 * so a missed message is harmless: after any outage the manager tells every subscriber to refetch (`resync`), and while
 * the stream is down the pages fall back to polling.
 *
 * Everything with a side effect is injected, so the behaviour is tested without a browser or a server.
 */
export type LiveStatus = 'idle' | 'connecting' | 'live' | 'down';

export interface EventSourceLike {
  readyState: number;
  onerror: ((e: unknown) => void) | null;
  addEventListener(type: string, listener: (e: { data?: string }) => void): void;
  close(): void;
}

export interface LiveDeps {
  create?: (url: string) => EventSourceLike;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  random?: () => number;
}

export interface Live {
  /** Calls `cb` whenever `topic` changes, or when the stream recovers from an outage. Returns the unsubscribe. */
  subscribe(topic: string, cb: () => void): () => void;
  onStatus(cb: (s: LiveStatus) => void): () => void;
  status(): LiveStatus;
  /** Drops the connection without forgetting subscribers (a hidden tab). */
  pause(): void;
  /** Reconnects after `pause` and makes every subscriber refetch. */
  resume(): void;
}

const CLOSED = 2;
/** How long the connection is kept open after the last subscriber leaves, so a quick page change does not reconnect. */
const LINGER_MS = 1500;

export function createLive(url: string, topics: string[], deps: LiveDeps = {}): Live {
  const create = deps.create ?? ((u: string) => new EventSource(u) as unknown as EventSourceLike);
  const later = deps.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const cancel = deps.clearTimeout ?? ((id) => globalThis.clearTimeout(id as number));
  const random = deps.random ?? Math.random;

  const subs = new Map<string, Set<() => void>>(topics.map((t) => [t, new Set()]));
  const statusSubs = new Set<(s: LiveStatus) => void>();
  let source: EventSourceLike | null = null;
  let state: LiveStatus = 'idle';
  let attempt = 0;
  let retry: unknown = null;
  let linger: unknown = null;
  let paused = false;
  /** True after an outage or a pause: the next successful `hello` must make everyone refetch. */
  let missed = false;

  const total = (): number => [...subs.values()].reduce((n, s) => n + s.size, 0);
  const setStatus = (s: LiveStatus): void => {
    if (s === state) return;
    state = s;
    for (const cb of [...statusSubs]) cb(s);
  };
  const notify = (topic: string): void => {
    for (const cb of [...(subs.get(topic) ?? [])]) cb();
  };
  const notifyAll = (): void => {
    const seen = new Set<() => void>();
    for (const set of subs.values()) for (const cb of set) seen.add(cb); // one refetch per subscriber, not per topic
    for (const cb of seen) cb();
  };

  function close(): void {
    if (retry) cancel(retry);
    retry = null;
    source?.close();
    source = null;
    setStatus('idle');
  }

  function open(): void {
    if (source || paused || total() === 0) return;
    setStatus('connecting');
    const es = create(`${url}?topics=${topics.join(',')}`);
    source = es;
    es.addEventListener('hello', () => {
      attempt = 0;
      setStatus('live');
      if (missed) {
        missed = false;
        notifyAll();
      }
    });
    for (const t of topics) es.addEventListener(t, () => notify(t));
    es.onerror = () => {
      missed = true;
      setStatus('down');
      // While the browser is still retrying by itself (readyState CONNECTING) we leave it alone. If it gave up (CLOSED,
      // as after a 429 or 503), reconnect ourselves with backoff.
      if (es.readyState === CLOSED && source === es) {
        es.close();
        source = null;
        const delay = Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + random() / 2);
        attempt++;
        retry = later(() => {
          retry = null;
          open();
        }, delay);
      }
    };
  }

  return {
    subscribe(topic, cb) {
      const set = subs.get(topic);
      if (!set) throw new Error(`Unknown live topic "${topic}".`);
      set.add(cb);
      if (linger) {
        cancel(linger);
        linger = null;
      }
      open();
      return () => {
        set.delete(cb);
        if (total() === 0 && !linger) {
          linger = later(() => {
            linger = null;
            if (total() === 0) close();
          }, LINGER_MS);
        }
      };
    },
    onStatus(cb) {
      statusSubs.add(cb);
      return () => statusSubs.delete(cb);
    },
    status: () => state,
    pause() {
      if (paused) return;
      paused = true;
      missed = true;
      close();
    },
    resume() {
      if (!paused) return;
      paused = false;
      open();
    },
  };
}
