// HTTP surface of the chain service (docs/CONTRACTS.md): the QuickNode Streams
// webhook in; calls, the leaderboard and a live SSE stream out.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError, type CallService } from './calls.ts';
import { BodyTooLarge, readBody, verifyQuickNode } from './qn.ts';
import { collectTxs, extractProgramData } from './logs.ts';
import { ReceiptStore, type Receipt, type ReceiptSource } from './store.ts';

export type Decoder = (raw: Buffer) => Record<string, unknown> | null;
export type Scorer = (receipts: Receipt[]) => unknown;

export interface FeedOptions {
  programId: string;
  /** Stream security token. Deliveries that fail verification get 401. */
  securityToken: string;
  store: ReceiptStore;
  decode: Decoder;
  score: Scorer;
  /** Without it the service still receives the Stream and serves the leaderboard. */
  calls?: CallService;
  /** `GET /calls` with no `user` lists this executor user's calls. Unset: everyone's. */
  defaultUser?: string;
  /** Web origins, besides this machine, that may commit and reveal. */
  corsOrigins?: string[];
  /**
   * For the listener the internet can reach (the Stream's destination): the
   * webhook and public reads only. Committing, revealing and listing calls
   * answer 404, because nothing here can tell whose request it is.
   */
  publicOnly?: boolean;
  maxSkewSec?: number;
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function ingest(
  payload: unknown,
  opts: Pick<FeedOptions, 'programId' | 'store' | 'decode'>,
  source: ReceiptSource = 'quicknode-stream',
): number {
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
        source,
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
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const origin = header(req, 'origin');
    // Reads are public. Writes publish a user's call, so a page on another site must not be able to trigger them.
    const mayWrite = origin === undefined || LOCAL_ORIGIN.test(origin) || (opts.corsOrigins ?? []).includes(origin);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'access-control-allow-origin': req.method === 'GET' || !origin || !mayWrite ? '*' : origin,
        vary: 'origin',
      });
      res.end(JSON.stringify(body));
    };
    const fail = (status: number, code: string, error: string): void => json(status, { error, code });

    try {
      if (req.method === 'POST' && path === '/hooks/quicknode') {
        const payload = await readBody(req);
        const ok = verifyQuickNode({
          token: opts.securityToken,
          nonce: header(req, 'x-qn-nonce'),
          timestamp: header(req, 'x-qn-timestamp'),
          signature: header(req, 'x-qn-signature'),
          payload,
          maxSkewSec: opts.maxSkewSec,
        });
        if (!ok) return fail(401, 'bad_signature', 'The delivery is not signed with this stream\'s security token.');
        return json(200, { ingested: ingest(JSON.parse(payload), opts) });
      }

      const call = /^\/calls(?:\/([^/]+))?(\/reveal)?$/.exec(path);
      if (opts.publicOnly && call && (req.method !== 'GET' || !call[1] || call[2])) {
        return fail(404, 'not_found', 'Calls are recorded and listed on the private port only.');
      }

      if (req.method === 'OPTIONS' && call) {
        if (!mayWrite) return fail(403, 'forbidden_origin', 'This site may not record calls.');
        res.writeHead(204, {
          'access-control-allow-origin': origin ?? '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
          vary: 'origin',
        });
        return void res.end();
      }

      if (req.method === 'POST' && call) {
        if (!mayWrite) return fail(403, 'forbidden_origin', 'This site may not record calls.');
        if (!opts.calls) return fail(503, 'chain_unavailable', 'Calls are not set up on this server.');
        const [, id, reveal] = call;
        if (id && reveal) return json(200, await opts.calls.reveal(id));
        if (id) return fail(405, 'method_not_allowed', 'Use POST /calls/:id/reveal.');
        const body = JSON.parse((await readBody(req, 64 * 1024)) || '{}') as { betId?: unknown };
        if (typeof body.betId !== 'string' || body.betId === '') return fail(400, 'missing_bet', 'Say which bet: "betId" is required.');
        return json(200, await opts.calls.commit(body.betId));
      }

      if (req.method !== 'GET') return fail(405, 'method_not_allowed', 'Method not allowed.');

      if (path === '/health' || path === '/healthz') return json(200, { ok: true, receipts: store.size, calls: opts.calls !== undefined });

      if (call && !call[2]) {
        if (!opts.calls) return fail(503, 'chain_unavailable', 'Calls are not set up on this server.');
        if (!call[1]) return json(200, { calls: await opts.calls.list(url.searchParams.get('user') ?? opts.defaultUser) });
        const found = opts.calls.get(call[1]);
        return found ? json(200, found) : fail(404, 'not_found', 'No such call.');
      }

      if (path === '/receipts') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 1000);
        return json(200, store.all().slice(-limit).reverse());
      }

      if (path === '/leaderboard') return json(200, opts.score(store.all()));

      if (path === '/events') {
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

      return fail(404, 'not_found', `No such endpoint: ${path}. Try /calls, /leaderboard, /receipts, /events or /health.`);
    } catch (err) {
      if (err instanceof ApiError) return fail(err.status, err.code, err.message);
      if (err instanceof BodyTooLarge) return fail(413, 'too_large', 'Payload too large.');
      if (err instanceof SyntaxError) return fail(400, 'bad_json', 'The body is not valid JSON.');
      console.error(err);
      return fail(500, 'internal', 'Something went wrong on the server.');
    }
  });
}
