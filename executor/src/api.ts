/**
 * The HTTP API the frontend talks to. This file holds the request handling and
 * nothing about sockets or credentials, so the tests can run it against the
 * in-memory exchange. `server.ts` wires it to Gemini.
 *
 *   GET  /health
 *   GET  /markets[?event=TICKER][&include=refused]
 *   GET  /quote?event=&condition=&target=&stake=[&user=]
 *   POST /bets            {user, event, condition, target, stake, maxPrice?, slippageTicks?, onHedgeFail?}
 *   GET  /bets[?user=]
 *   POST /settle
 *   GET  /flow[?user=]
 *   GET  /reconcile[?user=]
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BetRefused, ReviewError, isScorable, placeConditionalBet, recordReviewedPayout, settleBets } from './bets.ts';
import type { Exchange } from './exchange.ts';
import { betFlow, flowTotals } from './flow.ts';
import type { GeminiEvent } from './gemini/types.ts';
import type { BetRecord, Ledger } from './ledger.ts';
import {
  MAX_ALL_IN_PRICE,
  PRODUCTION_TAKER_FEE_COEF,
  REFUSE_MARKUP_DOLLARS,
  REFUSE_MARKUP_FRACTION,
  WARN_MARKUP_DOLLARS,
  WARN_MARKUP_FRACTION,
  capToDepth,
  ladderInversions,
  planForQuantity,
} from './offer.ts';
import { findPair, ladder, linkedPairs } from './pairs.ts';
import type { LinkedPair, Rung } from './pairs.ts';
import { floorToStep } from './pricing.ts';
import { encodeBody, etagOf, notModified } from './http-cache.ts';
import { createLimiter } from './limiter.ts';
import type { LiveHub } from './live.ts';
import { ensureBaseline, reconcile } from './reconcile.ts';

export interface ApiDeps {
  ledger: Ledger;
  /** Names of the accounts that can trade. Never their keys. */
  users: string[];
  /** The long-lived exchange session for one user. */
  exchangeFor(user: string): Exchange;
  /** Whether that user's exchange session is currently connected, if known. */
  isConnected?(user: string): boolean;
  /** Public market data. */
  markets: {
    listEvents(): Promise<GeminiEvent[]>;
    getEvent(ticker: string): Promise<GeminiEvent>;
  };
  isSandbox: boolean;
  /** Fee coefficient the venue actually charges. */
  feeCoef: number;
  /** Sandbox demo switch; see config.waiveMarkup. */
  waiveMarkup: boolean;
  /** Our own seeder is quoting on this sandbox (config.seeded). Reported by /health so the app can say so. */
  seeded?: boolean;
  /** GIVEN_ADMIN_TOKEN. Without it POST /review (record a payout by hand) answers 404. */
  adminToken?: string;
  /** Extra allowed browser origins besides localhost. */
  corsOrigins?: string[];
  /** How long a /markets answer is reused, in ms. Default 5000. */
  marketsCacheMs?: number;
  /**
   * An answer older than marketsCacheMs but younger than this is still served at once while a fresh one loads in the
   * background (stale-while-revalidate), so nobody waits two seconds for the market list. Default 60000. Only applies
   * when marketsCacheMs is above 0.
   */
  staleMarketsMs?: number;
  /** Server-sent events hub for `GET /stream`. Without it that route answers 404. */
  live?: LiveHub;
  /** While at least one page is watching `markets`, re-read the market list this often (ms). Default 3000. */
  refreshMs?: number;
  /** Settle finished bets by itself this often (ms). 0 or unset: only when asked. Reads Gemini and writes the ledger; places no order. */
  autoSettleMs?: number;
  /** Identical quote requests within this many ms share one answer (each costs two live book reads). Default 0: only requests in flight at the same moment share. */
  quoteCacheMs?: number;
  /** Streams one client address may hold open. Default 8. */
  maxStreamsPerClient?: number;
  /** True when no account is connected: ladders and quotes are live, but nothing can be ordered, settled or reconciled. */
  readOnly?: boolean;
  /** Name shown for the venue. Set it when the exchange is not Gemini (the local test exchange), so nothing claims to be Gemini. */
  venueName?: string;
  /**
   * Hosted-demo protections. All optional; a local executor leaves them off.
   * `pinnedUser`: every request acts as this one account and a "user" sent by the browser is ignored.
   * `maxStake`: bets above this many dollars are refused.
   * `isPaused`: checked on every bet; true answers 503 (an operator kill switch that needs no restart).
   * `rateLimit`: at most `max` bets and settles per client per `windowMs`.
   */
  pinnedUser?: string;
  maxStake?: number;
  isPaused?: () => boolean;
  rateLimit?: { max: number; windowMs: number };
  /** Read the client address from X-Forwarded-For (set only behind a trusted proxy). */
  trustProxy?: boolean;
  now?: () => Date;
  newId?: () => string;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)(:\d+)?$/i;
