import WebSocket from 'ws';
import type { Exchange, OrderRequest, OrderResult, VenueOrder } from './exchange.ts';
import { GeminiPublic } from './gemini/rest.ts';
import type { BookTicker, GeminiEvent } from './gemini/types.ts';

/** Thrown by every order-side method of the read-only exchange. */
export class ReadOnlyError extends Error {
  constructor() {
    super('This executor has no Gemini API keys, so it can quote but not trade.');
    this.name = 'ReadOnlyError';
  }
}

type Level = [number, number];

const toLevels = (v: unknown): Level[] => {
  if (!Array.isArray(v)) return [];
  const out: Level[] = [];
  for (const row of v) {
    if (!Array.isArray(row)) continue;
    const price = Number(row[0]);
    const size = Number(row[1]);
    if (Number.isFinite(price) && Number.isFinite(size) && size > 0) out.push([price, size]);
  }
  return out;
};

/**
 * Real Gemini market data with no account: events and prices over REST, the live order book over the PUBLIC depth
 * stream (no keys, no signature). Every order-side method refuses. It lets the whole app run on real ladders and
 * real depth before any keys exist, and it cannot spend money by construction: it holds no credentials.
 */
export class ReadOnlyExchange implements Exchange {
  private readonly pub: GeminiPublic;
  private readonly wsUrl: string;
  private ws: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private nextId = 1;
  private readonly waiting = new Map<string, Array<(snapshot: { bids: Level[]; asks: Level[] }) => void>>();

  constructor(baseUrl: string, wsUrl: string) {
    this.pub = new GeminiPublic(baseUrl);
    this.wsUrl = wsUrl;
  }

  getEvent(ticker: string): Promise<GeminiEvent> {
    return this.pub.getEvent(ticker);
  }

  placeOrder(_req: OrderRequest): Promise<OrderResult> {
    return Promise.reject(new ReadOnlyError());
  }
  cancelOrder(_orderId: string): Promise<void> {
    return Promise.reject(new ReadOnlyError());
  }
  async findOrder(_clientOrderId: string): Promise<OrderResult | null> {
    return null;
  }
  async cash(): Promise<number> {
    return 0;
  }
  async allOrders(): Promise<VenueOrder[]> {
    return [];
  }
  async watchBook(_symbol: string, _onTick: (tick: BookTicker) => void): Promise<void> {}

  async topOfBook(symbol: string): Promise<BookTicker> {
    const key = symbol.toLowerCase();
    const stream = `${key}@depth5`;
    const ws = await this.connect();
    const snapshot = new Promise<{ bids: Level[]; asks: Level[] }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.drop(key, onSnapshot);
        reject(new Error(`Gemini WebSocket sent no order-book depth for ${symbol} within 4 seconds`));
      }, 4000);
      const onSnapshot = (s: { bids: Level[]; asks: Level[] }) => {
        clearTimeout(timer);
        resolve(s);
      };
      this.waiting.set(key, [...(this.waiting.get(key) ?? []), onSnapshot]);
    });
    snapshot.catch(() => undefined);
    ws.send(JSON.stringify({ id: this.nextId++, method: 'SUBSCRIBE', params: [stream] }));
    try {
      const { bids, asks } = await snapshot;
      const bid = bids.reduce<Level | null>((best, l) => (!best || l[0] > best[0] ? l : best), null);
      const ask = asks.reduce<Level | null>((best, l) => (!best || l[0] < best[0] ? l : best), null);
      return { symbol: symbol.toUpperCase(), bid: bid?.[0] ?? null, bidSize: bid?.[1] ?? null, ask: ask?.[0] ?? null, askSize: ask?.[1] ?? null };
    } finally {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: this.nextId++, method: 'UNSUBSCRIBE', params: [stream] }));
    }
  }

  private drop(key: string, fn: (s: { bids: Level[]; asks: Level[] }) => void): void {
    this.waiting.set(key, (this.waiting.get(key) ?? []).filter((f) => f !== fn));
  }

  private connect(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.opening) return this.opening;
    this.opening = new Promise<WebSocket>((resolve, reject) => {
      // No auth headers: the depth stream is public.
      const ws = new WebSocket(`${this.wsUrl}?snapshot=-1`);
      ws.on('open', () => {
        this.ws = ws;
        this.opening = null;
        resolve(ws);
      });
      ws.on('message', (data) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        if (typeof msg.symbol !== 'string' || !('bids' in msg || 'asks' in msg)) return;
        const key = msg.symbol.toLowerCase();
        const snapshot = { bids: toLevels(msg.bids), asks: toLevels(msg.asks) };
        const callbacks = this.waiting.get(key) ?? [];
        this.waiting.delete(key);
        for (const cb of callbacks) cb(snapshot);
      });
      ws.on('error', (err) => {
        this.opening = null;
        reject(new Error(`Gemini WebSocket error: ${err instanceof Error ? err.message : String(err)}`));
      });
      ws.on('close', () => {
        if (this.ws === ws) this.ws = null;
        this.opening = null;
      });
    });
    return this.opening;
  }

  close(): void {
    this.ws?.close();
  }
}
