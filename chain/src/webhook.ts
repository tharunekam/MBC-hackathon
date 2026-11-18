/**
 * QuickNode Streams delivers to POST /hooks/quicknode. This file decides whether a delivery is
 * authentic and pulls the transaction signatures out of it. It never trusts the payload's contents:
 * the service re-reads each signature from Solana.
 *
 * Authentication, either of:
 *  1. A shared token sent as `Authorization: Bearer <token>` or `X-Given-Token` (set it as a custom
 *     header on the Stream's destination). This needs nothing from QuickNode beyond custom headers.
 *  2. QuickNode's signature headers (`X-QN-Nonce`, `X-QN-Timestamp`, `X-QN-Signature`): an HMAC-SHA256 of
 *     nonce + timestamp + body keyed by the stream's security token. The construction (hex digest, key = the
 *     token's UTF-8 bytes) is from QuickNode's webhook-validation guide and is tested here, but has NOT been checked against
 *     a live delivery; confirm it on the first real one. The shared token is the path that does not depend on it.
 * With neither configured, deliveries are refused unless GIVEN_HOOK_INSECURE=1 (local testing only).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface HookAuth {
  token?: string;
  qnSecurityToken?: string;
  insecure?: boolean;
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

type Headers = Record<string, string | string[] | undefined>;
const one = (h: Headers, name: string): string => {
  const v = h[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
};

export function hookAuthentic(headers: Headers, rawBody: string, auth: HookAuth, nowMs = Date.now()): boolean {
  if (auth.token) {
    const bearer = one(headers, 'authorization').replace(/^Bearer\s+/i, '');
    if (same(bearer, auth.token) || same(one(headers, 'x-given-token'), auth.token)) return true;
  }
  if (auth.qnSecurityToken) {
    const nonce = one(headers, 'x-qn-nonce');
    const timestamp = one(headers, 'x-qn-timestamp');
    const signature = one(headers, 'x-qn-signature');
    if (nonce && timestamp && signature) {
      // Refuse stale deliveries (replay). The timestamp may be in seconds or milliseconds.
      const t = Number(timestamp);
      const ms = t > 1e12 ? t : t * 1000;
      if (Number.isFinite(ms) && Math.abs(nowMs - ms) <= 5 * 60_000) {
        const mac = () => createHmac('sha256', auth.qnSecurityToken!).update(nonce + timestamp + rawBody);
        if (same(signature, mac().digest('hex')) || same(signature, mac().digest('base64'))) return true;
      }
    }
  }
  return auth.insecure === true && !auth.token && !auth.qnSecurityToken;
}

const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const MAX_SIGNATURES = 50;

/** Collects transaction signatures from whatever shape the Stream's filter returned. */
export function signaturesIn(payload: unknown): string[] {
  const found = new Set<string>();
  const visit = (v: unknown, depth: number): void => {
    if (found.size >= MAX_SIGNATURES || depth > 6) return;
    if (typeof v === 'string') {
      if (SIG.test(v)) found.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const key of ['sig', 'signature', 'signatures', 'sigs', 'data']) if (key in o) visit(o[key], depth + 1);
    }
  };
  visit(payload, 0);
  return [...found];
}
