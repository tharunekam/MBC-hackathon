import type { Exchange, OrderRequest, OrderResult, VenueOrder } from '../src/exchange.ts';
import type { BookTicker, GeminiContract, GeminiEvent } from '../src/gemini/types.ts';

interface Book {
  bid: number | null;
  bidSize: number;
  ask: number | null;
  askSize: number;
}

const r = (x: number) => Math.round(x * 1e8) / 1e8;

/**
 * In-memory stand-in for Gemini: one event, a top-of-book per contract in YES
 * prices, cash, positions and an order log. IOC orders fill against the top of
 * book only, exactly like the behaviour observed in the sandbox.
 */
export class FakeExchange implements Exchange {
  cashBalance = 1000;
  readonly books = new Map<string, Book>();
  readonly orders = new Map<string, VenueOrder>();
  readonly positions = new Map<string, number>(); // key: symbol|outcome
  readonly sent: OrderRequest[] = [];
  private readonly event: GeminiEvent;
  private nextOrderId = 1;
  /** When set, the next placeOrder for a matching tag throws after "sending". */
  failAfterSend: string | null = null;
  /** Time stamped on new orders; tests can move it. */
  clock: () => Date = () => new Date('2026-11-17T23:30:00Z');

  constructor(ticker: string, strikes: Array<{ strike: number; bid: number | null; ask: number | null; bidSize?: number; askSize?: number }>) {
    const contracts: GeminiContract[] = strikes.map((s) => {
      const symbol = `GEMI-${ticker}-HI${s.strike}`;
      this.books.set(symbol, { bid: s.bid, bidSize: s.bidSize ?? 1000, ask: s.ask, askSize: s.askSize ?? 1000 });
      return {
        id: `1-${s.strike}`,
        label: `$${s.strike} or above`,
        ticker: `HI${s.strike}`,
        instrumentSymbol: symbol,
        status: 'active',
        marketState: 'open',
        strike: { type: 'above', value: String(s.strike) },
        prices: {},
      };
    });
    this.event = { id: '1', title: `Test price ladder ${ticker}`, ticker, category: 'Crypto', status: 'active', expiryDate: '2026-11-18T00:00:00.000Z', contracts };
  }

  symbol(strike: number): string {
    return `GEMI-${this.event.ticker}-HI${strike}`;
  }

  setBook(strike: number, book: Partial<Book>): void {
    Object.assign(this.books.get(this.symbol(strike))!, book);
  }

  resolve(strike: number, side: 'yes' | 'no'): void {
    const c = this.event.contracts.find((x) => x.instrumentSymbol === this.symbol(strike))!;
    c.status = 'settled';
    c.marketState = 'closed';
    c.resolutionSide = side;
    for (const outcome of ['yes', 'no'] as const) {
      const key = `${c.instrumentSymbol}|${outcome}`;
      const held = this.positions.get(key) ?? 0;
      if (held > 0 && outcome === side) this.cashBalance = r(this.cashBalance + held);
      this.positions.delete(key);
    }
  }

  async getEvent(ticker: string): Promise<GeminiEvent> {
    if (ticker !== this.event.ticker) throw new Error(`unknown event ${ticker}`);
    return {
      ...this.event,
      contracts: this.event.contracts.map((c) => {
        const b = this.books.get(c.instrumentSymbol)!;
        return { ...c, prices: { bestBid: b.bid === null ? null : String(b.bid), bestAsk: b.ask === null ? null : String(b.ask) } };
      }),
    };
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    if (this.orders.has(req.clientOrderId)) throw new Error(`duplicate clientOrderId ${req.clientOrderId}`);
    this.sent.push(req);
    const book = this.books.get(req.symbol);
    if (!book) throw new Error(`unknown symbol ${req.symbol}`);

    // Price and size available to this order, expressed in the order's own outcome.
    let price: number | null = null;
    let size = 0;
    if (req.side === 'buy' && req.outcome === 'yes') [price, size] = [book.ask, book.askSize];
    if (req.side === 'buy' && req.outcome === 'no') [price, size] = [book.bid === null ? null : r(1 - book.bid), book.bidSize];
    if (req.side === 'sell' && req.outcome === 'yes') [price, size] = [book.bid, book.bidSize];
    if (req.side === 'sell' && req.outcome === 'no') [price, size] = [book.ask === null ? null : r(1 - book.ask), book.askSize];

    const crosses = price !== null && (req.side === 'buy' ? req.limitPrice + 1e-9 >= price : req.limitPrice - 1e-9 <= price);
    const filled = crosses ? Math.min(req.quantity, size) : 0;
    const key = `${req.symbol}|${req.outcome}`;
    if (filled > 0 && price !== null) {
      const sign = req.side === 'buy' ? 1 : -1;
      this.cashBalance = r(this.cashBalance - sign * filled * price);
      this.positions.set(key, r((this.positions.get(key) ?? 0) + sign * filled));
      // consume liquidity on the side that was hit
      if ((req.side === 'buy') === (req.outcome === 'yes')) book.askSize = r(book.askSize - filled);
      else book.bidSize = r(book.bidSize - filled);
    }
    const result: OrderResult = {
      orderId: String(this.nextOrderId++),
      filledQuantity: filled,
      avgPrice: filled > 0 ? price : null,
      open: req.tif === 'GTC' && filled < req.quantity,
    };
    this.orders.set(req.clientOrderId, { ...result, clientOrderId: req.clientOrderId, symbol: req.symbol, side: req.side, createdAt: this.clock().toISOString() });
    if (this.failAfterSend === req.clientOrderId) {
      this.failAfterSend = null;
      throw new Error('connection dropped after the order was sent');
    }
    return result;
  }

  async findOrder(clientOrderId: string): Promise<OrderResult | null> {
    return this.orders.get(clientOrderId) ?? null;
  }

  async cancelOrder(): Promise<void> {}

  async cash(): Promise<number> {
    return this.cashBalance;
  }

  async allOrders(): Promise<VenueOrder[]> {
    return [...this.orders.values()];
  }

  async watchBook(_symbol: string, _onTick: (tick: BookTicker) => void): Promise<void> {}
}
