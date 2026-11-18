import type {
  ApiErrorBody,
  Bet,
  CallRecord,
  FlowResponse,
  HealthResponse,
  LeaderboardResponse,
  MarketsResponse,
  PlaceBetRequest,
  PlaceBetResponse,
  QuoteResponse,
  ReconcileResponse,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: ApiErrorBody | null;
  constructor(status: number, body: ApiErrorBody | null, fallback: string) {
    super(body?.error ?? fallback);
    this.status = status;
    this.code = body?.code ?? 'network_error';
    this.body = body;
  }
}

/** Everything the UI needs from the executor and the chain service. */
export interface Api {
  readonly mode: 'mock' | 'live';
  health(): Promise<HealthResponse>;
  markets(event?: string): Promise<MarketsResponse>;
  quote(args: { event: string; condition: string; target: string; stake?: number }): Promise<QuoteResponse>;
  placeBet(req: PlaceBetRequest): Promise<PlaceBetResponse>;
  bets(user?: string): Promise<{ bets: Bet[] }>;
  settle(): Promise<{ settled: Bet[]; needsReview: Bet[]; stillOpen: number }>;
  flow(user?: string): Promise<FlowResponse>;
  reconcile(): Promise<ReconcileResponse>;
  commitCall(betId: string): Promise<CallRecord>;
  revealCall(callId: string): Promise<CallRecord>;
  calls(): Promise<{ calls: CallRecord[] }>;
  leaderboard(): Promise<LeaderboardResponse>;
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError(0, null, 'Cannot reach the server. Check your connection and try again.');
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) throw new ApiError(res.status, json as ApiErrorBody | null, `The server answered ${res.status}.`);
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
    quote: ({ event, condition, target, stake }) => ex(`/quote${qs({ event, condition, target, stake })}`),
    placeBet: (req) => ex('/bets', { method: 'POST', body: JSON.stringify({ ...req, user: req.user || defaultUser }) }),
    bets: (user) => ex(`/bets${qs({ user: user ?? defaultUser })}`),
    settle: () => ex('/settle', { method: 'POST' }),
    flow: (user) => ex(`/flow${qs({ user })}`),
    reconcile: () => ex('/reconcile'),
    commitCall: (betId) => ch('/calls', { method: 'POST', body: JSON.stringify({ betId }) }),
    revealCall: (callId) => ch(`/calls/${callId}/reveal`, { method: 'POST' }),
    calls: () => ch('/calls'),
    leaderboard: () => ch('/leaderboard'),
  };
}
