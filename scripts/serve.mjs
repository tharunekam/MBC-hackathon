#!/usr/bin/env node
/**
 * The hosted demo, in one process tree:  node scripts/serve.mjs
 *
 *   public port  PORT (default 8080)   the built web app (web/dist) and a fixed allowlist of API paths
 *   executor     127.0.0.1:8741        Gemini orders, quotes, ledger (never public)
 *   chain        127.0.0.1:8742        Solana records and the leaderboard (never public)
 *
 * Mode (GIVEN_MODE):
 *   live    real Gemini SANDBOX executor + Solana DEVNET chain service. Needs GEMINI_API_KEY / GEMINI_API_SECRET and the
 *           authority key (a file in the chain data folder, or GIVEN_AUTHORITY_KEY holding its JSON array).
 *   quotes  real Gemini sandbox prices and order books, no account: bets are switched off. In-memory test chain by
 *           default; GIVEN_QUOTES_CHAIN=devnet opts in to real devnet ingestion using the existing authority key.
 *   fake    the local test exchange and the in-memory test chain. Staging only; it labels itself as a test everywhere.
 *   auto    (default) live when the keys are present, otherwise quotes. The page says which one it is.
 *   replay  no executor, no chain service, no keys, no network: the app is answered from a session recorded earlier
 *           (GIVEN_REPLAY=<file>). The stage fallback. The page says "Replay" and when it was recorded.
 *
 * GIVEN_RECORD=<file> (any mode but replay) records the session for that: every answer the app receives, as it happens.
 *
 * Hosted protections are always on here: one pinned account, a stake cap, a per-client rate limit, and only the paths
 * listed in scripts/lib/edge.mjs reach the backends. Set GIVEN_PUBLIC_URL to the address people will use (it is the one
 * browser origin the backends accept). Build the web app first:  npm run build
 */
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientAddress, proxy, resolveStatic, route, serveStatic, shellWithPublicImage } from './lib/edge.mjs';
import { Replayer, SNAPSHOT, STREAMS, entry, header, parseRecording, recordable } from './lib/replay.mjs';
import { hostedModeSettings } from './lib/hosted-mode.mjs';
import { loadProjectEnv } from './lib/project-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.GIVEN_NO_PROJECT_ENV !== '1') loadProjectEnv(resolve(ROOT, '.env')); // the tests set it, so a developer's real .env never leaks into them
const env = process.env;

const PORT = Number(env.PORT ?? 8080);
const HOST = env.HOST ?? '0.0.0.0';
const EXEC_PORT = Number(env.GIVEN_INTERNAL_EXECUTOR_PORT ?? 8741);
const CHAIN_PORT = Number(env.GIVEN_INTERNAL_CHAIN_PORT ?? 8742);
const DIST = resolve(env.GIVEN_WEB_DIST ?? resolve(ROOT, 'web/dist'));
const TRUST_PROXY = env.GIVEN_EDGE_TRUST_PROXY === '1';
const PUBLIC_URL = (env.GIVEN_PUBLIC_URL ?? '').replace(/\/+$/, '');
const DATA_ROOT = env.GIVEN_DATA_ROOT ? resolve(env.GIVEN_DATA_ROOT) : null;
const chainData = DATA_ROOT ? resolve(DATA_ROOT, 'chain') : env.GIVEN_CHAIN_DATA_DIR ? resolve(env.GIVEN_CHAIN_DATA_DIR) : resolve(ROOT, 'chain/data');
const execData = DATA_ROOT ? resolve(DATA_ROOT, 'executor') : env.GIVEN_DATA_DIR ? resolve(env.GIVEN_DATA_DIR) : resolve(ROOT, 'executor/data');

const fail = (msg) => {
  console.error(`\nCannot start: ${msg}\n`);
  process.exit(1);
};

// ------------------------------------------------------------------------------------------------ settings

if (!existsSync(resolve(DIST, 'index.html'))) fail(`there is no built web app at ${DIST}. Run: npm run build`);
// The page as it is served: with the public address in front of its link-preview picture when one is configured.
const shell = shellWithPublicImage(readFileSync(resolve(DIST, 'index.html'), 'utf8'), PUBLIC_URL);
if (!PUBLIC_URL && HOST !== '127.0.0.1') fail('GIVEN_PUBLIC_URL is not set. It is the address people open (for example https://given.example.com), and the one browser origin the backends accept; without it every bet from the page would be refused.');
if (PUBLIC_URL && !/^https?:\/\/[^/]+$/.test(PUBLIC_URL)) fail('GIVEN_PUBLIC_URL must be an origin with no path.');

