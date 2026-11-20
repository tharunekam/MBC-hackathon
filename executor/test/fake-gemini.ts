/**
 * A local stand-in for Gemini's prediction-market API that speaks the REAL wire protocol, so the real client code
 * (request signing, the WebSocket session, order placement, order history paging) runs end to end with no keys.
 *
 * It enforces what Gemini enforces and what a first run trips over:
 *  - REST requests must carry a valid HMAC-SHA384 signature over the base64 payload, with the key's secret;
 *  - the nonce is Unix SECONDS and must be within 30s of the server's clock (the key must be a time-based-nonce key);
 *  - the WebSocket upgrade is authenticated the same way (a bad key is refused with HTTP 401);
 *  - private order events are only delivered after `orders@account` has been subscribed and acknowledged;
 *  - order ids are bare 18-digit JSON numbers (too big for a JS number), order history is paged 50 at a time.
 *
 * It is written from the documented protocol and the client's own notes, so it proves the client is self-consistent
 * and survives the failures below; it cannot prove Gemini agrees. The sandbox run does that.
 *
 * Faults: `rejectNext`, `dropAfterPlace`, `nowOffsetSec`, `hideOrders`, `failStatusNext` (an order answered with a status
 * instead of the ack, with or without the order having run), `dropBeforeAck` (the order runs, the socket closes unanswered).
 */
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { GeminiEvent, GeminiOrderRecord } from '../src/gemini/types.ts';

export interface Book {
  bid: number | null;
  bidSize: number;
  ask: number | null;
  askSize: number;
}

export interface FakeGeminiOptions {
  apiKey: string;
  apiSecret: string;
  /** The events, or a function returning them fresh each time (so a test can resolve one and the API sees it). */
  events: GeminiEvent[] | (() => Promise<GeminiEvent[]>);
  /** YES-space books by upper-case symbol. */
  books: Map<string, Book>;
  cash?: number;
}

const sign = (secret: string, payload: string) => createHmac('sha384', secret).update(payload).digest('hex');

