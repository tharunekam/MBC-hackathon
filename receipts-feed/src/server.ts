// HTTP surface: QuickNode Streams webhook in; receipts, leaderboard and a
// live SSE stream out.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BodyTooLarge, readBody, verifyQuickNode } from './qn.ts';
import { collectTxs, extractProgramData } from './logs.ts';
import { ReceiptStore, type Receipt } from './store.ts';

export type Decoder = (raw: Buffer) => Record<string, unknown> | null;
export type Scorer = (receipts: Receipt[]) => unknown;

export interface FeedOptions {
  programId: string;
  /** Stream security token. Deliveries that fail verification get 401. */
  securityToken: string;
  store: ReceiptStore;
  decode: Decoder;
  score: Scorer;
  maxSkewSec?: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function ingest(payload: unknown, opts: Pick<FeedOptions, 'programId' | 'store' | 'decode'>): number {
  let added = 0;
  for (const tx of collectTxs(payload)) {
    extractProgramData(tx.logs, opts.programId).forEach((raw, i) => {
      const receipt: Receipt = {
        id: `${tx.signature}:${i}`,
        signature: tx.signature,
        slot: tx.slot,
        blockTime: tx.blockTime,
        data: raw.toString('base64'),
        decoded: opts.decode(raw),
      };
      if (opts.store.add(receipt)) added++;
    });
  }
  return added;
}

export function createFeedServer(opts: FeedOptions): Server {
  const { store } = opts;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'POST' && url.pathname === '/webhooks/quicknode') {
        const payload = await readBody(req);
        const ok = verifyQuickNode({
          token: opts.securityToken,
          nonce: header(req, 'x-qn-nonce'),
          timestamp: header(req, 'x-qn-timestamp'),
          signature: header(req, 'x-qn-signature'),
          payload,
          maxSkewSec: opts.maxSkewSec,
        });
        if (!ok) return json(res, 401, { error: 'bad signature' });
        return json(res, 200, { ingested: ingest(JSON.parse(payload), opts) });
      }

      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });

      if (url.pathname === '/healthz') return json(res, 200, { ok: true, receipts: store.size });

      if (url.pathname === '/receipts') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 1000);
        return json(res, 200, store.all().slice(-limit).reverse());
      }

      if (url.pathname === '/leaderboard') return json(res, 200, opts.score(store.all()));

      if (url.pathname === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        });
        const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send('leaderboard', opts.score(store.all()));
        const onReceipt = (r: Receipt) => {
          send('receipt', r);
          send('leaderboard', opts.score(store.all()));
        };
        store.on('receipt', onReceipt);
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
        req.on('close', () => {
          clearInterval(ping);
          store.off('receipt', onReceipt);
        });
        return;
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof BodyTooLarge) return json(res, 413, { error: 'payload too large' });
      if (err instanceof SyntaxError) return json(res, 400, { error: 'invalid json' });
      console.error(err);
      return json(res, 500, { error: 'internal error' });
    }
  });
}