const haveGeminiKeys = Boolean(env.GEMINI_API_KEY && env.GEMINI_API_SECRET);
// The authority key may arrive as a secret in the environment; it is written once to a private file and never overwritten.
const keyFile = resolve(chainData, 'authority.json');
// The quotes/devnet indexer must not write an authority secret to disk.
const quotesDevnet = env.GIVEN_MODE === 'quotes' && env.GIVEN_QUOTES_CHAIN === 'devnet';
if (env.GIVEN_AUTHORITY_KEY && !existsSync(keyFile) && !quotesDevnet) {
  try {
    const bytes = JSON.parse(env.GIVEN_AUTHORITY_KEY);
    if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error('not 64 bytes');
    mkdirSync(chainData, { recursive: true });
    writeFileSync(keyFile, JSON.stringify(bytes), { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    console.log(`Wrote the authority key to ${keyFile}.`);
  } catch (err) {
    fail(`GIVEN_AUTHORITY_KEY is not the JSON array of a 64-byte Solana keypair (${err.message}).`);
  }
}
const haveAuthority = existsSync(keyFile);

let mode = env.GIVEN_MODE ?? 'auto';
if (!['auto', 'live', 'quotes', 'fake', 'replay'].includes(mode)) fail(`GIVEN_MODE must be auto, live, quotes, fake or replay, not "${mode}".`);

// A recorded session to replay with nothing behind it, or a file to record this session into (scripts/lib/replay.mjs).
let replayer = null;
if (mode === 'replay') {
  if (!env.GIVEN_REPLAY) fail('replay mode needs GIVEN_REPLAY: the file a session was recorded into (run once with GIVEN_RECORD=<file>).');
  try {
    replayer = new Replayer(parseRecording(readFileSync(resolve(env.GIVEN_REPLAY), 'utf8')), { steps: Number(env.GIVEN_REPLAY_STEPS ?? 12) });
  } catch (err) {
    fail(`the recording at ${env.GIVEN_REPLAY} cannot be used: ${err.message}`);
  }
}
let record = null;
if (env.GIVEN_RECORD && mode !== 'replay') {
  const file = resolve(env.GIVEN_RECORD);
  if (existsSync(file) && statSync(file).size > 0) fail(`${file} already holds a recording. Move it or choose another name: two sessions in one file cannot be replayed.`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${header(new Date().toISOString(), `GIVEN_MODE=${mode}`)}\n`, { mode: 0o600 });
  let seq = 0;
  record = (method, url, asked, status, answered) => appendFileSync(file, `${entry(++seq, new Date().toISOString(), method, url, asked, status, answered)}\n`);
  console.log(`Recording this session into ${file} (what the page is shown; never a key or a salt).`);
}
if (mode === 'auto') mode = haveGeminiKeys && haveAuthority ? 'live' : 'quotes';
let modeSettings;
try {
  modeSettings = hostedModeSettings(mode, env.GIVEN_QUOTES_CHAIN || 'fake');
} catch (err) {
  fail(err.message);
}
if (mode === 'live') {
  if (!haveGeminiKeys) fail('live mode needs GEMINI_API_KEY and GEMINI_API_SECRET (Gemini sandbox keys).');
  if (!haveAuthority) fail(`live mode needs the Solana authority key at ${keyFile}, or GIVEN_AUTHORITY_KEY. Create one with: cd chain && npm run keygen`);
  if (env.GEMINI_BASE_URL && !/sandbox/.test(env.GEMINI_BASE_URL)) fail('this server is for the Gemini sandbox. GEMINI_BASE_URL points elsewhere.');
}
if (mode === 'quotes' && modeSettings.chain === 'devnet' && !haveAuthority) {
  fail(`quotes mode with a devnet chain needs an existing Solana authority key file at ${keyFile}.`);
}
if (mode === 'fake' && env.GIVEN_I_KNOW_THIS_IS_A_TEST !== '1' && HOST !== '127.0.0.1') {
  fail('fake mode shows a local test exchange and is only for staging. Set GIVEN_I_KNOW_THIS_IS_A_TEST=1 to run it on a public address.');
}

// The liquidity seeder (executor/src/seeder.ts): our own SECOND sandbox account resting tight quotes, so bets fill at a
// production-like price and size. Opt-in. Running it here is what switches the app's "Seeded prices" label on, so the
// two cannot come apart.
const seeding = env.GIVEN_SEEDER === '1';
if (seeding) {
  if (mode !== 'live') fail('GIVEN_SEEDER=1 only makes sense in live mode: the seeder rests orders on the Gemini sandbox.');
  if (!env.GEMINI_USER_SEEDER_KEY || !env.GEMINI_USER_SEEDER_SECRET) fail('GIVEN_SEEDER=1 needs GEMINI_USER_SEEDER_KEY and GEMINI_USER_SEEDER_SECRET: a second sandbox account, not the one that bets.');
  if (env.GEMINI_USER_SEEDER_KEY === env.GEMINI_API_KEY) fail('The seeder must use a different sandbox account from the one that bets.');
}

const shared = {
  GIVEN_CORS_ORIGINS: PUBLIC_URL,
  GIVEN_TRUST_PROXY: '1', // the edge below always sets one client address, so this is safe here
  GIVEN_RATE_LIMIT_PER_MIN: env.GIVEN_RATE_LIMIT_PER_MIN ?? '20',
  GIVEN_PINNED_USER: env.GIVEN_PINNED_USER ?? 'primary',
};
const exec = `http://127.0.0.1:${EXEC_PORT}`;

const services = [
  {
    name: 'exec ',
    cwd: 'executor',
    port: EXEC_PORT,
    cmd: ['node', mode === 'fake' ? 'test/serve-fake.ts' : 'src/server.ts'],
    env: {
      ...shared,
      GIVEN_HOST: '127.0.0.1',
      GIVEN_PORT: String(EXEC_PORT),
      GIVEN_DATA_DIR: execData,
      GIVEN_MAX_STAKE: env.GIVEN_MAX_STAKE ?? '25',
      ...(modeSettings.readOnly ? { GIVEN_READONLY: '1' } : {}),
      // The sandbox's books are about 20 cents wide, so without this nothing passes the value rule there. Sandbox only.
      ...(mode !== 'fake' ? { GIVEN_SANDBOX_WAIVE_MARKUP: env.GIVEN_SANDBOX_WAIVE_MARKUP ?? '1' } : {}),
      // /health then says seeded: true and the app labels its prices.
      ...(seeding ? { GIVEN_SEEDED: '1' } : {}),
      // A hosted test exchange can run in rounds that close and settle by themselves, so a visitor's bet reaches a result.
      // Only when asked for: the browser checks drive the same exchange and settle it themselves.
      ...(mode === 'fake' && env.FAKE_ROUND_MINUTES ? { FAKE_ROUND_MINUTES: env.FAKE_ROUND_MINUTES } : {}),
    },
  },
  {
    name: 'chain',
    cwd: 'chain',
    port: CHAIN_PORT,
    cmd: ['node', 'src/server.ts'],
    env: {
      ...shared,
      GIVEN_CHAIN_HOST: '127.0.0.1',
      GIVEN_CHAIN_PORT: String(CHAIN_PORT),
      GIVEN_CHAIN: modeSettings.chain,
      ...(modeSettings.indexOnly ? { GIVEN_CHAIN_INDEX_ONLY: '1' } : {}),
      GIVEN_CHAIN_DATA_DIR: chainData,
      GIVEN_EXECUTOR_URL: exec,
    },
  },
];

// ------------------------------------------------------------------------------------------------ processes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
let seeder = null;
let shuttingDown = false;
let edge = null;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  edge?.close();
  edge?.closeAllConnections?.();
  for (const c of children) c.kill('SIGTERM');
  await sleep(1200);
  // The seeder cancels every order it has resting before it exits; give it time to finish that.
  for (let waited = 0; seeder && seeder.exitCode === null && waited < 8000; waited += 200) await sleep(200);
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// A replay starts nothing: there is no exchange and no chain behind it, only the recording.
if (replayer) services.length = 0;

for (const s of services) {
  const child = spawn(s.cmd[0], s.cmd.slice(1), { cwd: resolve(ROOT, s.cwd), env: { ...env, ...s.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const tag = `[${s.name}] `;
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) console.log(tag + l);
    });
  }
  // A backend that dies takes the whole thing down, so the host restarts a known-good state instead of serving half a product.
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`${tag}exited with code ${code}; stopping so the host can restart.`);
      void shutdown(1);
    }
  });
}