export async function startFakeGemini(opts: FakeGeminiOptions) {
  const orders: Array<GeminiOrderRecord & { rawId: string }> = [];
  // hideOrders: accepted orders do not show in the REST order lists (a lagging history), so placing one cannot confirm it.
  const state = {
    rejectNext: null as string | null,
    /** The next order is answered with this status (and an error body) instead of the ack. `ran`: the order was executed first, as a gateway that fails after its backend worked would. */
    failStatusNext: null as { status: number; ran: boolean } | null,
    /** The next order is executed and the socket is closed without any answer. */
    dropBeforeAck: false,
    dropAfterPlace: false,
    hideOrders: false,
    nowOffsetSec: 0,
    nextId: 0n,
    requests: [] as string[],
    wsAuthFailures: 0,
    ordersSubscribed: false,
  };
  const serverNow = () => Math.floor(Date.now() / 1000) + state.nowOffsetSec;
  const newId = () => String(123456789012345000n + ++state.nextId * 7n); // ends in digits a JS number would round

  const authError = (headers: IncomingMessage['headers'], path: string): { status: number; reason: string; message: string } | null => {
    const key = headers['x-gemini-apikey'];
    const payload = headers['x-gemini-payload'];
    const signature = headers['x-gemini-signature'];
    if (typeof key !== 'string' || typeof payload !== 'string' || typeof signature !== 'string') return { status: 400, reason: 'MissingHeaders', message: 'Missing API key, payload or signature header' };
    if (key !== opts.apiKey) return { status: 400, reason: 'InvalidApiKey', message: 'The API key is not valid' };
    if (sign(opts.apiSecret, payload) !== signature) return { status: 400, reason: 'InvalidSignature', message: 'The signature does not match the payload' };
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    let nonce: number;
    try {
      const body = JSON.parse(decoded) as { request?: string; nonce?: number };
      if (path !== '' && body.request !== path) return { status: 400, reason: 'InvalidSignature', message: 'The signed request path does not match' };
      nonce = Number(body.nonce ?? decoded);
    } catch {
      nonce = Number(decoded);
    }
    if (!Number.isFinite(nonce) || Math.abs(nonce - serverNow()) > 30) return { status: 400, reason: 'InvalidNonce', message: `Nonce ${nonce} is not within 30 seconds of the server time` };
    return null;
  };

  const readBody = (req: IncomingMessage): Record<string, unknown> => {
    const payload = req.headers['x-gemini-payload'];
    return typeof payload === 'string' ? (JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<string, unknown>) : {};
  };

  const json = (res: import('node:http').ServerResponse, status: number, body: string) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  };

  const eventsNow = async (): Promise<GeminiEvent[]> => (typeof opts.events === 'function' ? opts.events() : opts.events);
  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    state.requests.push(`${req.method} ${url.pathname}`);
    if (req.method === 'GET' && url.pathname === '/v1/prediction-markets/events') {
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return json(res, 200, JSON.stringify({ data: (await eventsNow()).slice(offset, offset + limit) }));
    }
    const one = /^\/v1\/prediction-markets\/events\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && one) {
      const ev = (await eventsNow()).find((e) => e.ticker === decodeURIComponent(one[1]!));
      return ev ? json(res, 200, JSON.stringify(ev)) : json(res, 404, JSON.stringify({ result: 'error', reason: 'EventNotFound' }));
    }
    // Everything below is private.
    const err = authError(req.headers, url.pathname);
    if (err) return json(res, err.status, JSON.stringify({ result: 'error', reason: err.reason, message: err.message }));
    if (url.pathname === '/v1/balances') return json(res, 200, JSON.stringify([{ type: 'exchange', currency: 'USD', amount: (opts.cash ?? 1000).toFixed(2), available: (opts.cash ?? 1000).toFixed(2) }]));
    if (url.pathname === '/v1/prediction-markets/terms/status') return json(res, 200, JSON.stringify({ hasAcceptedLatest: true }));
    if (url.pathname === '/v1/prediction-markets/orders/active') {
      return json(res, 200, JSON.stringify({ orders: orders.filter((o) => o.status === 'open' && !state.hideOrders).map(toWire) }).replace(/"orderId":"(\d+)"/g, '"orderId":$1'));
    }
    if (url.pathname === '/v1/prediction-markets/orders/history') {
      const body = readBody(req);
      const limit = Number(body.limit ?? 50);
      const offset = Number(body.offset ?? 0);
      const newestFirst = orders.filter((o) => o.status !== 'open' && !state.hideOrders).slice().reverse();
      return json(res, 200, JSON.stringify({ orders: newestFirst.slice(offset, offset + limit).map(toWire) }).replace(/"orderId":"(\d+)"/g, '"orderId":$1'));
    }
    if (url.pathname === '/v1/prediction-markets/positions') return json(res, 200, JSON.stringify({ positions: [] }));
    return json(res, 404, JSON.stringify({ result: 'error', reason: 'NotFound' }));
  });

  const toWire = (o: GeminiOrderRecord & { rawId: string }): GeminiOrderRecord => {
    const { rawId, ...rest } = o;
    return { ...rest, orderId: rawId, globalOrderId: rawId };
  };

  const wss = new WebSocketServer({
    noServer: true,
  });
  http.on('upgrade', (req, socket, head) => {
    const err = authError(req.headers, '');
    if (err) {
      state.wsAuthFailures++;
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const depthOf = (symbol: string) => {
    const b = opts.books.get(symbol.toUpperCase());
    return { lastUpdateId: Date.now(), symbol: symbol.toLowerCase(), bids: b?.bid != null ? [[b.bid.toFixed(4), b.bidSize.toFixed(2)]] : [], asks: b?.ask != null ? [[b.ask.toFixed(4), b.askSize.toFixed(2)]] : [] };
  };

  wss.on('connection', (ws: WebSocket) => {
    let subscribedOrders = false;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string; params: unknown };
      if (msg.method === 'SUBSCRIBE' || msg.method === 'UNSUBSCRIBE') {
        for (const stream of msg.params as string[]) {
          if (msg.method === 'SUBSCRIBE' && stream === 'orders@account') subscribedOrders = true;
        }
        ws.send(JSON.stringify({ id: msg.id, status: 200 }));
        for (const stream of msg.params as string[]) {
          if (msg.method === 'SUBSCRIBE' && stream.endsWith('@depth5')) ws.send(JSON.stringify(depthOf(stream.replace('@depth5', ''))));
        }
        return;
      }
      if (msg.method === 'order.cancel') return ws.send(JSON.stringify({ id: msg.id, status: 200, result: {} }));
      if (msg.method !== 'order.place') return ws.send(JSON.stringify({ id: msg.id, status: 400, error: { message: `unknown method ${msg.method}` } }));

      const p = msg.params as { symbol: string; side: 'BUY' | 'SELL'; eventOutcome: 'YES' | 'NO'; price: string; quantity: string; timeInForce: 'IOC' | 'GTC'; clientOrderId: string };
      if (state.rejectNext) {
        const reason = state.rejectNext;
        state.rejectNext = null;
        return ws.send(JSON.stringify({ id: msg.id, status: 400, error: { code: 1013, msg: reason } }));
      }
      const fault = state.failStatusNext;
      state.failStatusNext = null;
      if (fault && !fault.ran) return ws.send(JSON.stringify({ id: msg.id, status: fault.status, error: { code: 9000 + fault.status, msg: 'upstream failure' } }));
      const book = opts.books.get(p.symbol.toUpperCase());
      const limit = Number(p.price);
      const want = Number(p.quantity);
      // What this order can take: a BUY lifts the ask of its outcome; a SELL hits the bid of its outcome.
      let price: number | null = null;
      let size = 0;
      if (book) {
        if (p.side === 'BUY' && p.eventOutcome === 'YES') [price, size] = [book.ask, book.askSize];
        if (p.side === 'BUY' && p.eventOutcome === 'NO') [price, size] = [book.bid === null ? null : 1 - book.bid, book.bidSize];
        if (p.side === 'SELL' && p.eventOutcome === 'YES') [price, size] = [book.bid, book.bidSize];
        if (p.side === 'SELL' && p.eventOutcome === 'NO') [price, size] = [book.ask === null ? null : 1 - book.ask, book.askSize];
      }
      const crosses = price !== null && (p.side === 'BUY' ? price <= limit + 1e-9 : price >= limit - 1e-9);
      const filled = crosses ? Math.min(want, size) : 0;
      const rawId = newId();
      const status = filled >= want ? 'filled' : p.timeInForce === 'GTC' ? 'open' : 'cancelled';
      orders.push({
        orderId: rawId, rawId, globalOrderId: rawId, clientOrderId: p.clientOrderId, status, symbol: p.symbol.toUpperCase(), side: p.side.toLowerCase() as 'buy' | 'sell', outcome: p.eventOutcome.toLowerCase() as 'yes' | 'no',
        quantity: want.toFixed(2), filledQuantity: filled.toFixed(2), remainingQuantity: (want - filled).toFixed(2), price: p.price, avgExecutionPrice: filled > 0 && price !== null ? price.toFixed(4) : null, timeInForce: p.timeInForce, createdAt: new Date().toISOString(),
      });
      if (state.dropBeforeAck) {
        state.dropBeforeAck = false;
        ws.terminate();
        return;
      }
      // The ack carries the id as a bare number, exactly as Gemini does. A fault answers with a status instead.
      if (fault) ws.send(JSON.stringify({ id: msg.id, status: fault.status, error: { code: 9000 + fault.status, msg: 'upstream failure' } }));
      else ws.send(`{"id":${msg.id},"status":200,"result":{"orderId":${rawId},"status":"accepted","symbol":"${p.symbol.toLowerCase()}"}}`);
      if (state.dropAfterPlace) {
        state.dropAfterPlace = false;
        ws.terminate();
        return;
      }
      if (subscribedOrders) {
        const upd = (x: string, avg?: string) => `{"e":"orderUpdate","s":"${p.symbol.toLowerCase()}","i":${rawId},"c":"${p.clientOrderId}","S":"${p.side}","O":"${p.eventOutcome}","X":"${x}"${avg ? `,"a":"${avg}"` : ''}}`;
        if (filled > 0) ws.send(upd('FILLED', price!.toFixed(4)));
        if (filled < want && p.timeInForce === 'IOC') ws.send(upd('CANCELED'));
      }
    });
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    orders,
    state,
    /** Makes `n` older orders, as a long-lived account would have, to exercise paging. */
    seedHistory(n: number) {
      for (let i = 0; i < n; i++) {
        const id = newId();
        orders.unshift({ orderId: id, rawId: id, clientOrderId: `old-${i}`, status: 'filled', symbol: 'GEMI-OLD-HI1', side: 'buy', outcome: 'yes', quantity: '1.00', filledQuantity: '1.00', price: '0.50', avgExecutionPrice: '0.5000', createdAt: '2026-11-01T00:00:00Z' });
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
