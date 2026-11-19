/**
 * The chain service's HTTP surface (see docs/CONTRACTS.md).
 *
 *   GET  /health
 *   POST /calls                  {betId}            commit a call (hash on chain)
 *   GET  /calls                                      this user's calls
 *   POST /calls/:id/reveal                           reveal after settlement
 *   GET  /calls/:id/verify                           re-read both records from Solana and recompute the hash
 *   GET  /leaderboard
 *   GET  /events?topics=calls,leaderboard   server-sent events: a topic name means "it changed, refetch"
 *   GET  /reveals/:signature     a verified, revealed call (public: no salt, no account)
 *   POST /hooks/quicknode                           QuickNode Stream deliveries
 *   POST /admin/backfill                             re-scan our authority's recent transactions
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { ServiceError } from './executor.ts';
import { encodeBody, etagOf, notModified } from './http-cache.ts';
import { createLimiter } from './limiter.ts';
import type { LiveHub } from './live.ts';
import type { ChainService } from './service.ts';
import { hookAuthentic, signaturesIn } from './webhook.ts';
import type { HookAuth } from './webhook.ts';

export interface HttpDeps {
  service: ChainService;
  /** The executor account this service serves. */
  user: string;
  corsOrigins?: string[];
  hook: HookAuth;
  adminToken?: string;
  /** Server-sent events hub for `GET /events`. Without it that route answers 404. */
  live?: LiveHub;
  /** Streams one client address may hold open. Default 8. */
  maxStreamsPerClient?: number;
  rateLimit?: { max: number; windowMs: number };
  trustProxy?: boolean;
  now?: () => Date;
  /** Reads SOL balance for /health; may be slow, so it is optional and cached by the caller. */
  balance?: () => Promise<number | null>;
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)(:\d+)?$/i;
const MAX_BODY = 256 * 1024;

const MAX_INFLATED = 4 * MAX_BODY;

