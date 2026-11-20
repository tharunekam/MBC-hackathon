/**
 * The public face of a hosted demo: one port that serves the built web app and forwards a short, fixed list of paths to
 * the two backends, which stay on loopback. Everything else is a 404 here, so admin routes, dev routes and anything added
 * to a backend later are never reachable from outside by accident.
 *
 * Pure routing and file serving, with nothing that starts a process, so it can be tested without a network.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createGzip } from 'node:zlib';

/** What the web app may call on the executor, under /api. */
export const EXECUTOR_ROUTES = [
  ['GET', '/health'],
  ['GET', '/markets'],
  ['GET', '/quote'],
  ['GET', '/bets'],
  ['POST', '/bets'],
  ['POST', '/baskets'],
  ['GET', '/cashout'],
  ['POST', '/cashout'],
  ['POST', '/settle'],
  ['GET', '/flow'],
  ['GET', '/reconcile'],
  ['GET', '/stream'],
];

/** What the web app and QuickNode may call on the chain service, under /chain. */
export const CHAIN_ROUTES = [
  ['GET', '/health'],
  ['GET', '/events'],
  ['GET', '/calls'],
  ['POST', '/calls'],
  ['GET', '/leaderboard'],
  ['POST', '/hooks/quicknode'],
];
// Per-call routes are matched by shape: /calls/:id/reveal (POST), /calls/:id/verify (GET), /reveals/:signature (GET).
const CALL_ID = /^\/calls\/[A-Za-z0-9_-]{1,64}\/(reveal|verify)$/;
const REVEAL = /^\/reveals\/[1-9A-HJ-NP-Za-km-z]{32,100}$/;

/**
 * Where a request goes. Returns { target: 'executor' | 'chain', path } (path as the backend knows it) or null.
 * The method must match too: a path that exists for GET is not open for POST.
 */
export function route(method, rawPath) {
  const m = method.toUpperCase();
  const trim = (p) => p.replace(/\/+$/, '') || '/';
  if (rawPath.startsWith('/api/')) {
    const path = trim(rawPath.slice(4));
    return EXECUTOR_ROUTES.some(([meth, p]) => meth === m && p === path) ? { target: 'executor', path } : null;
  }
  if (rawPath.startsWith('/chain/')) {
    const path = trim(rawPath.slice(6));
    if (CHAIN_ROUTES.some(([meth, p]) => meth === m && p === path)) return { target: 'chain', path };
    const call = CALL_ID.exec(path);
    if (call && ((call[1] === 'reveal' && m === 'POST') || (call[1] === 'verify' && m === 'GET'))) return { target: 'chain', path };
    if (m === 'GET' && REVEAL.test(path)) return { target: 'chain', path };
    return null;
  }
  return null;
}

/** The address to treat as the client: the socket's, or, behind the host's own proxy, the last one that proxy appended. */
export function clientAddress(socketAddress, forwardedFor, trustProxy) {
  if (trustProxy && forwardedFor) {
    const parts = String(forwardedFor).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return socketAddress || 'unknown';
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map']);

/**
 * Maps a URL path to a file inside `root`, or null. Refuses anything that escapes the folder, dotfiles and source maps
 * are not served, and a path with no file extension falls back to index.html (the app's client-side routes).
 */
export function resolveStatic(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    // A malformed escape in a PAGE address ("/verify/%E0%A4%A") is not a file: the app shows its own not-found page, with its header and
    // a way back, instead of a bare 404. Anything that looks like an asset (it has an extension) is still a 404.
    if (extname(urlPath.split('?')[0]) !== '') return null;
    const shell = join(resolve(root), 'index.html');
    return existsSync(shell) ? { file: shell, spa: true } : null;
  }
  if (decoded.includes('\0')) return null;
  const rel = normalize(decoded).replace(/^[/\\]+/, '');
  if (rel.split(/[/\\]/).some((seg) => seg.startsWith('.') && seg !== '')) return null;
  const abs = resolve(root, rel);
  if (abs !== resolve(root) && !abs.startsWith(resolve(root) + sep)) return null;
  const ext = extname(abs);
  if (ext === '.map') return null;
  if (ext !== '' && existsSync(abs) && statSync(abs).isFile()) return { file: abs, spa: false };
  if (ext !== '') return null; // a missing asset is a real 404, not the app shell
  const index = join(resolve(root), 'index.html');
  return existsSync(index) ? { file: index, spa: true } : null;
}

/** Hashed build assets never change; the shell must always be re-checked so a new deploy is seen at once. */
export const cacheControl = (file, spa) => (spa || file.endsWith('index.html') ? 'no-cache' : /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=300');

/**
 * The app's page with the public address put in front of its link-preview picture. Sites that draw a preview of a pasted
 * link (chat apps, Devpost) want a full address for the picture and ignore a bare path. Null when there is nothing to
 * change, and the file is then served as it is.
 */
export function shellWithPublicImage(html, publicUrl) {
  if (!publicUrl || !/^https?:\/\//.test(publicUrl)) return null;
  const base = publicUrl.replace(/\/+$/, '');
  const out = html.replace(/(<meta\s+property="og:image"\s+content=")(\/[^"]*)(")/, (_m, a, path, b) => `${a}${base}${path}${b}`);
  return out === html ? null : out;
}

/** `found.body`, when set, is sent in place of the file's own bytes (the page with its public address filled in). */
export function serveStatic(req, res, found) {
  const ext = extname(found.file);
  const headers = {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control': cacheControl(found.file, found.spa),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  const gzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  if (gzip) {
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  } else headers['Content-Length'] = String(found.body !== undefined ? Buffer.byteLength(found.body) : statSync(found.file).size);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return void res.end();
  if (found.body !== undefined) {
    if (!gzip) return void res.end(found.body);
    const zip = createGzip();
    zip.pipe(res);
    return void zip.end(found.body);
  }
  const stream = createReadStream(found.file);
  stream.on('error', () => res.destroy());
  if (gzip) stream.pipe(createGzip()).pipe(res);
  else stream.pipe(res);
}

const TAP_LIMIT = 4 * 1024 * 1024;

/**
 * Forwards one request to a backend on loopback and streams the answer back unchanged (so server-sent events flow).
 * The client address is replaced, never appended to, so the backend's per-client limits see the real client and a caller
 * cannot choose it.
 */
export function proxy(req, res, { port, path, client, tap }) {
  const headers = { ...req.headers, host: `127.0.0.1:${port}`, 'x-forwarded-for': client };
  delete headers.connection;
  // `tap(requestBody, status, responseBody)` is how a session is recorded (scripts/lib/replay.mjs). So that what is recorded
  // is the whole plain answer, the backend is asked for it uncompressed and unconditionally. Never used for streams.
  const asked = [];
  if (tap) {
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
    headers['accept-encoding'] = 'identity';
    req.on('data', (c) => asked.push(c));
  }
  const upstream = httpRequest({ host: '127.0.0.1', port, path: path + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    if (tap) {
      const answered = [];
      let size = 0;
      up.on('data', (c) => {
        size += c.length;
        if (size <= TAP_LIMIT) answered.push(c);
      });
      up.on('end', () => {
        if (size > TAP_LIMIT) return; // far larger than any answer of ours: not worth a broken recording
        try {
          tap(Buffer.concat(asked).toString('utf8'), up.statusCode ?? 0, Buffer.concat(answered).toString('utf8'));
        } catch {
          /* recording must never break the request it is recording */
        }
      });
    }
    up.pipe(res);
    res.on('close', () => up.destroy());
  });
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'The service behind this page is not answering. Try again in a moment.', code: 'upstream_unavailable' }));
    } else res.destroy();
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}
