// QuickNode Streams webhook authentication and body handling.
// Signed string is nonce + timestamp + payload, HMAC-SHA256 keyed with the
// stream's security token, hex digest in X-QN-Signature. For gzip deliveries
// the signature covers the decompressed JSON.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { IncomingMessage } from 'node:http';

export function signQuickNode(token: string, nonce: string, timestamp: string, payload: string): string {
  return createHmac('sha256', token).update(nonce + timestamp + payload).digest('hex');
}

export interface VerifyInput {
  token: string;
  nonce: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  payload: string;
  /** Reject deliveries whose timestamp is further than this from now. 0 disables. */
  maxSkewSec?: number;
  nowMs?: number;
}

export function verifyQuickNode(v: VerifyInput): boolean {
  if (!v.nonce || !v.timestamp || !v.signature) return false;
  const maxSkew = v.maxSkewSec ?? 300;
  if (maxSkew > 0) {
    const raw = Number(v.timestamp);
    if (!Number.isFinite(raw)) return false;
    const tsMs = raw > 1e12 ? raw : raw * 1000;
    if (Math.abs((v.nowMs ?? Date.now()) - tsMs) > maxSkew * 1000) return false;
  }
  const expected = Buffer.from(signQuickNode(v.token, v.nonce, v.timestamp, v.payload), 'hex');
  const given = Buffer.from(v.signature, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export class BodyTooLarge extends Error {}

/** Reads the request body, transparently gunzipping, with a hard size cap. */
export async function readBody(req: IncomingMessage, maxBytes = 16 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks);
  if (req.headers['content-encoding'] !== 'gzip') return raw.toString('utf8');
  const out = gunzipSync(raw, { maxOutputLength: maxBytes });
  return out.toString('utf8');
}
