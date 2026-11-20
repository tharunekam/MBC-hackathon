/**
 * The HTTP API the frontend talks to. This file holds the request handling and
 * nothing about sockets or credentials, so the tests can run it against the
 * in-memory exchange. `server.ts` wires it to Gemini.
 *
 *   GET  /health
 *   GET  /markets[?event=TICKER][&include=refused]
 *   GET  /quote?event=&condition=&target=&stake=[&direction=down][&user=]      a parlay
 *   GET  /quote?product=range&event=&low=&high=&stake=[&user=]                 a range
 *   GET  /quote?product=breakout&event=&low=&high=&stake=[&user=]              a breakout (the range's opposite)
 *   POST /bets            {user, event, condition, target, stake, direction?, maxPrice?, slippageTicks?, onHedgeFail?}
 *   POST /bets            {product: "range" | "breakout", user, event, low, high, stake, maxPrice?, slippageTicks?}
 *   POST /baskets         {user, name?, legs: [{product, event, condition, target | low, high, stake, direction?, maxPrice?}]}
 *                         Both POSTs take an optional "requestId" (8 to 64 of A-Z a-z 0-9 _ -). Sent again, it answers with the
 *                         bet (or basket) it placed the first time, 200 and "repeated": true, and places nothing. Sent again for
 *                         a different request (another product, market, levels, direction or stake) it answers 409
 *                         "request_id_reused". "maxPrice", slippage, "onHedgeFail" and a basket's name do not count as different.
 *   GET  /bets[?user=]
 *   GET  /cashout?bet=ID                                     what selling an open bet back would bring in now
 *   POST /cashout         {bet, minProceeds?, slippageTicks?}   sell it back: two sell orders. 409 "sale_unconfirmed" when the first sell
 *                         may have gone through (the bet is held as unhedged and nothing more is sent)
 *   POST /settle
 *   GET  /flow[?user=]
 *   GET  /reconcile[?user=]
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BasketRefused, MAX_BASKET_LEGS, MIN_BASKET_LEGS, placeBasket } from './basket.ts';
import type { BasketLeg } from './basket.ts';
import { BetRefused, ReviewError, hasUnresolvedLeg, holdInterrupted, isScorable, logUnreadableBook, placeConditionalBet, recheckUnresolved, recordReviewedPayout, settleBets } from './bets.ts';
import { CashOutRefused, cashOutBet, quoteCashOut } from './cashout.ts';
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
  DEFAULT_SLIP,
  capToDepth,
  contractsForStake,
  ladderInversions,
  planForQuantity,
} from './offer.ts';
import { isDirection, viewFor } from './mirror.ts';
import type { Direction } from './mirror.ts';
import { findPair, ladder, linkedPairs, realRung } from './pairs.ts';
import type { LinkedPair, Rung } from './pairs.ts';
import type { RangePair } from './range.ts';
import type { BreakoutPair } from './breakout.ts';
import { capBreakoutToDepth, findBreakout, planBreakout, breakoutContractsFor } from './breakout.ts';
import { placeBreakoutBet } from './breakout-bet.ts';
import { floorToStep } from './pricing.ts';
import { capRangeToDepth, findRange, planRange, rangeContractsFor } from './range.ts';
import { placeRangeBet } from './range-bet.ts';
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
  /** Milliseconds to wait before each look-up of an order whose answer was lost (see sendLeg). Tests shorten it. */
  orderLookupWaitsMs?: number[];
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
/** A pair as the reader knows it. For a falling bet the pair was found on the mirror of the ladder, so its rungs are turned back. */
const pairView = (p: LinkedPair, direction?: Direction) => {
  const a = realRung(p.a, direction);
  const b = realRung(p.b, direction);
  return {
    condition: { symbol: a.symbol, label: a.label, strike: a.strike, bid: a.bid, ask: a.ask },
    target: { symbol: b.symbol, label: b.label, strike: b.strike, bid: b.bid, ask: b.ask },
    quote: p.offer,
  };
};
const legView = (r: Rung) => ({ symbol: r.symbol, label: r.label, strike: r.strike, bid: r.bid, ask: r.ask });
const betView = (bet: BetRecord) => {
  const { requestKey: _kept, ...shown } = bet; // the fingerprint is for repeat checks only
  return { ...shown, scorable: isScorable(bet), flow: betFlow(bet) };
};

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
    lookupWaitsMs: deps.orderLookupWaitsMs,
  });

  // A safeguard that was set to something that is not a usable number would silently switch itself off (every comparison
  // with NaN is false), so refuse to start instead.
  if (deps.maxStake !== undefined && !(Number.isFinite(deps.maxStake) && deps.maxStake > 0)) {
    throw new Error(`maxStake must be a number of dollars above 0, got ${String(deps.maxStake)}.`);
  }
  if (deps.rateLimit !== undefined && !(Number.isFinite(deps.rateLimit.max) && deps.rateLimit.max > 0 && Number.isFinite(deps.rateLimit.windowMs) && deps.rateLimit.windowMs > 0)) {
    throw new Error(`rateLimit needs a max and a windowMs above 0, got ${JSON.stringify(deps.rateLimit)}.`);
  }
  if (!Number.isFinite(deps.feeCoef) || deps.feeCoef < 0) throw new Error(`feeCoef must be a number of 0 or more, got ${String(deps.feeCoef)}.`);

  // One bet (or settle) at a time per user: orders for the same account never interleave.
  const queues = new Map<string, Promise<unknown>>();
  const queued = <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).then(job, job);
    queues.set(key, next.catch(() => undefined));
    return next;
  };

  /** The kill switch. Checked when a request arrives and again when its turn in the queue comes, so a pause stops bets already waiting. */
  const refuseIfPaused = (): void => {
    if (deps.isPaused?.()) throw new HttpError(503, 'paused', 'Betting is paused for a moment. Try again soon.');
  };

  /** The optional "requestId" that makes a POST safe to repeat. */
  const requestIdOf = (v: unknown): string | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) {
      throw new HttpError(400, 'bad_request_id', '"requestId" must be 8 to 64 letters, digits, "_" or "-".');
    }
    return v;
  };
  /** The bet a request id already placed for this user (a bet that came in a basket is that basket's, not a bet request's). */
  const betForRequest = (user: string, requestId: string | undefined): BetRecord | undefined =>
    requestId === undefined ? undefined : deps.ledger.data.bets.find((b) => b.user === user && b.clientRequestId === requestId && !b.basket);
  const basketForRequest = (user: string, requestId: string | undefined) =>
    requestId === undefined ? undefined : Object.values(deps.ledger.data.baskets ?? {}).find((b) => b.user === user && b.clientRequestId === requestId);

  // What makes a request "the same" is what the person chose: the product, the market, the two levels, the direction and the
  // stake to the cent. The price limit, the slippage, what to do if the hedge fails and a basket's name are not choices.
  const choiceOf = (product: string, event: string, first: string, second: string, direction: string, stake: number): unknown[] =>
    [product, event, first, second, direction, Math.round(stake * 100)];
  const requestKeyOf = (choices: unknown[][]): string => createHash('sha256').update(JSON.stringify(choices)).digest('hex').slice(0, 16);
  const idReused = () => new HttpError(409, 'request_id_reused', 'That request id was already used for a different request. Send a new request id for a new bet.');
  /** The answer to a repeat of a bet's request: the bet itself, unless the id now stands for another choice. */
  const repeatOfBet = (prior: BetRecord, key: string | undefined) => {
    // A bet recorded before fingerprints existed has nothing to compare, so a repeat of its id is taken as the same request.
    if (prior.requestKey !== undefined && prior.requestKey !== key) throw idReused();
    return { status: 200, body: { bet: betView(prior), stakeReduced: prior.stakeReduced ?? null, repeated: true } };
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
    // A string is a plain dollar amount ("12", "12.5"), not what Number() would also read: "0x10", "+5", "2e0".
    const stake = typeof v === 'string' && /^(\d+\.?\d*|\.\d+)$/.test(v.trim()) ? Number(v) : typeof v === 'string' ? NaN : v;
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
    const fallingPairs = linkedPairs(event, { ...pairOpts, direction: 'down' });
    const fallingOfferable = fallingPairs.filter((p) => p.offer.offerable);
    return {
      ticker: event.ticker,
      title: event.title,
      category: event.category,
      expiry: event.expiryDate ?? null,
      rungs: rungs.map(rungView),
      ladderOutOfOrder: ladderInversions(rungs).length > 0,
      pairs: (includeRefused ? pairs : offerable).map((p) => pairView(p)),
      offerableCount: offerable.length,
      refusedCount: pairs.length - offerable.length,
      refusedByReason,
      /** The same for a bet that a price falls: the condition is the higher strike and the outcome the lower. */
      down: {
        pairs: (includeRefused ? fallingPairs : fallingOfferable).map((p) => pairView(p, 'down')),
        offerableCount: fallingOfferable.length,
        refusedCount: fallingPairs.length - fallingOfferable.length,
      },
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
      // The most one bet may stake here (the hosted demo sets one), so a page can say so before it is refused.
      maxStake: deps.maxStake ?? null,
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

  /** Which product and which way a request is for. */
  const productOf = (v: unknown): 'parlay' | 'range' | 'breakout' => {
    if (v === undefined || v === null || v === '' || v === 'parlay') return 'parlay';
    if (v === 'range' || v === 'breakout') return v;
    throw new HttpError(400, 'invalid_product', '"product" must be "parlay", "range" or "breakout".');
  };
  const directionOf = (v: unknown): Direction => {
    if (v === undefined || v === null || v === '') return 'up';
    if (isDirection(v)) return v;
    throw new HttpError(400, 'invalid_direction', '"direction" must be "up" or "down".');
  };

  /** The depth of the two legs of a quote, read through a user's exchange session; without one the quote still answers. */
  const quoteUser = (q: URLSearchParams): string | undefined => {
    const user = q.get('user') ?? deps.users[0];
    return user !== undefined && deps.users.includes(user) ? user : undefined;
  };

  /** A quote whose order books could not be read says so in its own words; the exchange's text goes to the log. */
  const depthUnavailable = (err: unknown) => {
    logUnreadableBook(err);
    return { unavailable: 'The live order book could not be read just now.' };
  };

  async function quoteNow(q: URLSearchParams) {
    const product = productOf(q.get('product'));
    if (product === 'range') return quoteRange(q);
    if (product === 'breakout') return quoteBreakout(q);
    const eventTicker = text(q.get('event'), 'event');
    const conditionSymbol = text(q.get('condition'), 'condition');
    const targetSymbol = text(q.get('target'), 'target');
    const direction = directionOf(q.get('direction'));
    const stake = q.get('stake') === null ? null : stakeOf(q.get('stake'));
    const event = await getEvent(eventTicker);
    let pair: LinkedPair;
    try {
      pair = findPair(event, conditionSymbol, targetSymbol, deps.feeCoef, deps.waiveMarkup, direction);
    } catch (err) {
      throw new HttpError(400, 'not_a_linked_pair', (err as Error).message);
    }

    const body: Record<string, unknown> = {
      venue,
      asOf: now().toISOString(),
      product: 'parlay',
      direction,
      event: { ticker: event.ticker, title: event.title, expiry: event.expiryDate ?? null },
      ...pairView(pair, direction),
      stake: null,
      depth: null,
    };

    const price = pair.conditionalPrice;
    if (stake !== null && price !== null && pair.a.bid !== null && pair.b.ask !== null) {
      // A quote is for the bet as it will be placed: the web app sends no slippage of its own, so the default applies.
      const wanted = contractsForStake(stake, pair.b.ask, pair.a.bid, deps.feeCoef, DEFAULT_SLIP);
      let quantity = wanted;
      // Depth is read through a user's exchange session; without one the quote still answers, just without a size limit.
      const user = quoteUser(q);
      if (user !== undefined) {
        try {
          const exchange = viewFor(deps.exchangeFor(user), direction);
          const [depthA, depthB] = await Promise.all([exchange.topOfBook(pair.a.symbol), exchange.topOfBook(pair.b.symbol)]);
          const outcomeAvailable = depthB.ask !== null && depthB.ask <= pair.b.ask + 1e-9 ? (depthB.askSize ?? 0) : 0;
          const conditionAvailable = depthA.bid !== null && depthA.bid >= pair.a.bid - 1e-9 ? (depthA.bidSize ?? 0) : 0;
          const most = capToDepth(Number.MAX_SAFE_INTEGER, pair.b.ask, pair.a.bid, deps.feeCoef, outcomeAvailable, conditionAvailable, DEFAULT_SLIP);
          quantity = Math.min(wanted, most);
          body.depth = {
            outcomeAvailable,
            conditionAvailable,
            maxStake: Math.round(planForQuantity(most, pair.b.ask, pair.a.bid, deps.feeCoef, DEFAULT_SLIP).cost * 100) / 100,
          };
        } catch (err) {
          body.depth = depthUnavailable(err);
        }
      }
      const plan = planForQuantity(quantity, pair.b.ask, pair.a.bid, deps.feeCoef, DEFAULT_SLIP);
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

  async function quoteRange(q: URLSearchParams) {
    const eventTicker = text(q.get('event'), 'event');
    const lowSymbol = text(q.get('low'), 'low');
    const highSymbol = text(q.get('high'), 'high');
    const stake = q.get('stake') === null ? null : stakeOf(q.get('stake'));
    const event = await getEvent(eventTicker);
    let pair: RangePair;
    try {
      pair = findRange(event, lowSymbol, highSymbol, deps.feeCoef, deps.waiveMarkup);
    } catch (err) {
      throw new HttpError(400, 'not_a_range', (err as Error).message);
    }

    const body: Record<string, unknown> = {
      venue,
      asOf: now().toISOString(),
      product: 'range',
      event: { ticker: event.ticker, title: event.title, expiry: event.expiryDate ?? null },
      low: legView(pair.low),
      high: legView(pair.high),
      quote: pair.offer,
      stake: null,
      depth: null,
    };

    if (stake !== null && pair.price !== null && pair.low.ask !== null && pair.high.bid !== null) {
      const wanted = rangeContractsFor(stake, pair.low.ask, pair.high.bid, deps.feeCoef);
      let contracts = wanted;
      const user = quoteUser(q);
      if (user !== undefined) {
        try {
          const exchange = deps.exchangeFor(user);
          const [depthLow, depthHigh] = await Promise.all([exchange.topOfBook(pair.low.symbol), exchange.topOfBook(pair.high.symbol)]);
          const lowAvailable = depthLow.ask !== null && depthLow.ask <= pair.low.ask + 1e-9 ? (depthLow.askSize ?? 0) : 0;
          const highAvailable = depthHigh.bid !== null && depthHigh.bid >= pair.high.bid - 1e-9 ? (depthHigh.bidSize ?? 0) : 0;
          const most = capRangeToDepth(Number.MAX_SAFE_INTEGER, lowAvailable, highAvailable);
          contracts = Math.min(wanted, most);
          body.depth = {
            outcomeAvailable: lowAvailable,
            conditionAvailable: highAvailable,
            maxStake: Math.round(planRange(most, pair.low.ask, pair.high.bid, deps.feeCoef).cost * 100) / 100,
          };
        } catch (err) {
          body.depth = depthUnavailable(err);
        }
      }
      const plan = planRange(contracts, pair.low.ask, pair.high.bid, deps.feeCoef);
      body.stake = {
        requested: stake,
        reduced: contracts < wanted - 1e-9,
        ...plan,
        cost: Math.round(plan.cost * 100) / 100,
        cashOutNow: pair.offer.cashOutPer100 === null ? null : Math.round(((pair.offer.cashOutPer100 * plan.cost) / 100) * 100) / 100,
      };
    }
    return body;
  }

  /** The range's quote for the other two sides of the same two books: YES on the higher strike and NO on the lower. */
  async function quoteBreakout(q: URLSearchParams) {
    const eventTicker = text(q.get('event'), 'event');
    const lowSymbol = text(q.get('low'), 'low');
    const highSymbol = text(q.get('high'), 'high');
    const stake = q.get('stake') === null ? null : stakeOf(q.get('stake'));
    const event = await getEvent(eventTicker);
    let pair: BreakoutPair;
    try {
      pair = findBreakout(event, lowSymbol, highSymbol, deps.feeCoef, deps.waiveMarkup);
    } catch (err) {
      throw new HttpError(400, 'not_a_range', (err as Error).message);
    }

    const body: Record<string, unknown> = {
      venue,
      asOf: now().toISOString(),
      product: 'breakout',
      event: { ticker: event.ticker, title: event.title, expiry: event.expiryDate ?? null },
      low: legView(pair.low),
      high: legView(pair.high),
      quote: pair.offer,
      stake: null,
      depth: null,
    };

    if (stake !== null && pair.price !== null && pair.low.bid !== null && pair.high.ask !== null) {
      const wanted = breakoutContractsFor(stake, pair.low.bid, pair.high.ask, deps.feeCoef);
      let contracts = wanted;
      const user = quoteUser(q);
      if (user !== undefined) {
        try {
          const exchange = deps.exchangeFor(user);
          const [depthLow, depthHigh] = await Promise.all([exchange.topOfBook(pair.low.symbol), exchange.topOfBook(pair.high.symbol)]);
          const highAvailable = depthHigh.ask !== null && depthHigh.ask <= pair.high.ask + 1e-9 ? (depthHigh.askSize ?? 0) : 0;
          const lowAvailable = depthLow.bid !== null && depthLow.bid >= pair.low.bid - 1e-9 ? (depthLow.bidSize ?? 0) : 0;
          const most = capBreakoutToDepth(Number.MAX_SAFE_INTEGER, highAvailable, lowAvailable);
          contracts = Math.min(wanted, most);
          body.depth = {
            outcomeAvailable: highAvailable,
            conditionAvailable: lowAvailable,
            maxStake: Math.round(planBreakout(most, pair.low.bid, pair.high.ask, deps.feeCoef).cost * 100) / 100,
          };
        } catch (err) {
          body.depth = depthUnavailable(err);
        }
      }
      const plan = planBreakout(contracts, pair.low.bid, pair.high.ask, deps.feeCoef);
      body.stake = {
        requested: stake,
        reduced: contracts < wanted - 1e-9,
        ...plan,
        cost: Math.round(plan.cost * 100) / 100,
        cashOutNow: pair.offer.cashOutPer100 === null ? null : Math.round(((pair.offer.cashOutPer100 * plan.cost) / 100) * 100) / 100,
      };
    }
    return body;
  }

  /** Turns a refusal from placing a bet into the API's 422 answer. */
  function refusal(err: unknown): never {
    if (err instanceof BasketRefused) {
      throw new HttpError(422, err.code, err.message, { refused: true, leg: err.index, quote: err.quote ?? null });
    }
    if (err instanceof BetRefused) throw new HttpError(422, err.code, err.message, { refused: true, quote: err.quote ?? null });
    if (err instanceof Error && /not a linked pair/.test(err.message)) throw new HttpError(400, 'not_a_linked_pair', err.message);
    if (err instanceof Error && /not a range/.test(err.message)) throw new HttpError(400, 'not_a_range', err.message);
    throw err;
  }

  /**
   * An error that is not a refusal (a ledger write that failed, say) can leave the bet it came from "placing" for good, with an
   * order out and nothing to say what became of it. The bets this request added are put right: failed if no order went out,
   * otherwise held with the unknown note, so a repeat of the request is told the truth instead of "placing".
   */
  function holdUnfinished(d: ReturnType<typeof betDeps>, user: string, from: number): void {
    holdInterrupted(d, deps.ledger.data.bets.slice(from).filter((b) => b.user === user && b.status === 'placing'));
  }

  /** The price limit a bet or a basket leg may carry: the most it may cost per $1. */
  function maxPriceOf(v: unknown): number | undefined {
    const maxPrice = v === undefined || v === null ? undefined : Number(v);
    if (maxPrice !== undefined && !(maxPrice > 0 && maxPrice < 1)) {
      throw new HttpError(400, 'invalid_max_price', '"maxPrice" must be between 0 and 1.');
    }
    return maxPrice;
  }

  /** The numbers every bet request carries, whichever product it is for. */
  function limitsOf(body: Record<string, unknown>) {
    const maxPrice = maxPriceOf(body.maxPrice);
    const slippageTicks = body.slippageTicks === undefined || body.slippageTicks === null ? undefined : Number(body.slippageTicks);
    if (slippageTicks !== undefined && !(Number.isInteger(slippageTicks) && slippageTicks >= 0 && slippageTicks <= 10)) {
      throw new HttpError(400, 'invalid_slippage', '"slippageTicks" must be a whole number from 0 to 10.');
    }
    return { maxPrice, slippageTicks };
  }

  async function placeBet(body: Record<string, unknown>) {
    refuseIfPaused();
    const user = requireUser(body.user);
    const requestId = requestIdOf(body.requestId);
    const product = productOf(body.product);
    if (product === 'range' || product === 'breakout') return placeRange(user, body, product, requestId);
    const request = {
      user,
      eventTicker: text(body.event, 'event'),
      conditionSymbol: text(body.condition, 'condition'),
      targetSymbol: text(body.target, 'target'),
      direction: directionOf(body.direction),
      stake: stakeOf(body.stake),
      ...limitsOf(body),
      onHedgeFail: body.onHedgeFail === 'leave' ? ('leave' as const) : ('unwind' as const),
      ...(requestId ? { clientRequestId: requestId } : {}),
    };
    const requestKey = requestId
      ? requestKeyOf([choiceOf('parlay', request.eventTicker, request.conditionSymbol, request.targetSymbol, request.direction, request.stake)])
      : undefined;
    await getEvent(request.eventTicker); // a clear 404 for an unknown event, before anything else
    return queued(user, async () => {
      // Looked for here, in the queue, so a repeat sent while the first is still being placed waits for it and finds it.
      const prior = betForRequest(user, requestId);
      if (prior) return repeatOfBet(prior, requestKey);
      refuseIfPaused();
      const d = betDeps(user);
      await ensureBaseline(d.exchange, deps.ledger, user, now);
      const before = deps.ledger.data.bets.length;
      try {
        const bet = await placeConditionalBet(d, { ...request, requestKey });
        return { status: 201, body: { bet: betView(bet), stakeReduced: bet.stakeReduced ?? null } };
      } catch (err) {
        holdUnfinished(d, user, before);
        return refusal(err);
      }
    });
  }

  /** A range or a breakout: the same request (a lower and a higher strike and a stake), placed by its own order path. */
  async function placeRange(user: string, body: Record<string, unknown>, product: 'range' | 'breakout', requestId: string | undefined) {
    const request = {
      user,
      eventTicker: text(body.event, 'event'),
      lowSymbol: text(body.low, 'low'),
      highSymbol: text(body.high, 'high'),
      stake: stakeOf(body.stake),
      ...limitsOf(body),
      onFail: body.onFail === 'leave' ? ('leave' as const) : ('unwind' as const),
      ...(requestId ? { clientRequestId: requestId } : {}),
    };
    const requestKey = requestId ? requestKeyOf([choiceOf(product, request.eventTicker, request.lowSymbol, request.highSymbol, '', request.stake)]) : undefined;
    await getEvent(request.eventTicker);
    return queued(user, async () => {
      const prior = betForRequest(user, requestId);
      if (prior) return repeatOfBet(prior, requestKey);
      refuseIfPaused();
      const d = betDeps(user);
      await ensureBaseline(d.exchange, deps.ledger, user, now);
      const before = deps.ledger.data.bets.length;
      try {
        const bet = product === 'breakout' ? await placeBreakoutBet(d, { ...request, requestKey }) : await placeRangeBet(d, { ...request, requestKey });
        return { status: 201, body: { bet: betView(bet), stakeReduced: bet.stakeReduced ?? null } };
      } catch (err) {
        holdUnfinished(d, user, before);
        return refusal(err);
      }
    });
  }

  /** One leg of a basket request, checked for shape. The market itself is checked when the basket is placed. */
  function basketLeg(raw: unknown, index: number): BasketLeg {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(400, 'invalid_leg', `Leg ${index + 1} must be an object.`);
    }
    const leg = raw as Record<string, unknown>;
    const at = (name: string) => {
      try {
        return text(leg[name], name);
      } catch {
        throw new HttpError(400, 'missing_field', `Leg ${index + 1}: "${name}" is required.`);
      }
    };
    const stake = (() => {
      try {
        return stakeOf(leg.stake);
      } catch (err) {
        if (err instanceof HttpError) throw new HttpError(err.status, err.code, `Leg ${index + 1}: ${err.message}`, { leg: index });
        throw err;
      }
    })();
    const maxPrice = (() => {
      try {
        return maxPriceOf(leg.maxPrice);
      } catch (err) {
        if (err instanceof HttpError) throw new HttpError(err.status, err.code, `Leg ${index + 1}: ${err.message}`, { leg: index });
        throw err;
      }
    })();
    const limit = maxPrice === undefined ? {} : { maxPrice };
    const product = productOf(leg.product);
    if (product === 'range' || product === 'breakout') return { product, eventTicker: at('event'), lowSymbol: at('low'), highSymbol: at('high'), stake, ...limit };
    return { product: 'parlay', direction: directionOf(leg.direction), eventTicker: at('event'), conditionSymbol: at('condition'), targetSymbol: at('target'), stake, ...limit };
  }

  async function placeBasketRoute(body: Record<string, unknown>) {
    refuseIfPaused();
    const user = requireUser(body.user);
    const requestId = requestIdOf(body.requestId);
    if (!Array.isArray(body.legs) || body.legs.length < MIN_BASKET_LEGS || body.legs.length > MAX_BASKET_LEGS) {
      throw new HttpError(400, 'invalid_legs', `A basket needs from ${MIN_BASKET_LEGS} to ${MAX_BASKET_LEGS} legs.`);
    }
    const legs = body.legs.map(basketLeg); // each leg's stake is held to the demo's per-bet cap here, as for a single bet
    const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim().slice(0, 40) : undefined;
    for (const ticker of new Set(legs.map((l) => l.eventTicker))) await getEvent(ticker);
    // The legs as the person chose them, in order: the price limits and the basket's name are not part of the choice.
    const requestKey = requestId
      ? requestKeyOf(legs.map((l) => (l.product === 'parlay'
        ? choiceOf('parlay', l.eventTicker, l.conditionSymbol, l.targetSymbol, l.direction ?? 'up', l.stake)
        : choiceOf(l.product, l.eventTicker, l.lowSymbol, l.highSymbol, '', l.stake))))
      : undefined;
    return queued(user, async () => {
      const prior = basketForRequest(user, requestId);
      if (prior && prior.requestKey !== undefined && prior.requestKey !== requestKey) throw idReused(); // a record from before fingerprints is taken as the same
      if (prior) {
        const bets = deps.ledger.data.bets.filter((b) => b.basket?.id === prior.id);
        // A basket the process died in the middle of is reported as it stands: the legs it never reached are not placed now.
        const failed = prior.failed ?? (prior.done || bets.length >= prior.size ? null : { index: bets.length, code: 'interrupted', message: 'This basket was interrupted before every bet was placed. The rest were not placed.' });
        return { status: 200, body: { basket: { id: prior.id, name: prior.name ?? null, size: prior.size, failed }, bets: bets.map(betView), repeated: true } };
      }
      refuseIfPaused();
      const d = betDeps(user);
      await ensureBaseline(d.exchange, deps.ledger, user, now);
      try {
        const result = await placeBasket(d, { user, name, legs, clientRequestId: requestId, requestKey });
        return {
          status: 201,
          body: { basket: { id: result.id, name: result.name ?? null, size: result.size, failed: result.failed }, bets: result.bets.map(betView) },
        };
      } catch (err) {
        return refusal(err);
      }
    });
  }

  /** The bet a cash-out names. A pinned demo account can only reach its own bets; nobody learns whether another's id exists. */
  function betToCashOut(id: unknown): BetRecord {
    const betId = text(id, 'bet');
    const bet = deps.ledger.data.bets.find((b) => b.id === betId && (deps.pinnedUser === undefined || b.user === deps.pinnedUser));
    if (!bet) throw new HttpError(404, 'unknown_bet', `No bet "${betId}".`);
    requireUser(bet.user);
    return bet;
  }

  /** What selling a bet back would bring in right now. Reads two live books and sends nothing. */
  async function cashOutQuote(q: URLSearchParams) {
    const bet = betToCashOut(q.get('bet'));
    return { venue, ...(await quoteCashOut(betDeps(bet.user), bet)) };
  }

  /** Sells a bet back: one sell order per leg. A refusal is 422 with the quote it was refused on, like a refused bet. */
  async function cashOut(body: Record<string, unknown>) {
    refuseIfPaused();
    const bet = betToCashOut(body.bet);
    const minProceeds = body.minProceeds === undefined || body.minProceeds === null ? undefined : Number(body.minProceeds);
    if (minProceeds !== undefined && !(Number.isFinite(minProceeds) && minProceeds >= 0)) {
      throw new HttpError(400, 'invalid_min_proceeds', '"minProceeds" must be a dollar amount of zero or more.');
    }
    const { slippageTicks } = limitsOf(body);
    // Queued with that account's bets and settles, so its sells never interleave with another order.
    return queued(bet.user, async () => {
      refuseIfPaused();
      try {
        const done = await cashOutBet(betDeps(bet.user), bet, { minProceeds, slippageTicks });
        return { status: 200, body: { bet: betView(done), cashOut: done.cashOut ?? null } };
      } catch (err) {
        if (err instanceof CashOutRefused) {
          // 409: the bet is not in a state to be sold, or its first sale may have gone through. 422: refused on the numbers.
          const status = err.code === 'not_open' || err.code === 'sale_unconfirmed' ? 409 : 422;
          return { status, body: { error: err.message, code: err.code, quote: err.quote ?? null } };
        }
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
        called: done.called.map(betView),
        unreadable: done.unreadable,
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
      const checked = deps.ledger.legs(user).length;
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

  /**
   * Bets with an order nobody could account for (its answer was lost and the exchange could not say what became of it) are
   * looked up by tag again, not only when the process starts. Each user's look is queued with that user's bets, so it never
   * meets an order that is still in flight; see `recheckUnresolved` for what it leaves alone.
   */
  const rechecked = new Map<string, number>();
  async function recheckDoubtful(): Promise<number> {
    let fixed = 0;
    for (const user of new Set(deps.ledger.data.bets.filter(hasUnresolvedLeg).map((b) => b.user))) {
      if (deps.users.includes(user)) fixed += await queued(user, () => recheckUnresolved(betDeps(user), user, rechecked));
    }
    return fixed;
  }

  // Finished bets are settled by themselves, so a bet flips to settled on the page when its event closes.
  let autoSettle: NodeJS.Timeout | undefined;
  if (deps.autoSettleMs && deps.autoSettleMs > 0 && !deps.readOnly) {
    autoSettle = setInterval(() => {
      void (async () => {
        try {
          if ((await recheckDoubtful()) > 0) deps.live?.publish('bets');
        } catch (err) {
          console.error(`[executor] re-check of unconfirmed orders failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!deps.ledger.data.bets.some((b) => b.status === 'open' || b.status === 'unhedged')) return;
        settle().then(
          (done) => (done.settled.length > 0 || done.needsReview.length > 0 || done.called.length > 0) && deps.live?.publish('bets'),
          (err: unknown) => console.error(`[executor] auto-settle failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      })();
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
    '/baskets': {
      POST: async (_q, req) => {
        refuseIfReadOnly();
        try {
          return await placeBasketRoute(await readJson(req));
        } finally {
          deps.live?.publish('bets'); // legs placed before a failure are recorded too
        }
      },
    },
    '/cashout': {
      GET: (q) => cashOutQuote(q),
      POST: async (_q, req) => {
        refuseIfReadOnly();
        try {
          return await cashOut(await readJson(req));
        } finally {
          deps.live?.publish('bets'); // a sale that stopped part-way is recorded too
        }
      },
    },
    '/settle': {
      POST: async () => {
        refuseIfReadOnly();
        const done = await settle();
        if (done.settled.length > 0 || done.needsReview.length > 0 || done.called.length > 0) deps.live?.publish('bets');
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
        if (!route) throw new HttpError(404, 'not_found', `No such endpoint: ${path}. Try /health, /markets, /quote, /bets, /baskets, /cashout, /settle, /flow or /reconcile.`);
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
        // Whatever else was thrown is for the log, not the caller: it can hold a file path, the exchange's own words or a stack.
        console.error(`[executor] ${req.method ?? 'GET'} ${(req.url ?? '/').split('?')[0]} failed: ${message}`);
        const fromGemini = /Gemini|WebSocket|fetch failed|timed out|aborted/i.test(message);
        if (fromGemini) send(502, { error: 'Gemini did not answer. Try again in a moment.', code: 'gemini_error' });
        else send(500, { error: 'internal', message: 'Something went wrong on our side.' });
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
