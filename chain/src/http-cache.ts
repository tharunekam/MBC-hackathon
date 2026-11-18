/**
 * Conditional GETs and compression for JSON answers.
 *
 * The validator (ETag) is a hash of the body with its volatile timestamps removed, so an answer that has not really
 * changed keeps the same ETag and costs the client a 304 instead of the whole body. Compression is applied only above a
 * size where it pays for itself.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/** Keys that change on every request without the answer changing. Removed (top level only) before hashing. */
const VOLATILE = new Set(['asOf', 'time', 'checkedAt']);

export function etagOf(body: unknown): string {
  const stable =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([k]) => !VOLATILE.has(k)))
      : body;
  return `W/"${createHash('sha1').update(JSON.stringify(stable)).digest('base64url').slice(0, 22)}"`;
}

/** True when the client's If-None-Match already names this ETag. */
export function notModified(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  const header = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : (ifNoneMatch ?? '');
  if (header.trim() === '') return false;
  if (header.trim() === '*') return true;
  const strip = (t: string) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => strip(t) === strip(etag));
}

const MIN_GZIP_BYTES = 1024;

/** The body as bytes, gzipped when the client accepts it and it is large enough to matter. */
export function encodeBody(json: string, acceptEncoding: string | string[] | undefined): { body: Buffer; encoding: 'gzip' | null } {
  const raw = Buffer.from(json, 'utf8');
  const accepts = /\bgzip\b/i.test(Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : (acceptEncoding ?? ''));
  if (!accepts || raw.length < MIN_GZIP_BYTES) return { body: raw, encoding: null };
  return { body: gzipSync(raw, { level: 6 }), encoding: 'gzip' };
}
