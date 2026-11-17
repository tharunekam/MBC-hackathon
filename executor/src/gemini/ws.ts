import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Credentials } from '../config.ts';
import { wsHeaders } from './auth.ts';
import type { BookTicker, OrderUpdate } from './types.ts';

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

export interface PlaceOrderAck {
  orderId: string;
  status: string;
  symbol: string;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * One authenticated WebSocket session to Gemini.
 *
 * Emits:
 *   'orderUpdate' (OrderUpdate)  - from the private `orders@account` stream
 *   'bookTicker'  (BookTicker)   - best bid/ask for subscribed symbols
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
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Gemini WebSocket is not open'));
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
      if (msg.status === 200) p.resolve(msg.result ?? {});
      else p.reject(new Error(`Gemini rejected the request: ${JSON.stringify(msg.error ?? msg).slice(0, 300)}`));
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
