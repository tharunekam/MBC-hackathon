import type {
  ApiErrorBody,
  Bet,
  BreakoutQuoteResponse,
  CallRecord,
  CashOutQuote,
  CashOutResponse,
  Direction,
  FlowResponse,
  HealthResponse,
  LeaderboardResponse,
  MarketsResponse,
  PlaceBasketRequest,
  PlaceBasketResponse,
  PlaceBetRequest,
  PlaceBetResponse,
  PublicReveal,
  QuoteResponse,
  RangeQuoteResponse,
  ReconcileResponse,
} from './types';

/**
 * One plain sentence for a failure that has no sentence of the executor's own worth showing: the connection dropped, the
 * service is busy or broken, or the answer was not something a page can read. A server's own words are kept for a refusal
 * (a 4xx with a code), where they name the bet's problem; they never stand in for these.
 */
function plainFor(status: number): string {
  if (status === 0) return 'We could not reach the server. Check your connection and try again.';
  if (status === 429) return 'Lots of people are betting right now. Wait a few seconds and try again.';
  if (status >= 500) return 'Something went wrong on our side. Try again in a moment.';
  if (status === 404) return 'We could not find that.';
  if (status === 401 || status === 403) return 'You are not allowed to do that here.';
  return 'That did not go through. Try again.';
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: ApiErrorBody | null;
  constructor(status: number, body: ApiErrorBody | null, fallback?: string) {
    // A refusal's own sentence is kept (the stake cap and a basket's failed leg are read out of it); a busy or broken
    // server, or a body that is not an error at all, gets a fixed sentence instead of whatever the server said. Only the
    // executor's own refusals carry a `code`: an `error` string with none comes from a proxy or a firewall in between, and
    // is never shown.
    const refusal = status >= 400 && status < 500 && status !== 429 && typeof body?.code === 'string' && typeof body?.error === 'string' && body.error.trim() !== '';
    super(refusal ? body!.error : (fallback ?? plainFor(status)));
    this.status = status;
    this.code = typeof body?.code === 'string' ? body.code : status === 0 ? 'network_error' : 'unreadable';
    this.body = body;
  }
}

/** Everything the UI needs from the executor and the chain service. */
export interface Api {
  readonly mode: 'mock' | 'live';
  health(): Promise<HealthResponse>;
  markets(event?: string): Promise<MarketsResponse>;
  /** A parlay's quote. `direction` is "up" unless the bet is that the price falls. */
  quote(args: { event: string; condition: string; target: string; stake?: number; direction?: Direction }): Promise<QuoteResponse>;
  /** A range's quote: the lower and higher strike, and what a stake would buy. */
  quoteRange(args: { event: string; low: string; high: string; stake?: number }): Promise<RangeQuoteResponse>;
  /** A breakout's quote: the same two strikes as a range, priced for finishing outside them. */
  quoteBreakout(args: { event: string; low: string; high: string; stake?: number }): Promise<BreakoutQuoteResponse>;
  placeBet(req: PlaceBetRequest): Promise<PlaceBetResponse>;
  /** Several bets in one step. Every leg is checked first; a leg that cannot complete stops the rest. */
  placeBasket(req: PlaceBasketRequest): Promise<PlaceBasketResponse>;
  bets(user?: string): Promise<{ bets: Bet[] }>;
  /** What selling an open bet back would bring in right now. Sends nothing. */
  cashOutQuote(betId: string): Promise<CashOutQuote>;
  /** Sells an open bet back as two sell orders. `minProceeds` refuses the sale if the price has dropped below it. */
  cashOut(betId: string, minProceeds?: number): Promise<CashOutResponse>;
  /** `called` lists bets that were sold back earlier and whose market has now settled, so their call has a result (absent from an older executor). */
  settle(): Promise<{ settled: Bet[]; needsReview: Bet[]; called?: Bet[]; stillOpen: number }>;
  flow(user?: string): Promise<FlowResponse>;
  reconcile(): Promise<ReconcileResponse>;
  commitCall(betId: string): Promise<CallRecord>;
  revealCall(callId: string): Promise<CallRecord>;
  calls(): Promise<{ calls: CallRecord[] }>;
  leaderboard(): Promise<LeaderboardResponse>;
  reveal(signature: string): Promise<PublicReveal>;
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError(0, null);
  }
  let json: unknown = null;
  try {
    const text = await res.text();
    json = text ? JSON.parse(text) : null;
  } catch {
    /* an empty or non-JSON body, or a body that was cut off: handled below */
  }
  if (!res.ok) throw new ApiError(res.status, json && typeof json === 'object' ? (json as ApiErrorBody) : null);
  // A 200 with nothing readable in it (a proxy's error page, a cut-off answer) is not data: a page would show it as
  // "no bets" or "no markets" to someone who has both.
  if (json === null && res.status !== 204) throw new ApiError(res.status, null, 'The server sent something we could not read. Try again in a moment.');
  return json as T;
}

const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** The real thing: the hosted executor at `${base}` and the chain service at `${chainBase}`. */
export function liveApi(base = '/api', chainBase = '/chain', defaultUser = 'primary'): Api {
  const ex = <T,>(path: string, init?: RequestInit) => request<T>(base, path, init);
  const ch = <T,>(path: string, init?: RequestInit) => request<T>(chainBase, path, init);
  return {
    mode: 'live',
    health: () => ex('/health'),
    markets: (event) => ex(`/markets${qs({ event })}`),
    quote: ({ event, condition, target, stake, direction }) => ex(`/quote${qs({ event, condition, target, stake, direction: direction === 'down' ? 'down' : undefined })}`),
    quoteRange: ({ event, low, high, stake }) => ex(`/quote${qs({ product: 'range', event, low, high, stake })}`),
    quoteBreakout: ({ event, low, high, stake }) => ex(`/quote${qs({ product: 'breakout', event, low, high, stake })}`),
    placeBet: (req) => ex('/bets', { method: 'POST', body: JSON.stringify({ ...req, user: req.user || defaultUser }) }),
    placeBasket: (req) => ex('/baskets', { method: 'POST', body: JSON.stringify({ ...req, user: req.user || defaultUser }) }),
    bets: (user) => ex(`/bets${qs({ user: user ?? defaultUser })}`),
    cashOutQuote: (betId) => ex(`/cashout${qs({ bet: betId })}`),
    cashOut: (betId, minProceeds) => ex('/cashout', { method: 'POST', body: JSON.stringify({ bet: betId, ...(minProceeds !== undefined ? { minProceeds } : {}) }) }),
    settle: () => ex('/settle', { method: 'POST' }),
    flow: (user) => ex(`/flow${qs({ user })}`),
    reconcile: () => ex('/reconcile'),
    commitCall: (betId) => ch('/calls', { method: 'POST', body: JSON.stringify({ betId }) }),
    revealCall: (callId) => ch(`/calls/${callId}/reveal`, { method: 'POST' }),
    calls: () => ch('/calls'),
    leaderboard: () => ch('/leaderboard'),
    reveal: (signature) => ch(`/reveals/${signature}`),
  };
}