async function healthOf(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const started = Date.now();
for (const s of services) {
  while (!(await healthOf(s.port))) {
    if (Date.now() - started > 45_000) fail(`${s.name.trim()} did not come up within 45 seconds. Its output is above.`);
    if (shuttingDown) process.exit(1);
    await sleep(250);
  }
}

/**
 * While recording: reads the main pages straight from the backends and adds them to the recording, at the start and after
 * every step. A replay can then show any of them at any point, whatever the person recording happened to look at.
 */
async function snapshot() {
  if (!record) return;
  for (const url of SNAPSHOT) {
    const to = route('GET', url);
    if (!to) continue;
    try {
      const r = await fetch(`http://127.0.0.1:${to.target === 'executor' ? EXEC_PORT : CHAIN_PORT}${to.path}`, { signal: AbortSignal.timeout(8000) });
      record('GET', url, '', r.status, await r.text());
    } catch {
      /* a page that could not be read just now is simply not in this snapshot */
    }
  }
}
await snapshot();

// The seeder starts once the backends are up. The demo does not depend on it (bets still work against the sandbox's own
// books), so if it stops it is restarted a while later and never takes the server down with it.
function startSeeder(attempt = 0) {
  const child = spawn('node', ['src/seed.ts', '--user', 'seeder'], { cwd: resolve(ROOT, 'executor'), env: { ...env, GIVEN_PINNED_USER: shared.GIVEN_PINNED_USER }, stdio: ['ignore', 'pipe', 'pipe'] });
  seeder = child;
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) console.log(`[seed ] ${l}`);
    });
  }
  child.on('exit', (code) => {
    children.splice(children.indexOf(child), 1);
    if (shuttingDown) return;
    if (attempt >= 20) return void console.error('[seed ] the seeder keeps stopping; not restarting it again. Bets carry on against the sandbox\'s own books.');
    console.error(`[seed ] stopped with code ${code}; starting it again in 30 seconds.`);
    setTimeout(() => {
      if (!shuttingDown) startSeeder(attempt + 1);
    }, 30_000).unref();
  });
}
if (seeding) startSeeder();

