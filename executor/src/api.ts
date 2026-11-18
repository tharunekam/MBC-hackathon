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
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BetRefused, isScorable, placeConditionalBet, settleBets } from './bets.ts';
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
import { createLimiter } from './limiter.ts';
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
  /** Extra allowed browser origins besides localhost. */
  corsOrigins?: string[];
  /** How long a /markets answer is reused, in ms. Default 5000. */
  marketsCacheMs?: number;
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
export function createApi(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => void {
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

  let marketsCache: { at: number; events: GeminiEvent[] } | null = null;
  let marketsLoading: Promise<GeminiEvent[]> | null = null;
  async function ladderEvents(): Promise<GeminiEvent[]> {
    const ttl = deps.marketsCacheMs ?? 5000;
    if (marketsCache && now().getTime() - marketsCache.at < ttl) return marketsCache.events;
    marketsLoading ??= (async () => {
      try {
        const listed = await deps.markets.listEvents();
        const withLadder = listed.filter((e) => e.contracts.filter((c) => c.strike?.type === 'above').length >= 2);
        // The list can lag by a minute after a market opens, so each ladder is re-read from the single-event endpoint.
        const fresh = await inBatches(withLadder, 8, (e) => deps.markets.getEvent(e.ticker).catch(() => null));
        const events = fresh.filter((e): e is GeminiEvent => e !== null);
        marketsCache = { at: now().getTime(), events };
        return events;
      } finally {
        marketsLoading = null;
      }
    })();
    return marketsLoading;
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
      users: deps.users.map((user) => ({ user, connected: deps.isConnected ? deps.isConnected(user) : null })),
      feeCoefCharged: deps.feeCoef,
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

  async function quote(q: URLSearchParams) {
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
        ? `These orders ran on ${deps.venueName}, not on Gemini. feesAtProductionRates is what the same fills would pay at Gemini's published taker rate.`
        : deps.isSandbox
          ? 'These orders ran on the Gemini sandbox, which charges no fees. feesAtProductionRates is what the same fills would pay at Gemini\'s published taker rate.'
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

  const routes: Record<string, Partial<Record<'GET' | 'POST', (q: URLSearchParams, req: IncomingMessage) => Promise<unknown>>>> = {
    '/health': { GET: () => health() },
    '/markets': { GET: (q) => markets(q) },
    '/quote': { GET: (q) => quote(q) },
    '/bets': { GET: (q) => listBets(q), POST: async (_q, req) => (refuseIfReadOnly(), placeBet(await readJson(req))) },
    '/settle': { POST: async () => (refuseIfReadOnly(), settle()) },
    '/flow': { GET: (q) => flow(q) },
    '/reconcile': { GET: async (q) => (refuseIfReadOnly(), reconcileRoute(q)) },
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
        // A web page on another site must not be able to place bets through the user's local server.
        if (!allowed) throw new HttpError(403, 'origin_not_allowed', `Requests from ${origin} are not allowed.`);
        if (req.method === 'OPTIONS') return send(204, null);

        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname.replace(/\/+$/, '') || '/';
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
}
