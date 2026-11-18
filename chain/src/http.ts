/**
 * The chain service's HTTP surface (see docs/CONTRACTS.md).
 *
 *   GET  /health
 *   POST /calls                  {betId}            commit a call (hash on chain)
 *   GET  /calls                                      this user's calls
 *   POST /calls/:id/reveal                           reveal after settlement
 *   GET  /calls/:id/verify                           re-read both records from Solana and recompute the hash
 *   GET  /leaderboard
 *   GET  /reveals/:signature     a verified, revealed call (public: no salt, no account)
 *   POST /hooks/quicknode                           QuickNode Stream deliveries
 *   POST /admin/backfill                             re-scan our authority's recent transactions
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ServiceError } from './executor.ts';
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
  rateLimit?: { max: number; windowMs: number };
  trustProxy?: boolean;
  now?: () => Date;
  /** Reads SOL balance for /health; may be slow, so it is optional and cached by the caller. */
  balance?: () => Promise<number | null>;
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)(:\d+)?$/i;
const MAX_BODY = 256 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new ServiceError(413, 'body_too_large', 'The request body is too large.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
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
  const hits = new Map<string, number[]>();
  const limited = (req: IncomingMessage): boolean => {
    if (!deps.rateLimit) return false;
    const fwd = deps.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
    const who = fwd || req.socket.remoteAddress || 'unknown';
    const t = now().getTime();
    const recent = (hits.get(who) ?? []).filter((x) => t - x < deps.rateLimit!.windowMs);
    if (recent.length >= deps.rateLimit.max) {
      hits.set(who, recent);
      return true;
    }
    recent.push(t);
    hits.set(who, recent);
    return false;
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

        if (req.method === 'GET' && path === '/health') {
          const balance = deps.balance ? await deps.balance().catch(() => null) : null;
          return send(200, { ...deps.service.health(), balanceSol: balance === null ? null : balance / 1e9, time: now().toISOString() });
        }

        if (isHook) {
          if (req.method !== 'POST') throw new ServiceError(405, 'method_not_allowed', 'POST only.');
          const raw = await readBody(req);
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
