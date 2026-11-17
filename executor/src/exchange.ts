import type { Config, Credentials } from './config.ts';
import { GeminiPublic, GeminiRest } from './gemini/rest.ts';
import type { BookTicker, GeminiEvent, GeminiOrderRecord } from './gemini/types.ts';
import { GeminiWs } from './gemini/ws.ts';
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
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  /** Looks an order up by its tag. Null means Gemini has no order with that tag. */
  findOrder(clientOrderId: string): Promise<OrderResult | null>;
  cancelOrder(orderId: string): Promise<void>;
  cash(): Promise<number>;
  /** All orders Gemini has on record for the account (recent history plus live). */
  allOrders(): Promise<VenueOrder[]>;
  watchBook(symbol: string, onTick: (tick: BookTicker) => void): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toResult(rec: GeminiOrderRecord): OrderResult {
  const filled = Number(rec.filledQuantity ?? 0);
  const avg = rec.avgExecutionPrice === null || rec.avgExecutionPrice === undefined ? null : Number(rec.avgExecutionPrice);
  return {
    orderId: String(rec.orderId),
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
    await this.ws.connect();
    const terminal = req.tif === 'IOC' ? this.ws.waitForTerminal(req.clientOrderId, 8000) : null;
    const ack = await this.ws.placeOrder({
      symbol: req.symbol,
      side: req.side === 'buy' ? 'BUY' : 'SELL',
      eventOutcome: req.outcome === 'yes' ? 'YES' : 'NO',
      price: fmt2(req.limitPrice),
      quantity: fmt2(req.quantity),
      timeInForce: req.tif,
      clientOrderId: req.clientOrderId,
    });
    if (terminal) await terminal;

    // The order record over REST is the source of truth for what filled.
    for (let attempt = 0; attempt < 8; attempt++) {
      const rec = await this.rest.findOrder(req.clientOrderId);
      if (rec && (req.tif === 'GTC' || rec.status !== 'open')) return toResult(rec);
      await sleep(400);
    }
    throw new Error(
      `Order ${req.clientOrderId} was accepted by Gemini (id ${ack.orderId}) but its record did not appear; ` +
        'check it before retrying.',
    );
  }

  async findOrder(clientOrderId: string): Promise<OrderResult | null> {
    const rec = await this.rest.findOrder(clientOrderId);
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

  close(): void {
    this.ws.close();
  }
}