const MAX_BODY_BYTES = 64 * 1024;

const rungView = (r: Rung) => ({ symbol: r.symbol, label: r.label, strike: r.strike, bid: r.bid, ask: r.ask, open: r.open, state: r.state });
const pairView = (p: LinkedPair) => ({
  condition: { symbol: p.a.symbol, label: p.a.label, strike: p.a.strike, bid: p.a.bid, ask: p.a.ask },
  target: { symbol: p.b.symbol, label: p.b.label, strike: p.b.strike, bid: p.b.bid, ask: p.b.ask },
  quote: p.offer,
});
const betView = (bet: BetRecord) => ({ ...bet, scorable: isScorable(bet), flow: betFlow(bet) });

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large', 'The request body is too large.');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_json', 'The request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/** Builds the request handler. Pass it to `http.createServer`. */
export type ApiHandler = ((req: IncomingMessage, res: ServerResponse) => void) & {
  /** Stops this API's background timers. The live hub belongs to whoever created it and is closed by them. */
  close(): void;
};

export function createApi(deps: ApiDeps): ApiHandler {
  const now = deps.now ?? (() => new Date());
  const venue = deps.venueName ?? (deps.isSandbox ? 'Gemini sandbox' : 'Gemini');
  const pairOpts = { feeCoef: deps.feeCoef, waiveMarkup: deps.waiveMarkup };
  const betDeps = (user: string) => ({
    exchange: deps.exchangeFor(user),
    ledger: deps.ledger,
    feeCoef: deps.feeCoef,
    waiveMarkup: deps.waiveMarkup,
    now: deps.now,
    newId: deps.newId,
  });

  // One bet (or settle) at a time per user: orders for the same account never interleave.
  const queues = new Map<string, Promise<unknown>>();
  const queued = <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).then(job, job);
    queues.set(key, next.catch(() => undefined));
    return next;
  };

  const requireUser = (given: unknown): string => {
    const user = deps.pinnedUser ?? given;
    if (typeof user !== 'string' || user === '') throw new HttpError(400, 'missing_user', 'Say which user: "user" is required.');
    if (!deps.users.includes(user)) {
      throw new HttpError(404, 'unknown_user', `No Gemini account is connected for user "${user}". Connected: ${deps.users.join(', ') || 'none'}.`);
    }
    return user;
  };
  const text = (v: unknown, name: string): string => {
    if (typeof v !== 'string' || v.trim() === '') throw new HttpError(400, 'missing_field', `"${name}" is required.`);
    return v.trim();
  };
  const stakeOf = (v: unknown): number => {
    const stake = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof stake !== 'number' || !Number.isFinite(stake) || stake <= 0) {
      throw new HttpError(400, 'invalid_stake', '"stake" must be a positive dollar amount.');
    }
    if (stake > 100_000) throw new HttpError(400, 'invalid_stake', '"stake" is too large.');
    if (deps.maxStake !== undefined && stake > deps.maxStake) {
      throw new HttpError(400, 'stake_too_large', `Bets are capped at $${deps.maxStake} on this demo.`);
    }
    return stake;
  };
  const getEvent = async (ticker: string): Promise<GeminiEvent> => {
    try {
      return await deps.markets.getEvent(ticker);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 || /unknown event/.test(String((err as Error).message))) {
        throw new HttpError(404, 'unknown_event', `Gemini has no event "${ticker}".`);
      }
      throw err;
    }
  };

  function eventView(event: GeminiEvent, includeRefused: boolean) {
    const rungs = ladder(event);
    const pairs = linkedPairs(event, pairOpts);
    const refusedByReason: Record<string, number> = {};
    for (const p of pairs) {
      if (p.offer.offerable) continue;
      for (const r of p.offer.reasons) refusedByReason[r.code] = (refusedByReason[r.code] ?? 0) + 1;
    }
    const offerable = pairs.filter((p) => p.offer.offerable);
    return {
      ticker: event.ticker,
      title: event.title,
      category: event.category,
      expiry: event.expiryDate ?? null,
      rungs: rungs.map(rungView),
      ladderOutOfOrder: ladderInversions(rungs).length > 0,
      pairs: (includeRefused ? pairs : offerable).map(pairView),
      offerableCount: offerable.length,
      refusedCount: pairs.length - offerable.length,
      refusedByReason,
    };
  }

  let marketsCache: { at: number; events: GeminiEvent[]; fingerprint: string } | null = null;
  let marketsLoading: Promise<GeminiEvent[]> | null = null;

  /** Reads the whole market list once (shared by everyone who asks while it runs) and tells watchers if anything changed. */
  function refreshMarkets(): Promise<GeminiEvent[]> {
    marketsLoading ??= (async () => {
      try {
        const listed = await deps.markets.listEvents();
        const withLadder = listed.filter((e) => e.contracts.filter((c) => c.strike?.type === 'above').length >= 2);
        // The list can lag by a minute after a market opens, so each ladder is re-read from the single-event endpoint.
        const fresh = await inBatches(withLadder, 8, (e) => deps.markets.getEvent(e.ticker).catch(() => null));
        const events = fresh.filter((e): e is GeminiEvent => e !== null);
        const fingerprint = deps.live ? createHash('sha1').update(JSON.stringify(events)).digest('base64url') : '';
        const changed = marketsCache !== null && marketsCache.fingerprint !== fingerprint;
        marketsCache = { at: now().getTime(), events, fingerprint };
        if (changed) deps.live?.publish('markets');
        return events;
      } finally {
        marketsLoading = null;
      }
    })();
    return marketsLoading;
  }

  async function ladderEvents(): Promise<GeminiEvent[]> {
    const ttl = deps.marketsCacheMs ?? 5000;
    const age = marketsCache ? now().getTime() - marketsCache.at : Infinity;
    if (marketsCache && age < ttl) return marketsCache.events;
    // Stale-while-revalidate: an answer that is a little old is served at once and refreshed behind the caller's back.
    if (marketsCache && ttl > 0 && age < (deps.staleMarketsMs ?? 60_000)) {
      void refreshMarkets().catch((err: unknown) => console.error(`[executor] market refresh failed: ${err instanceof Error ? err.message : String(err)}`));
      return marketsCache.events;
    }
    return refreshMarkets();
  }

  const offerRule = () => ({
    productionFeeCoef: PRODUCTION_TAKER_FEE_COEF,
    maxAllInPrice: MAX_ALL_IN_PRICE,
    refuseMarkupDollars: REFUSE_MARKUP_DOLLARS,
    refuseMarkupFraction: REFUSE_MARKUP_FRACTION,
    warnMarkupDollars: WARN_MARKUP_DOLLARS,
    warnMarkupFraction: WARN_MARKUP_FRACTION,
    markupWaivedForSandboxDemo: deps.waiveMarkup,
  });

  // ------------------------------------------------------------------ routes

  async function health() {
    return {
      ok: true,
      service: 'given-executor',
      venue,
      sandbox: deps.isSandbox,
      readOnly: deps.readOnly === true,
      seeded: deps.seeded === true,
      users: deps.users.map((user) => ({ user, connected: deps.isConnected ? deps.isConnected(user) : null })),
      feeCoefCharged: deps.feeCoef,
      streams: deps.live ? deps.live.count() : null,
      offerRule: offerRule(),
      time: now().toISOString(),
    };
  }

  async function markets(q: URLSearchParams) {
    const includeRefused = q.get('include') === 'refused';
    const one = q.get('event');
    const events = one ? [await getEvent(one)] : await ladderEvents();
    const views = events.map((e) => eventView(e, includeRefused));
    return {
      venue,
      asOf: now().toISOString(),
      feeCoefCharged: deps.feeCoef,
      offerRule: offerRule(),
      totals: {
        events: views.length,
        eventsWithOffers: views.filter((v) => v.offerableCount > 0).length,
        offerable: views.reduce((n, v) => n + v.offerableCount, 0),
        refused: views.reduce((n, v) => n + v.refusedCount, 0),
      },
      events: views,
    };
  }

  // Identical quote requests share one answer: each costs two live order-book reads, and many pages look at the same pair.
  const quotesInFlight = new Map<string, { at: number; promise: Promise<unknown> }>();
  function quote(q: URLSearchParams): Promise<unknown> {
    const key = [...q.entries()].sort().map(([k, v]) => `${k}=${v}`).join('&');
    const ttl = deps.quoteCacheMs ?? 0;
    const hit = quotesInFlight.get(key);
    if (hit && (hit.at === 0 || now().getTime() - hit.at < ttl)) return hit.promise;
    const promise = quoteNow(q);
    const entry = { at: 0, promise };
    quotesInFlight.set(key, entry);
    const finish = (ok: boolean) => {
      if (!ok || ttl <= 0) quotesInFlight.delete(key); // a failure is never reused; with no TTL only simultaneous callers share
      else entry.at = now().getTime();
      if (quotesInFlight.size > 200) for (const [k, e] of quotesInFlight) if (e.at !== 0 && now().getTime() - e.at >= ttl) quotesInFlight.delete(k);
    };
    // A quote whose book read failed still resolves (with depth.unavailable); it is degraded, so it is never reused either.
    promise.then(
      (r) => finish(!((r as { depth?: { unavailable?: unknown } } | null)?.depth && 'unavailable' in (r as { depth: object }).depth)),
      () => finish(false),
    );
    return promise;
  }

  async function quoteNow(q: URLSearchParams) {
    const eventTicker = text(q.get('event'), 'event');
    const conditionSymbol = text(q.get('condition'), 'condition');
    const targetSymbol = text(q.get('target'), 'target');
    const stake = q.get('stake') === null ? null : stakeOf(q.get('stake'));
    const event = await getEvent(eventTicker);
    let pair: LinkedPair;
    try {
      pair = findPair(event, conditionSymbol, targetSymbol, deps.feeCoef, deps.waiveMarkup);
    } catch (err) {
      throw new HttpError(400, 'not_a_linked_pair', (err as Error).message);
    }

    const body: Record<string, unknown> = {
      venue,
      asOf: now().toISOString(),
      event: { ticker: event.ticker, title: event.title, expiry: event.expiryDate ?? null },
      ...pairView(pair),
      stake: null,
      depth: null,
    };

    const price = pair.conditionalPrice;
    if (stake !== null && price !== null && pair.a.bid !== null && pair.b.ask !== null) {
      const wanted = floorToStep(stake / price);
      let quantity = wanted;
      // Depth is read through a user's exchange session; without one the quote still answers, just without a size limit.
      const user = q.get('user') ?? deps.users[0];
      if (user !== undefined && deps.users.includes(user)) {
        try {
          const exchange = deps.exchangeFor(user);
          const [depthA, depthB] = await Promise.all([exchange.topOfBook(pair.a.symbol), exchange.topOfBook(pair.b.symbol)]);
          const outcomeAvailable = depthB.ask !== null && depthB.ask <= pair.b.ask + 1e-9 ? (depthB.askSize ?? 0) : 0;
          const conditionAvailable = depthA.bid !== null && depthA.bid >= pair.a.bid - 1e-9 ? (depthA.bidSize ?? 0) : 0;
          const most = capToDepth(Number.MAX_SAFE_INTEGER, pair.b.ask, pair.a.bid, deps.feeCoef, outcomeAvailable, conditionAvailable);
          quantity = Math.min(wanted, most);
          body.depth = {
            outcomeAvailable,
            conditionAvailable,
            maxStake: Math.round(planForQuantity(most, pair.b.ask, pair.a.bid, deps.feeCoef).cost * 100) / 100,
          };
        } catch (err) {
          body.depth = { unavailable: err instanceof Error ? err.message : String(err) };
        }
      }
      const plan = planForQuantity(quantity, pair.b.ask, pair.a.bid, deps.feeCoef);
      body.stake = {
        requested: stake,
        reduced: quantity < wanted - 1e-9,
        ...plan,
        cost: Math.round(plan.cost * 100) / 100,
        cashOutNow:
          pair.offer.cashOutPer100 === null ? null : Math.round(((pair.offer.cashOutPer100 * plan.cost) / 100) * 100) / 100,
      };
    }
    return body;
  }

  async function placeBet(body: Record<string, unknown>) {
    if (deps.isPaused?.()) throw new HttpError(503, 'paused', 'Betting is paused for a moment. Try again soon.');
    const user = requireUser(body.user);
    const request = {
      user,
      eventTicker: text(body.event, 'event'),
      conditionSymbol: text(body.condition, 'condition'),
      targetSymbol: text(body.target, 'target'),
      stake: stakeOf(body.stake),
      maxPrice: body.maxPrice === undefined || body.maxPrice === null ? undefined : Number(body.maxPrice),
      slippageTicks: body.slippageTicks === undefined || body.slippageTicks === null ? undefined : Number(body.slippageTicks),
      onHedgeFail: body.onHedgeFail === 'leave' ? ('leave' as const) : ('unwind' as const),
    };
    if (request.maxPrice !== undefined && !(request.maxPrice > 0 && request.maxPrice < 1)) {
      throw new HttpError(400, 'invalid_max_price', '"maxPrice" must be between 0 and 1.');
    }
    if (request.slippageTicks !== undefined && !(Number.isInteger(request.slippageTicks) && request.slippageTicks >= 0 && request.slippageTicks <= 10)) {
      throw new HttpError(400, 'invalid_slippage', '"slippageTicks" must be a whole number from 0 to 10.');
    }
    await getEvent(request.eventTicker); // a clear 404 for an unknown event, before anything else
    return queued(user, async () => {
      const d = betDeps(user);
      await ensureBaseline(d.exchange, deps.ledger, user, now);
      try {
        const bet = await placeConditionalBet(d, request);
        return { status: 201, body: { bet: betView(bet), stakeReduced: bet.stakeReduced ?? null } };
      } catch (err) {
        if (err instanceof BetRefused) {
          throw new HttpError(422, err.code, err.message, { refused: true, quote: err.quote ?? null });
        }
        if (err instanceof Error && /not a linked pair/.test(err.message)) throw new HttpError(400, 'not_a_linked_pair', err.message);
        throw err;
      }
    });
  }

  async function listBets(q: URLSearchParams) {
    const user = deps.pinnedUser ?? q.get('user');
    if (user !== null) requireUser(user);
    const bets = deps.ledger.data.bets.filter((b) => user === null || b.user === user);
    return { venue, user, count: bets.length, bets: bets.map(betView).reverse() }; // newest first
  }

  async function settle() {
    const user = deps.users[0];
    if (user === undefined) throw new HttpError(503, 'no_account', 'No Gemini account is connected, so results cannot be read.');
    return queued('settle', async () => {
      const done = await settleBets(betDeps(user));
      return {
        settled: done.settled.map(betView),
        needsReview: done.needsReview.map(betView),
        stillOpen: deps.ledger.data.bets.filter((b) => b.status === 'open' || b.status === 'unhedged').length,
      };
    });
  }

  async function flow(q: URLSearchParams) {
    const user = deps.pinnedUser ?? q.get('user');
    if (user !== null) requireUser(user);
    return {
      venue,
      user,
      ...flowTotals(deps.ledger, user ?? undefined),
      productionFeeCoef: PRODUCTION_TAKER_FEE_COEF,
      note: deps.venueName
        ? `These orders ran on ${deps.venueName}, not on Gemini. The fee figure is what the same fills would pay at Gemini's published taker rate.`
        : deps.isSandbox
          ? 'These orders ran on the Gemini sandbox, which charges no fees. The fee figure is what the same fills would pay at Gemini\'s published taker rate.'
          : 'feesAtProductionRates uses Gemini\'s published taker rate.',
    };
  }

  /** Ledger versus Gemini: every recorded order found, and cash tied out. Queued so it never overlaps a bet. */
  async function reconcileRoute(q: URLSearchParams) {
    const asked = q.get('user');
    const user = deps.pinnedUser ?? (asked !== null ? requireUser(asked) : deps.users[0]);
    if (user === undefined) throw new HttpError(503, 'no_account', 'No Gemini account is connected, so nothing can be checked.');
    return queued(user, async () => {
      const d = betDeps(user);
      await ensureBaseline(d.exchange, deps.ledger, user, now);
      const report = await reconcile(d.exchange, deps.ledger, user);
      const checked = deps.ledger.legs(user).filter((l) => l.status !== 'error').length;
      return { venue, checkedAt: now().toISOString(), ordersChecked: checked, ordersMatched: Math.max(0, checked - report.mismatches.length), ...report };
    });
  }

  const refuseIfReadOnly = (): void => {
    if (deps.readOnly) throw new HttpError(403, 'read_only', 'Quotes only: no Gemini API keys are connected, so bets are switched off. Add sandbox keys to .env and restart.');
  };

  // Per-client limiter for the routes that spend money or hit Gemini hard.
  const limiter = createLimiter(deps.rateLimit, () => now().getTime());
  const limited = (req: IncomingMessage): boolean => {
    const fwd = deps.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
    return limiter.limited(fwd || req.socket.remoteAddress || 'unknown');
  };

  // ---------------------------------------------------------------- live updates
  const streamsByClient = new Map<string, number>();
  const TOPICS = new Set(['markets', 'bets']);
  function openStream(req: IncomingMessage, res: ServerResponse, headers: Record<string, string>, url: URL): void {
    if (!deps.live) throw new HttpError(404, 'not_available', 'Live updates are not enabled on this server.');
    const asked = (url.searchParams.get('topics') ?? 'markets,bets').split(',').map((t) => t.trim()).filter((t) => TOPICS.has(t));
    if (asked.length === 0) throw new HttpError(400, 'unknown_topic', `Choose topics from: ${[...TOPICS].join(', ')}.`);
    const fwd = deps.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
    const who = fwd || req.socket.remoteAddress || 'unknown';
    if ((streamsByClient.get(who) ?? 0) >= (deps.maxStreamsPerClient ?? 8)) throw new HttpError(429, 'too_many_streams', 'Too many open live connections from this address.');
    if (!deps.live.subscribe(req, res, headers, new Set(asked))) throw new HttpError(503, 'streams_full', 'The server is at its limit of live connections. Updates will arrive by refresh instead.');
    streamsByClient.set(who, (streamsByClient.get(who) ?? 0) + 1);
    res.on('close', () => {
      const left = (streamsByClient.get(who) ?? 1) - 1;
      if (left <= 0) streamsByClient.delete(who);
      else streamsByClient.set(who, left);
    });
  }

  /** A 200 GET answer with a validator, so an unchanged answer is a 304 and a large one travels gzipped. */
  function sendCached(req: IncomingMessage, res: ServerResponse, headers: Record<string, string>, body: object): void {
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
  }

  // The market list is only re-read in the background while someone is watching it; idle servers do not poll Gemini.
  let refresher: NodeJS.Timeout | undefined;
  const unwatch = deps.live?.onWatch((topic, watching) => {
    if (topic !== 'markets') return;
    if (!watching) {
      if (refresher) clearInterval(refresher);
      refresher = undefined;
      return;
    }
    if (refresher) return;
    refresher = setInterval(() => void refreshMarkets().catch(() => undefined), deps.refreshMs ?? 3000);
    refresher.unref();
  });

  // Finished bets are settled by themselves, so a bet flips to settled on the page when its event closes.
  let autoSettle: NodeJS.Timeout | undefined;
  if (deps.autoSettleMs && deps.autoSettleMs > 0 && !deps.readOnly) {
    autoSettle = setInterval(() => {
      if (!deps.ledger.data.bets.some((b) => b.status === 'open' || b.status === 'unhedged')) return;
      settle().then(
        (done) => (done.settled.length > 0 || done.needsReview.length > 0) && deps.live?.publish('bets'),
        (err: unknown) => console.error(`[executor] auto-settle failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, deps.autoSettleMs);
    autoSettle.unref();
  }

  const routes: Record<string, Partial<Record<'GET' | 'POST', (q: URLSearchParams, req: IncomingMessage) => Promise<unknown>>>> = {
    '/health': { GET: () => health() },
    '/markets': { GET: (q) => markets(q) },
    '/quote': { GET: (q) => quote(q) },
    '/bets': {
      GET: (q) => listBets(q),
      POST: async (_q, req) => {
        refuseIfReadOnly();
        try {
          return await placeBet(await readJson(req));
        } finally {
          deps.live?.publish('bets'); // a bet that failed part-way is recorded too, so tell watchers either way
        }
      },
    },
    '/settle': {
      POST: async () => {
        refuseIfReadOnly();
        const done = await settle();
        if (done.settled.length > 0 || done.needsReview.length > 0) deps.live?.publish('bets');
        return done;
      },
    },
    // Not a public route: the hosted server's allowlist (scripts/lib/edge.mjs) does not forward it, and it does nothing
    // without GIVEN_ADMIN_TOKEN. It records what Gemini actually paid for a bet it settled without a clean result.
    '/review': {
      POST: async (_q, req) => {
        if (!deps.adminToken) throw new HttpError(404, 'not_enabled', 'Recording a payout by hand is switched off. Set GIVEN_ADMIN_TOKEN to enable it.');
        const given = String(req.headers['x-admin-token'] ?? '');
        const ok = given.length === deps.adminToken.length && timingSafeEqual(Buffer.from(given), Buffer.from(deps.adminToken));
        if (!ok) throw new HttpError(401, 'unauthorized', 'Admin token required.');
        const body = await readJson(req);
        const owner = deps.ledger.data.bets.find((b) => b.id === body.betId)?.user ?? 'review';
        // Queued with that account's bets, so it never lands in the middle of one.
        const bet = await queued(owner, async () => {
          try {
            return recordReviewedPayout(deps.ledger, String(body.betId ?? ''), body.payout as number, body.note as string, now);
          } catch (err) {
            if (err instanceof ReviewError) throw new HttpError(err.code === 'unknown_bet' ? 404 : err.code === 'not_in_review' ? 409 : 400, err.code, err.message);
            throw err;
          }
        });
        deps.live?.publish('bets');
        return betView(bet);
      },
    },
    '/flow': { GET: (q) => flow(q) },
    '/reconcile': { GET: async (q) => (refuseIfReadOnly(), reconcileRoute(q)) },
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
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
        // A web page on another site must not be able to place bets through the user's local server.
        if (!allowed) throw new HttpError(403, 'origin_not_allowed', `Requests from ${origin} are not allowed.`);
        if (req.method === 'OPTIONS') return send(204, null);

        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname.replace(/\/+$/, '') || '/';
        if (path === '/stream' && req.method === 'GET') return openStream(req, res, headers, url);
        const route = routes[path];
        if (!route) throw new HttpError(404, 'not_found', `No such endpoint: ${path}. Try /health, /markets, /quote, /bets, /settle, /flow or /reconcile.`);
        const handler = route[req.method as 'GET' | 'POST'];
        if (!handler) {
          headers.Allow = Object.keys(route).join(', ');
          throw new HttpError(405, 'method_not_allowed', `${path} accepts ${Object.keys(route).join(' or ')}, not ${req.method}.`);
        }
        if (req.method === 'POST' && limited(req)) {
          headers['Retry-After'] = String(Math.ceil((deps.rateLimit?.windowMs ?? 60_000) / 1000));
          throw new HttpError(429, 'rate_limited', 'Too many requests. Wait a minute and try again.');
        }
        const result = await handler(url.searchParams, req);
        if (result !== null && typeof result === 'object' && 'status' in result && 'body' in result) {
          return send((result as { status: number }).status, (result as { body: unknown }).body);
        }
        if (req.method === 'GET' && result !== null && typeof result === 'object') return sendCached(req, res, headers, result);
        send(200, result);
      } catch (err) {
        if (err instanceof HttpError) return send(err.status, { error: err.message, code: err.code, ...err.extra });
        const message = err instanceof Error ? err.message : String(err);
        // Anything else came from Gemini or the network; say so plainly and never leak a stack trace.
        const fromGemini = /Gemini|WebSocket|fetch failed|timed out|aborted/i.test(message);
        send(fromGemini ? 502 : 500, { error: message, code: fromGemini ? 'gemini_error' : 'internal_error' });
      }
    })();
  };
  return Object.assign(handler, {
    close(): void {
      if (refresher) clearInterval(refresher);
      if (autoSettle) clearInterval(autoSettle);
      unwatch?.();
    },
  });
}
