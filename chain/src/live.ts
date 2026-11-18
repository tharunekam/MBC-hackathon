/**
 * Server-sent events, kept deliberately small. The hub does not carry data: it tells clients that a topic changed
 * (`event: markets` / `data: {"v":12}`), and the client refetches the resource it cares about, using its ETag so an
 * unchanged answer costs a 304. That keeps every update correct (one source of truth, the normal GET) and every
 * message tiny, and a missed message only delays an update until the next one or the fallback poll.
 *
 * Safe by construction: capped client count, heartbeat to keep proxies from closing idle streams, slow consumers are
 * dropped instead of buffering without bound, and nothing is retained for a client that has gone.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface LiveHubOptions {
  /** Most simultaneous streams. A stream is a held-open socket, so this is a real resource limit. */
  maxClients?: number;
  heartbeatMs?: number;
  /** A client whose socket buffer exceeds this many bytes is dropped. */
  maxBufferedBytes?: number;
}

interface Client {
  res: ServerResponse;
  topics: Set<string>;
}

export interface LiveHub {
  /** Tell everyone subscribed to `topic` that it changed. Returns how many clients were told. */
  publish(topic: string): number;
  /** Opens a stream for `res`. False when the hub is full (the caller answers 503). */
  subscribe(req: IncomingMessage, res: ServerResponse, headers: Record<string, string>, topics: Set<string>): boolean;
  /** Clients currently subscribed to a topic (or to anything). */
  count(topic?: string): number;
  /** Current version of a topic: it only ever goes up. Lets a client or a test see that something changed. */
  version(topic: string): number;
  /** Called with the topic's client count whenever it goes from 0 to 1 or from 1 to 0. */
  onWatch(fn: (topic: string, watching: boolean) => void): () => void;
  close(): void;
}

export function createLiveHub(options: LiveHubOptions = {}): LiveHub {
  const maxClients = options.maxClients ?? 200;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxBuffered = options.maxBufferedBytes ?? 64 * 1024;
  const clients = new Set<Client>();
  const versions = new Map<string, number>();
  const watchers: Array<(topic: string, watching: boolean) => void> = [];
  let timer: NodeJS.Timeout | undefined;

  const count = (topic?: string): number => {
    if (topic === undefined) return clients.size;
    let n = 0;
    for (const c of clients) if (c.topics.has(topic)) n++;
    return n;
  };

  const drop = (c: Client): void => {
    if (!clients.delete(c)) return;
    for (const t of c.topics) if (count(t) === 0) for (const w of watchers) w(t, false);
    if (clients.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (!c.res.writableEnded) c.res.end();
  };

  const write = (c: Client, chunk: string): void => {
    if (c.res.writableLength > maxBuffered) return drop(c); // a stalled reader must not make us hold memory for it
    c.res.write(chunk);
  };

  const ensureTimer = (): void => {
    if (timer) return;
    timer = setInterval(() => {
      for (const c of [...clients]) write(c, ': ping\n\n');
    }, heartbeatMs);
    timer.unref();
  };

  return {
    publish(topic) {
      const v = (versions.get(topic) ?? 0) + 1;
      versions.set(topic, v);
      let told = 0;
      for (const c of [...clients]) {
        if (!c.topics.has(topic)) continue;
        write(c, `event: ${topic}\ndata: {"v":${v}}\n\n`);
        told++;
      }
      return told;
    },

    subscribe(req, res, headers, topics) {
      if (clients.size >= maxClients) return false;
      res.writeHead(200, {
        ...headers,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // tell nginx-style proxies not to buffer the stream
      });
      const client: Client = { res, topics };
      const wasWatched = new Map([...topics].map((t) => [t, count(t) > 0]));
      clients.add(client);
      // `retry` sets the browser's reconnect delay; `hello` tells the page the stream is really open.
      res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ topics: [...topics], versions: Object.fromEntries([...topics].map((t) => [t, versions.get(t) ?? 0])) })}\n\n`);
      for (const t of topics) if (!wasWatched.get(t)) for (const w of watchers) w(t, true);
      ensureTimer();
      const gone = (): void => drop(client);
      req.on('close', gone);
      res.on('error', gone);
      res.on('close', gone);
      return true;
    },

    count,
    version: (topic) => versions.get(topic) ?? 0,
    onWatch(fn) {
      watchers.push(fn);
      return () => {
        const i = watchers.indexOf(fn);
        if (i >= 0) watchers.splice(i, 1);
      };
    },
    close() {
      for (const c of [...clients]) drop(c);
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