// ------------------------------------------------------------------------------------------------ the public server

edge = createServer((req, res) => {
  const url = req.url ?? '/';
  const path = url.split('?')[0];

  if (path === '/healthz') {
    if (replayer) {
      // Nothing is behind a replay to be unhealthy; say what it is and how far through the recording it has got.
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return void res.end(JSON.stringify({ ok: true, mode, recordedAt: replayer.meta.startedAt, ...replayer.progress() }));
    }
    void Promise.all([healthOf(EXEC_PORT), healthOf(CHAIN_PORT)]).then(([e, c]) => {
      const ok = Boolean(e && c);
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok, mode, venue: e?.venue ?? null, executor: Boolean(e), chain: Boolean(c), network: c?.network ?? null }));
    });
    return;
  }

  const hit = route(req.method ?? 'GET', path);
  if (hit && replayer) {
    // Answered from the recording. Live update streams are not part of one: without them the page refreshes by itself.
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Given-Replay': '1' });
      res.end(JSON.stringify(body));
    };
    if (STREAMS.has(path.replace(/\/+$/, ''))) return reply(404, { error: 'Live updates are not part of a recording.', code: 'not_in_recording' });
    const asked = [];
    req.on('data', (c) => asked.push(c));
    req.on('end', () => {
      const a = replayer.answer(req.method ?? 'GET', url, Buffer.concat(asked).toString('utf8'));
      reply(a.status, a.body);
    });
    return;
  }
  if (hit) {
    const tap =
      record && recordable(path)
        ? (asked, status, answered) => {
            record(req.method ?? 'GET', url, asked, status, answered);
            if (req.method !== 'GET') void snapshot(); // a step was taken: note what every main page shows now
          }
        : undefined;
    return proxy(req, res, { port: hit.target === 'executor' ? EXEC_PORT : CHAIN_PORT, path: hit.path, client: clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for'], TRUST_PROXY), tap });
  }
  if (path.startsWith('/api/') || path.startsWith('/chain/')) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return void res.end(JSON.stringify({ error: 'No such endpoint.', code: 'not_found' }));
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    return void res.end('Method not allowed.');
  }
  const found = resolveStatic(DIST, path);
  if (found && shell !== null && found.file.endsWith('index.html')) found.body = shell;
  if (!found) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return void res.end('Not found.');
  }
  serveStatic(req, res, found);
});
edge.on('clientError', (_e, socket) => socket.destroy());
// Streams stay open for as long as a page is; do not let the server's own idle timers cut them.
edge.requestTimeout = 0;
edge.keepAliveTimeout = 65_000;
edge.listen(PORT, HOST, () => {
  const label = { live: 'Gemini SANDBOX + Solana DEVNET', quotes: 'real Gemini sandbox prices, bets switched off', fake: 'LOCAL TEST EXCHANGE (staging)', replay: 'A RECORDED SESSION, nothing live behind it' }[mode];
  console.log(`\nGiven is up on http://${HOST}:${PORT}  [${mode}: ${label}]`);
  if (replayer) {
    const p = replayer.progress();
    console.log(`Replaying the session recorded ${replayer.meta.startedAt}: ${p.steps} step(s). First: ${p.next ?? 'none (it only looked)'}.`);
    console.log('The page says "Replay". Say so on stage too: it shows what happened then, and places nothing now.');
  }
  console.log(`Public address ${PUBLIC_URL ? 'configured' : '(GIVEN_PUBLIC_URL not set)'}   data: executor ${execData}, chain ${chainData}`);
  if (seeding) console.log('SEEDING: our own second sandbox account is resting quotes, and the app says "Seeded prices". Say so wherever this is shown.');
  if (mode === 'quotes' && !haveGeminiKeys) console.log('No Gemini keys were found, so this is the quotes-only demo. Add GEMINI_API_KEY / GEMINI_API_SECRET and the authority key for live bets.');
});
