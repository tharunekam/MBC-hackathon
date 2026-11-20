import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Credentials } from '../config.ts';
import { wsHeaders } from './auth.ts';
import type { BookTicker, DepthSnapshot, OrderUpdate } from './types.ts';

const TERMINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PlaceOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  eventOutcome: 'YES' | 'NO';
  /** Limit price as a 2-decimal string, in the outcome's own price (not YES space). */
  price: string;
  quantity: string;
  timeInForce: 'IOC' | 'GTC';
  clientOrderId: string;
}

/**
 * Gemini answered a request with a client error (status 400 to 499), or the socket was not open to carry it: whatever was
 * asked was not done. Any other failure (a 5xx, a closed socket, a timeout) is a plain Error: the work may have been done.
 */
export class GeminiRefused extends Error {}

export interface PlaceOrderAck {
  orderId: string;
  status: string;
  symbol: string;
}

/** Gemini sends an empty string for a missing side of the book; that is "nothing there", not zero. */
const num = (v: unknown): number | null => {
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const levels = (v: unknown): Array<[number, number]> => {
  if (!Array.isArray(v)) return [];
  const out: Array<[number, number]> = [];
  for (const row of v) {
    if (!Array.isArray(row)) continue;
    const price = num(row[0]);
    const size = num(row[1]);
    if (price !== null && size !== null && size > 0) out.push([price, size]);
  }
  return out;
};

/**
 * One authenticated WebSocket session to Gemini.
 *
 * Emits:
 *   'orderUpdate' (OrderUpdate)  - from the private `orders@account` stream
 *   'bookTicker'  (BookTicker)   - best bid/ask for subscribed symbols
 *   'depth'       (DepthSnapshot) - top five price levels, while a depth read is in progress
 *   'open' / 'close'
 *
 * Lessons from testing against the sandbox that this class encodes:
 *   - Order events are only delivered once the `orders@account` subscription
 *     has been acknowledged, so connect() waits for that ack.
 *   - Order ids are 18-digit integers, beyond what a JS number can hold, so
 *     they are read as strings.
 *   - `cancelOnDisconnect` is NOT set: triggered limit orders may need to rest.
 */
export class GeminiWs extends EventEmitter {
  private readonly creds: Credentials;
  private readonly url: string;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly streams = new Set<string>(['orders@account']);
  private connecting: Promise<void> | null = null;
  private closedByUs = false;
  private reconnectDelay = 1000;
  private readonly depthReads = new Map<string, Promise<DepthSnapshot>>();

  constructor(creds: Credentials, wsUrl: string) {
    super();
    this.creds = creds;
    this.url = `${wsUrl}?snapshot=-1`;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Opens the socket (if needed) and resolves once private order events are flowing. */
  connect(): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.closedByUs = false;
    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, { headers: wsHeaders(this.creds.apiKey, this.creds.apiSecret) });
      this.ws = ws;
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.connecting = null;
        reject(err);
      };
      ws.on('open', () => {
        this.send('SUBSCRIBE', [...this.streams])
          .then(() => {
            settled = true;
            this.connecting = null;
            this.reconnectDelay = 1000;
            this.emit('open');
            resolve();
          })
          .catch(fail);
      });
      ws.on('message', (data) => this.onMessage(data.toString()));
      ws.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      ws.on('unexpected-response', (_req, res) => fail(new Error(`Gemini WebSocket refused the connection: HTTP ${res.statusCode}`)));
      ws.on('close', () => {
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Gemini WebSocket closed before a reply arrived'));
          this.pending.delete(id);
        }
        this.ws = null;
        this.emit('close');
        fail(new Error('Gemini WebSocket closed during connect'));
        if (!this.closedByUs) this.scheduleReconnect();
      });
    });
    return this.connecting;
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    setTimeout(() => {
      if (this.closedByUs || this.isOpen) return;
      this.connect().catch(() => undefined);
    }, delay).unref();
  }

  close(): void {
    this.closedByUs = true;
    this.ws?.close();
  }

  private send(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new GeminiRefused('Gemini WebSocket is not open'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gemini WebSocket ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private onMessage(raw: string): void {
    // Order ids overflow JS numbers; quote them before parsing.
    const safe = raw.replace(/"i":(\d{15,})/, '"i":"$1"');
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(safe) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      const detail = JSON.stringify(msg.error ?? msg).slice(0, 300);
      if (msg.status === 200) p.resolve(msg.result ?? {});
      // Only a client error (400 to 499) says the request was understood and turned down. A 5xx, or any other status, is
      // what a gateway answers for work that may have been done: the answer is lost, so the order is looked up by its tag.
      else if (typeof msg.status === 'number' && msg.status >= 400 && msg.status < 500) p.reject(new GeminiRefused(`Gemini rejected the request: ${detail}`));
      else p.reject(new Error(`Gemini answered the request with status ${String(msg.status)}: ${detail}`));
      return;
    }

    if (msg.e === 'orderUpdate') {
      const update: OrderUpdate = {
        symbol: String(msg.s ?? '').toUpperCase(),
        orderId: String(msg.i ?? ''),
        clientOrderId: String(msg.c ?? ''),
        side: msg.S === 'SELL' ? 'SELL' : 'BUY',
        outcome: msg.O === 'NO' ? 'NO' : 'YES',
        status: String(msg.X ?? ''),
        avgPrice: typeof msg.a === 'string' ? msg.a : undefined,
        reason: typeof msg.r === 'string' ? msg.r : undefined,
      };
      this.emit('orderUpdate', update);
      return;
    }

    // depth5: {"lastUpdateId":..., "symbol":"gemi-...", "bids":[["0.83","1.00"],...], "asks":[["0.97","22.00"],...]}
    if (typeof msg.symbol === 'string' && ('bids' in msg || 'asks' in msg)) {
      const snapshot: DepthSnapshot = { symbol: msg.symbol.toUpperCase(), bids: levels(msg.bids), asks: levels(msg.asks) };
      this.emit('depth', snapshot);
      return;
    }

    // bookTicker: {"s":"gemi-...","b":"0.03","B":"64.00","a":"0.10","A":"10.00",...}
    if (typeof msg.s === 'string' && ('b' in msg || 'a' in msg) && !('bids' in msg)) {
      const tick: BookTicker = {
        symbol: msg.s.toUpperCase(),
        bid: num(msg.b),
        bidSize: num(msg.B),
        ask: num(msg.a),
        askSize: num(msg.A),
      };
      this.emit('bookTicker', tick);
    }
  }

  /** Starts streaming best bid/ask for a contract. Safe to call repeatedly. */
  async watchBook(symbol: string): Promise<void> {
    const stream = `${symbol}@bookTicker`;
    if (this.streams.has(stream)) return;
    this.streams.add(stream);
    await this.connect();
    await this.send('SUBSCRIBE', [stream]);
  }

  /**
   * Reads the resting size at the top price levels of one contract, right now.
   * Subscribes to `{symbol}@depth5` (Gemini pushes a snapshot about every
   * second, the first within ~300ms), takes one snapshot and unsubscribes, so
   * expired hourly contracts never pile up as subscriptions. Rejects if nothing
   * arrives in time: the caller must not trade blind.
   */
  depth(symbol: string, timeoutMs = 4000): Promise<DepthSnapshot> {
    const key = symbol.toUpperCase();
    const running = this.depthReads.get(key);
    if (running) return running;
    const read = this.readDepth(symbol, key, timeoutMs).finally(() => this.depthReads.delete(key));
    this.depthReads.set(key, read);
    return read;
  }

  private async readDepth(symbol: string, key: string, timeoutMs: number): Promise<DepthSnapshot> {
    await this.connect();
    const stream = `${symbol}@depth5`;
    const snapshot = new Promise<DepthSnapshot>((resolve, reject) => {
      const onDepth = (d: DepthSnapshot) => {
        if (d.symbol !== key) return;
        cleanup();
        resolve(d);
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`Gemini WebSocket closed before the order book for ${symbol} arrived`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`No order-book depth arrived for ${symbol} within ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('depth', onDepth);
        this.off('close', onClose);
      };
      this.on('depth', onDepth);
      this.on('close', onClose);
    });
    snapshot.catch(() => undefined); // the awaiting caller reports it; this stops a stray "unhandled" warning
    try {
      await this.send('SUBSCRIBE', [stream]);
      return await snapshot;
    } finally {
      if (this.isOpen) this.send('UNSUBSCRIBE', [stream]).catch(() => undefined);
    }
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderAck> {
    await this.connect();
    const result = (await this.send('order.place', { ...params, type: 'LIMIT' })) as Record<string, unknown>;
    return { orderId: String(result.orderId ?? ''), status: String(result.status ?? ''), symbol: String(result.symbol ?? '') };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.connect();
    await this.send('order.cancel', { orderId });
  }

  /**
   * Resolves with the last update once the tagged order reaches a terminal
   * state, or with null on timeout. Call BEFORE placing the order so no event
   * is missed. This is the fast path only; REST order history is the record.
   */
  waitForTerminal(clientOrderId: string, timeoutMs: number): Promise<OrderUpdate | null> {
    return new Promise((resolve) => {
      const onUpdate = (u: OrderUpdate) => {
        if (u.clientOrderId !== clientOrderId || !TERMINAL.has(u.status)) return;
        // An IOC order reports FILLED and then CANCELED for the remainder; either is terminal.
        cleanup();
        resolve(u);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('orderUpdate', onUpdate);
      };
      this.on('orderUpdate', onUpdate);
    });
  }
}