async function readBytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new ServiceError(413, 'body_too_large', 'The request body is too large.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const readBody = async (req: IncomingMessage): Promise<string> => (await readBytes(req)).toString('utf8');

/**
 * A Stream's webhook can be set to gzip its payloads. QuickNode signs the uncompressed JSON, so the body is inflated
 * before it is authenticated or parsed. Without this, switching compression on would fail every delivery and the Stream
 * would pause. The inflated size is capped, so a small body cannot expand without limit.
 */
async function readHookBody(req: IncomingMessage): Promise<string> {
  const bytes = await readBytes(req);
  if (!/\bgzip\b/i.test(String(req.headers['content-encoding'] ?? ''))) return bytes.toString('utf8');
  try {
    return gunzipSync(bytes, { maxOutputLength: MAX_INFLATED }).toString('utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new ServiceError(413, 'body_too_large', 'The request body is too large.');
    throw new ServiceError(400, 'invalid_encoding', 'The body is marked gzip but does not decompress.');
  }
}

const parseJson = (text: string): Record<string, unknown> => {
  if (text.trim() === '') return {};
  try {
    const v: unknown = JSON.parse(text);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new ServiceError(400, 'invalid_json', 'The request body is not a valid JSON object.');
};

export function createHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const now = deps.now ?? (() => new Date());
  const streams = new Map<string, number>();
  const limiter = createLimiter(deps.rateLimit, () => now().getTime());
  const limited = (req: IncomingMessage): boolean => {
    const fwd = deps.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
    return limiter.limited(fwd || req.socket.remoteAddress || 'unknown');
  };

  return (req, res) => {
    const origin = req.headers.origin;
    const allowed = origin === undefined || LOCAL_ORIGIN.test(origin) || (deps.corsOrigins ?? []).includes(origin);
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' };
    if (origin !== undefined && allowed) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
      headers['Access-Control-Max-Age'] = '600';
    }
    const send = (status: number, body: unknown) => {
      // A 200 GET answer carries a validator, so an unchanged one is a 304 and a large one travels gzipped.
      if (status === 200 && req.method === 'GET' && body !== null && typeof body === 'object') {
        const etag = etagOf(body);
        const common = { ...headers, ETag: etag, 'Cache-Control': 'no-cache', Vary: 'Origin, Accept-Encoding' };
        if (notModified(req.headers['if-none-match'], etag)) {
          res.writeHead(304, common);
          res.end();
          return;
        }
        const { body: bytes, encoding } = encodeBody(JSON.stringify(body), req.headers['accept-encoding']);
        res.writeHead(200, { ...common, ...(encoding ? { 'Content-Encoding': encoding } : {}), 'Content-Length': String(bytes.length) });
        res.end(bytes);
        return;
      }
      res.writeHead(status, headers);
      res.end(status === 204 ? undefined : JSON.stringify(body));
    };

    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const isHook = path === '/hooks/quicknode';
        // The webhook is called by QuickNode, not a browser; it is authenticated by its own headers instead of an origin.
        if (!allowed && !isHook) throw new ServiceError(403, 'origin_not_allowed', `Requests from ${origin} are not allowed.`);
        if (req.method === 'OPTIONS') return send(204, null);

        if (req.method === 'GET' && path === '/events') {
          if (!deps.live) throw new ServiceError(404, 'not_available', 'Live updates are not enabled on this server.');
          const asked = (url.searchParams.get('topics') ?? 'calls,leaderboard').split(',').map((t) => t.trim()).filter((t) => t === 'calls' || t === 'leaderboard');
          if (asked.length === 0) throw new ServiceError(400, 'unknown_topic', 'Choose topics from: calls, leaderboard.');
          const fwd = deps.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
          const who = fwd || req.socket.remoteAddress || 'unknown';
          if ((streams.get(who) ?? 0) >= (deps.maxStreamsPerClient ?? 8)) throw new ServiceError(429, 'too_many_streams', 'Too many open live connections from this address.');
          if (!deps.live.subscribe(req, res, headers, new Set(asked))) throw new ServiceError(503, 'streams_full', 'The server is at its limit of live connections. Updates will arrive by refresh instead.');
          streams.set(who, (streams.get(who) ?? 0) + 1);
          res.on('close', () => {
            const left = (streams.get(who) ?? 1) - 1;
            if (left <= 0) streams.delete(who);
            else streams.set(who, left);
          });
          return;
        }

        if (req.method === 'GET' && path === '/health') {
          const balance = deps.balance ? await deps.balance().catch(() => null) : null;
          return send(200, { ...deps.service.health(), balanceSol: balance === null ? null : balance / 1e9, time: now().toISOString() });
        }

        if (isHook) {
          if (req.method !== 'POST') throw new ServiceError(405, 'method_not_allowed', 'POST only.');
          const raw = await readHookBody(req);
          if (!hookAuthentic(req.headers, raw, deps.hook, now().getTime())) throw new ServiceError(401, 'unauthorized', 'Not an authorised delivery.');
          let payload: unknown = null;
          try {
            payload = raw.trim() === '' ? null : JSON.parse(raw);
          } catch {
            throw new ServiceError(400, 'invalid_json', 'The body is not valid JSON.');
          }
          const sigs = signaturesIn(payload);
          // Answer at once (a Stream pauses after repeated failures or timeouts); process after.
          for (const sig of sigs) deps.service.ingest(sig, 'stream').catch((e: unknown) => console.error(`ingest ${sig.slice(0, 8)}…: ${e instanceof Error ? e.message : String(e)}`));
          return send(202, { accepted: sigs.length });
        }

        if (req.method === 'POST' && path === '/admin/backfill') {
          const given = String(req.headers['x-admin-token'] ?? '');
          const ok = deps.adminToken !== undefined && given.length === deps.adminToken.length && timingSafeEqual(Buffer.from(given), Buffer.from(deps.adminToken));
          if (!ok) throw new ServiceError(401, 'unauthorized', 'Admin token required.');
          return send(200, await deps.service.backfill());
        }

        if (req.method === 'POST' && limited(req)) {
          headers['Retry-After'] = String(Math.ceil((deps.rateLimit?.windowMs ?? 60_000) / 1000));
          throw new ServiceError(429, 'rate_limited', 'Too many requests. Wait a minute and try again.');
        }

        if (req.method === 'POST' && path === '/calls') {
          const body = parseJson(await readBody(req));
          if (typeof body.betId !== 'string' || body.betId === '') throw new ServiceError(400, 'missing_field', '"betId" is required.');
          return send(201, await deps.service.commitCall(body.betId, deps.user));
        }
        if (req.method === 'GET' && path === '/calls') return send(200, { calls: deps.service.listCalls(deps.user) });
        if (req.method === 'GET' && path === '/leaderboard') return send(200, deps.service.leaderboard());

        const pub = /^\/reveals\/([1-9A-HJ-NP-Za-km-z]{64,90})$/.exec(path);
        if (pub && req.method === 'GET') return send(200, deps.service.publicReveal(pub[1]!));

        const m = /^\/calls\/([A-Za-z0-9_-]{1,64})\/(reveal|verify)$/.exec(path);
        if (m) {
          const [, id, action] = m as unknown as [string, string, string];
          if (action === 'reveal' && req.method === 'POST') return send(200, await deps.service.revealCall(id, deps.user));
          if (action === 'verify' && req.method === 'GET') return send(200, await deps.service.verifyCall(id, deps.user));
          throw new ServiceError(405, 'method_not_allowed', `${path} does not accept ${req.method}.`);
        }
        throw new ServiceError(404, 'not_found', `No such endpoint: ${path}.`);
      } catch (err) {
        if (err instanceof ServiceError) return send(err.status, { error: err.message, code: err.code });
        console.error(err);
        send(500, { error: 'Something went wrong on our side.', code: 'internal_error' });
      }
    })();
  };
}
