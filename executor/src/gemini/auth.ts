import { createHmac } from 'node:crypto';

/**
 * Gemini signs requests with HMAC-SHA384 over a base64 payload.
 * The API key used here has "time-based nonce" enabled, so the nonce is the
 * current Unix time in SECONDS (Gemini accepts it within +/- 30s).
 */
export function nowNonce(now: number = Date.now()): number {
  return Math.floor(now / 1000);
}

function sign(secret: string, b64: string): string {
  return createHmac('sha384', secret).update(b64).digest('hex');
}

/** Headers for a private REST call. `fields` are merged into the signed payload. */
export function restHeaders(
  apiKey: string,
  apiSecret: string,
  path: string,
  fields: Record<string, unknown> = {},
  now: number = Date.now(),
): Record<string, string> {
  const payload = Buffer.from(JSON.stringify({ request: path, nonce: nowNonce(now), ...fields })).toString('base64');
  return {
    'Content-Type': 'text/plain',
    'Content-Length': '0',
    'Cache-Control': 'no-cache',
    'X-GEMINI-APIKEY': apiKey,
    'X-GEMINI-PAYLOAD': payload,
    'X-GEMINI-SIGNATURE': sign(apiSecret, payload),
  };
}

/** Headers for the authenticated WebSocket upgrade. */
export function wsHeaders(apiKey: string, apiSecret: string, now: number = Date.now()): Record<string, string> {
  const nonce = String(nowNonce(now));
  const payload = Buffer.from(nonce).toString('base64');
  return {
    'X-GEMINI-APIKEY': apiKey,
    'X-GEMINI-NONCE': nonce,
    'X-GEMINI-PAYLOAD': payload,
    'X-GEMINI-SIGNATURE': sign(apiSecret, payload),
  };
}
