import type { Config, Credentials } from './config.ts';
import { GeminiPublic, GeminiRest } from './gemini/rest.ts';
import type { BookTicker, GeminiEvent, GeminiOrderRecord } from './gemini/types.ts';
import { GeminiRefused, GeminiWs } from './gemini/ws.ts';
import { fmt2 } from './pricing.ts';

export interface OrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  outcome: 'yes' | 'no';
  /** Limit in the outcome's own price: a NO order at 0.29 pays 29 cents per NO contract. */
  limitPrice: number;
  quantity: number;
  /** IOC fills what it can now and cancels the rest; GTC may rest on the book. */
  tif: 'IOC' | 'GTC';
  clientOrderId: string;
}

export interface OrderResult {
  orderId: string;
  filledQuantity: number;
  avgPrice: number | null;
  /** True while the order is still resting on the book. */
  open: boolean;
}

/**
 * What `placeOrder` throws when the venue is known NOT to have taken the order: it answered with a refusal, or the
 * session was not open to carry it. Any other error from `placeOrder` is a lost answer, and the order may have filled.
 */
export class OrderNotSent extends Error {}

/** `placeOrder` was told the order was accepted, but the order's record never appeared, so what it did is not known. */
export class OrderUnconfirmed extends Error {}

export interface VenueOrder extends OrderResult {
  clientOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  /** ISO time the venue created the order, when known. */
  createdAt: string | null;
}

/**
 * Everything the betting and trigger logic needs from a venue. The real
 * implementation talks to Gemini; tests use an in-memory fake.
 */
export interface Exchange {
  getEvent(ticker: string): Promise<GeminiEvent>;
  /** Throws `OrderNotSent` when the venue did not take the order. Any other error means the answer was lost: look the order up by its tag. */
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  /**
   * Looks an order up by its tag. Null means Gemini has no order with that tag. `recent` looks only at live orders and the
   * newest few, which is all an order sent moments ago needs and is far quicker than reading the whole history.
   */
  findOrder(clientOrderId: string, opts?: { recent?: boolean }): Promise<OrderResult | null>;
  cancelOrder(orderId: string): Promise<void>;
  cash(): Promise<number>;
  /** All orders Gemini has on record for the account (recent history plus live). */
  allOrders(): Promise<VenueOrder[]>;
  watchBook(symbol: string, onTick: (tick: BookTicker) => void): Promise<void>;
  /**
   * Best bid and ask of one contract WITH the size resting at each, read live.
   * Must reject rather than guess when the book cannot be read.
   */
  topOfBook(symbol: string): Promise<BookTicker>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toResult(rec: GeminiOrderRecord): OrderResult {
  const filled = Number(rec.filledQuantity ?? 0);
  const avg = rec.avgExecutionPrice === null || rec.avgExecutionPrice === undefined ? null : Number(rec.avgExecutionPrice);
  return {
    orderId: rec.globalOrderId ?? String(rec.orderId),
    filledQuantity: Number.isFinite(filled) ? filled : 0,
    avgPrice: filled > 0 && avg !== null && Number.isFinite(avg) ? avg : null,
    open: rec.status === 'open',
  };
}

export class GeminiExchange implements Exchange {
  readonly rest: GeminiRest;
  readonly ws: GeminiWs;
  private readonly pub: GeminiPublic;
  private readonly bookHandlers = new Map<string, Set<(tick: BookTicker) => void>>();

  constructor(config: Config, creds: Credentials) {
    this.pub = new GeminiPublic(config.baseUrl);
    this.rest = new GeminiRest(creds, config.baseUrl);
    this.ws = new GeminiWs(creds, config.wsUrl);
    this.ws.on('bookTicker', (tick: BookTicker) => {
      for (const handler of this.bookHandlers.get(tick.symbol) ?? []) handler(tick);
    });
  }

  getEvent(ticker: string): Promise<GeminiEvent> {
    return this.pub.getEvent(ticker);
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    try {
      await this.ws.connect();
    } catch (err) {
      throw new OrderNotSent(err instanceof Error ? err.message : String(err)); // nothing had been sent yet
    }
    const terminal = req.tif === 'IOC' ? this.ws.waitForTerminal(req.clientOrderId, 8000) : null;
    let ack;
    try {
      ack = await this.ws.placeOrder({
        symbol: req.symbol,
        side: req.side === 'buy' ? 'BUY' : 'SELL',
        eventOutcome: req.outcome === 'yes' ? 'YES' : 'NO',
        price: fmt2(req.limitPrice),
        quantity: fmt2(req.quantity),
        timeInForce: req.tif,
        clientOrderId: req.clientOrderId,
      });
    } catch (err) {
      // A client-error refusal means no order exists. A 5xx, a timeout or a socket that closed mid-request means nobody knows yet.
      throw err instanceof GeminiRefused ? new OrderNotSent(err.message) : err;
    }
    if (terminal) await terminal;

    // The order record over REST is the source of truth for what filled.
    // It was sent a moment ago, so look among the newest orders first (fast); widen the search if it is not there.
    for (let attempt = 0; attempt < 8; attempt++) {
      const rec = await this.rest.findOrder(req.clientOrderId, { recentOnly: attempt < 5 });
      if (rec && (req.tif === 'GTC' || rec.status !== 'open')) return toResult(rec);
      await sleep(400);
    }
    throw new OrderUnconfirmed(
      `Order ${req.clientOrderId} was accepted by Gemini (id ${ack.orderId}) but its record did not appear; ` +
        'check it before retrying.',
    );
  }

  async findOrder(clientOrderId: string, opts: { recent?: boolean } = {}): Promise<OrderResult | null> {
    const rec = await this.rest.findOrder(clientOrderId, { recentOnly: opts.recent });
    return rec ? toResult(rec) : null;
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.ws.cancelOrder(orderId);
  }

  cash(): Promise<number> {
    return this.rest.usdBalance();
  }

  async allOrders(): Promise<VenueOrder[]> {
    const [active, history] = [await this.rest.activeOrders(), await this.rest.orderHistory()];
    return [...active, ...history].map((rec) => ({
      ...toResult(rec),
      clientOrderId: rec.clientOrderId ?? '',
      symbol: rec.symbol,
      side: rec.side,
      createdAt: rec.createdAt ?? null,
    }));
  }

  async watchBook(symbol: string, onTick: (tick: BookTicker) => void): Promise<void> {
    const key = symbol.toUpperCase();
    if (!this.bookHandlers.has(key)) this.bookHandlers.set(key, new Set());
    this.bookHandlers.get(key)!.add(onTick);
    await this.ws.watchBook(symbol);
  }

  async topOfBook(symbol: string): Promise<BookTicker> {
    const depth = await this.ws.depth(symbol);
    // Do not rely on the order Gemini sends the levels in.
    const bid = depth.bids.reduce<[number, number] | null>((best, lvl) => (!best || lvl[0] > best[0] ? lvl : best), null);
    const ask = depth.asks.reduce<[number, number] | null>((best, lvl) => (!best || lvl[0] < best[0] ? lvl : best), null);
    return {
      symbol: depth.symbol,
      bid: bid ? bid[0] : null,
      bidSize: bid ? bid[1] : null,
      ask: ask ? ask[0] : null,
      askSize: ask ? ask[1] : null,
    };
  }

  /** True while the long-lived WebSocket session is up. */
  get connected(): boolean {
    return this.ws.isOpen;
  }

  /** Opens the WebSocket session now instead of on the first order. */
  connect(): Promise<void> {
    return this.ws.connect();
  }

  close(): void {
    this.ws.close();
  }
}
