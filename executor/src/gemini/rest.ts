import type { Credentials } from '../config.ts';
import { restHeaders } from './auth.ts';
import type { GeminiEvent, GeminiOrderRecord, GeminiPosition } from './types.ts';

export class GeminiApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, path: string) {
    super(`Gemini ${path} -> HTTP ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Public market data. No API key needed. */
export class GeminiPublic {
  private readonly baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(this.baseUrl + path, { signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    if (!res.ok) throw new GeminiApiError(res.status, text, path);
    return JSON.parse(text) as T;
  }

  async getEvent(ticker: string): Promise<GeminiEvent> {
    return this.get<GeminiEvent>(`/v1/prediction-markets/events/${encodeURIComponent(ticker)}`);
  }

  /** Lists events, following pagination until a short page comes back. */
  async listEvents(status: 'active' | 'settled' = 'active', maxEvents = 500): Promise<GeminiEvent[]> {
    const out: GeminiEvent[] = [];
    const limit = 100;
    for (let offset = 0; out.length < maxEvents; offset += limit) {
      const page = await this.get<{ data: GeminiEvent[] }>(
        `/v1/prediction-markets/events?status=${status}&limit=${limit}&offset=${offset}`,
      );
      out.push(...page.data);
      if (page.data.length < limit) break;
    }
    return out;
  }
}

/**
 * Private account reads. Order ENTRY is deliberately not here: in the sandbox,
 * POST /v1/prediction-markets/order returns HTTP 500 for every valid order, so
 * orders go over the WebSocket (see ws.ts).
 */
export class GeminiRest {
  private readonly creds: Credentials;
  private readonly baseUrl: string;
  private queue: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;
  /** Minimum gap between private calls, so one key is never hammered. */
  private readonly minGapMs: number;

  constructor(creds: Credentials, baseUrl: string, minGapMs = 250) {
    this.creds = creds;
    this.baseUrl = baseUrl;
    this.minGapMs = minGapMs;
  }

  private post<T>(path: string, fields: Record<string, unknown> = {}): Promise<T> {
    const run = async (): Promise<T> => {
      const wait = this.lastCallAt + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCallAt = Date.now();
      const res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: restHeaders(this.creds.apiKey, this.creds.apiSecret, path, fields),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      if (!res.ok) throw new GeminiApiError(res.status, text, path);
      return JSON.parse(text) as T;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Available USD cash, as a number of dollars. */
  async usdBalance(): Promise<number> {
    const rows = await this.post<Array<{ currency: string; amount: string; available: string }>>('/v1/balances');
    const usd = rows.find((r) => r.currency === 'USD');
    return usd ? Number(usd.amount) : 0;
  }

  async positions(): Promise<GeminiPosition[]> {
    const res = await this.post<{ positions: GeminiPosition[] }>('/v1/prediction-markets/positions');
    return res.positions;
  }

  async activeOrders(): Promise<GeminiOrderRecord[]> {
    const res = await this.post<{ orders: GeminiOrderRecord[] }>('/v1/prediction-markets/orders/active');
    return res.orders;
  }

  async orderHistory(): Promise<GeminiOrderRecord[]> {
    const res = await this.post<{ orders: GeminiOrderRecord[] }>('/v1/prediction-markets/orders/history');
    return res.orders;
  }

  /** Looks an order up by the tag we attached to it. Checks live orders first, then history. */
  async findOrder(clientOrderId: string): Promise<GeminiOrderRecord | null> {
    const active = await this.activeOrders();
    const live = active.find((o) => o.clientOrderId === clientOrderId);
    if (live) return live;
    const history = await this.orderHistory();
    return history.find((o) => o.clientOrderId === clientOrderId) ?? null;
  }

  async termsAccepted(): Promise<boolean> {
    const path = '/v1/prediction-markets/terms/status';
    const res = await fetch(this.baseUrl + path, {
      method: 'GET',
      headers: restHeaders(this.creds.apiKey, this.creds.apiSecret, path),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new GeminiApiError(res.status, text, path);
    return (JSON.parse(text) as { hasAcceptedLatest?: boolean }).hasAcceptedLatest === true;
  }
}
