#!/usr/bin/env node
/**
 * The whole golden path through the REAL code on both sides, with Gemini and Solana stood in on the wire.
 *
 *   npm run rehearse
 *
 * Real executor process (real GeminiExchange: signing, WebSocket session, order placement) talking to a local
 * Gemini stand-in that enforces Gemini's auth rules. Real chain-service process (real SolanaChain: sign, send, poll,
 * parse) talking to a local Solana node that applies the real transaction rules. The seed script drives it through the
 * same /api and /chain paths the web app uses: place a win, a refund and a loss, settle, commit, reveal.
 * Then the checks that decide whether a first run with real keys is smooth: signatures on the wire, only the authority's
 * memos on chain, a leaderboard rebuilt from Solana, no secret in any response, and both services surviving a restart.
 *
 * `--sabotage` gives the executor a wrong secret, to prove this script fails when something is broken (it should).
 * It touches no network and spends nothing. It proves our code is self-consistent and survives the failures we know
 * about; it cannot prove Gemini or devnet agree. `npm run preflight` and the real sandbox run do that.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { FakeExchange } = await import(join(ROOT, 'executor/test/fake.ts'));
const { startFakeGemini } = await import(join(ROOT, 'executor/test/fake-gemini.ts'));
const { startFakeRpc } = await import(join(ROOT, 'chain/test/fake-rpc.ts'));
const { Keypair } = createRequire(join(ROOT, 'chain/package.json'))('@solana/web3.js');

const API_KEY = 'rehearsal-key';
const API_SECRET = 'rehearsal-secret-value-9f2c';
const tmp = mkdtempSync(join(tmpdir(), 'given-rehearse-'));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  ${detail}` : ''}`);
};
const freePort = () => new Promise((res) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

async function until(url, what, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error(`${what} did not come up at ${url}`);
}
function start(name, cwd, env) {
  const child = spawn(process.execPath, ['src/server.ts'], { cwd: join(ROOT, cwd), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = '';
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => (child.log += d));
  children.push(child);
  child.on('exit', () => children.splice(children.indexOf(child), 1));
  child.label = name;
  return child;
}
const stop = async (child) => { child.kill('SIGTERM'); await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r))); };

let failed = false;
let gem, rpc, proxy;
try {
  // ---------------------------------------------------------------- the world
  const SPOT = 63240;
  const cdf = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp((-z * z) / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
  const STRIKES = Array.from({ length: 8 }, (_, i) => 61500 + i * 500);
  const next = new Date(); next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
  const ticker = `BTC${next.toISOString().slice(2, 13).replace(/[-T]/g, '')}00`;
  const rungs = STRIKES.map((strike) => { const mid = 1 - cdf(Math.log(strike / SPOT) / 0.012); return { strike, bid: Math.max(0.01, Math.round((mid - 0.01) * 100) / 100), ask: Math.min(0.99, Math.round((mid + 0.01) * 100) / 100), bidSize: 400, askSize: 400 }; });
  const exchange = new FakeExchange(ticker, rungs, { title: 'BTC price today at 8pm EST', expiryDate: next.toISOString() });
  gem = await startFakeGemini({ apiKey: API_KEY, apiSecret: API_SECRET, events: () => Promise.all([exchange.getEvent(ticker)]), books: exchange.books });
  rpc = await startFakeRpc();
  const authority = Keypair.generate();
  const keypairPath = join(tmp, 'authority.json');
  writeFileSync(keypairPath, JSON.stringify(Array.from(authority.secretKey)), { mode: 0o600 });
  rpc.fund(authority.publicKey.toBase58(), 1_000_000_000);
  console.log(`Gemini stand-in ${gem.baseUrl}   Solana stand-in ${rpc.url}   ladder ${ticker}\n`);

  // ---------------------------------------------------------------- the real services
  const [execPort, chainPort, webPort] = [await freePort(), await freePort(), await freePort()];
  const execEnv = { GIVEN_PORT: String(execPort), GIVEN_DATA_DIR: join(tmp, 'exec'), GEMINI_BASE_URL: gem.baseUrl, GEMINI_WS_URL: gem.wsUrl, GEMINI_API_KEY: API_KEY, GEMINI_API_SECRET: process.argv.includes('--sabotage') ? 'not-the-secret' : API_SECRET, GIVEN_ALLOW_PRODUCTION: '1', GIVEN_TAKER_FEE_COEF: '0' };
  const chainEnv = { GIVEN_CHAIN: 'devnet', SOLANA_RPC_URL: rpc.url, GIVEN_CHAIN_KEYPAIR: keypairPath, GIVEN_CHAIN_DATA_DIR: join(tmp, 'chain'), GIVEN_CHAIN_PORT: String(chainPort), GIVEN_EXECUTOR_URL: `http://127.0.0.1:${execPort}`, GIVEN_SELF_INGEST: '1', GIVEN_BACKFILL_MS: '0' };
  let exec = start('executor', 'executor', execEnv);
  await until(`http://127.0.0.1:${execPort}/health`, 'executor');
  let chain = start('chain', 'chain', chainEnv);
  await until(`http://127.0.0.1:${chainPort}/health`, 'chain service');

  // ---------------------------------------------------------------- the web app's view: /api and /chain on one origin
  const bodies = [];
  proxy = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/dev/resolve') {
      const spot = Number(url.searchParams.get('spot'));
      for (const strike of STRIKES) exchange.resolve(strike, spot >= strike ? 'yes' : 'no');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    const [, which, ...rest] = url.pathname.split('/');
    const target = which === 'api' ? execPort : which === 'chain' ? chainPort : null;
    if (!target) { res.writeHead(404); return res.end(); }
    const chunks = []; for await (const c of req) chunks.push(c);
    const up = await fetch(`http://127.0.0.1:${target}/${rest.join('/')}${url.search}`, { method: req.method, headers: { 'content-type': 'application/json' }, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const text = await up.text();
    bodies.push(text);
    res.writeHead(up.status, { 'content-type': 'application/json' });
    res.end(text);
  }).listen(webPort, '127.0.0.1');
  await sleep(100);
  const web = `http://127.0.0.1:${webPort}`;
  const get = async (p) => (await fetch(web + p)).json();

  // ---------------------------------------------------------------- drive it with the seed script
  const out = await new Promise((done) => {
    const c = spawn(process.execPath, [join(ROOT, 'scripts/seed-history.mjs'), 'all'], { env: { ...process.env, GIVEN_WEB: web } });
    let text = ''; c.stdout.on('data', (d) => (text += d)); c.stderr.on('data', (d) => (text += d));
    c.on('close', (code) => done({ code, text }));
  });
  console.log(out.text.trim().split('\n').map((l) => `        ${l}`).join('\n'), '\n');
  check('seed script placed, settled, committed and revealed', out.code === 0, out.code === 0 ? '' : out.text.slice(-300));

  // ---------------------------------------------------------------- the checks
  const { bets } = await get('/api/bets');
  check('three bets, each with two filled legs', bets.length === 3 && bets.every((b) => b.legs?.length === 2 && b.legs.every((l) => l.quantityFilled > 0)), `${bets.length} bets`);
  check('Gemini received exactly six signed orders over the WebSocket', gem.orders.length === 6, `${gem.orders.length} orders`);
  check('every order id has all 18 digits and matches the ledger', bets.length === 3 && bets.flatMap((b) => b.legs).every((l) => gem.orders.some((o) => o.rawId === l.orderId)));
  check('every bet settled', bets.length === 3 && bets.every((b) => b.status === 'settled'), bets.map((b) => b.status).join(','));

  const { calls } = await get('/chain/calls');
  const revealed = calls.filter((c) => c.state === 'revealed');
  check('two calls revealed (win and loss); the refund is void and never scored', calls.length === 3 && revealed.length === 2 && calls.some((c) => c.state === 'void'), calls.map((c) => c.state).join(','));
  const txs = rpc.txs();
  check('five records on Solana (3 commits + 2 reveals), all signed by the authority', txs.length === 5 && txs.every((t) => t.signer === authority.publicKey.toBase58()), `${txs.length} txs`);
  check('the authority paid exactly five fees', rpc.balance(authority.publicKey.toBase58()) === 1_000_000_000 - 5 * 5000);

  const board = await get('/chain/leaderboard');
  check('the leaderboard has the player with two calls', board.rows.length === 1 && board.rows[0].calls === 2, `edge ${board.rows[0]?.edge}`);
  const verifies = await Promise.all(revealed.map((c) => get(`/chain/calls/${c.id}/verify`)));
  check('every revealed call re-reads from Solana and its hash recomputes', verifies.length === 2 && verifies.every((v) => v.matches === true));
  if (revealed.length === 0) throw new Error('nothing was revealed, so nothing can be verified');
  const pub = await get(`/chain/reveals/${revealed[0].reveal.signature}`);
  check('the public reveal never carries a salt or an account', !('salt' in pub) && !('user' in pub) && !JSON.stringify(pub).includes('primary'));

  const everything = JSON.stringify(bodies) + exec.log + chain.log;
  check('no API key, secret or keypair appears in any response or log', !everything.includes(API_SECRET) && !everything.includes(API_KEY) && !everything.includes(Array.from(authority.secretKey).join(',')));
  const keyed = gem.state.requests.filter((r) => !r.includes('/events'));
  check('the executor only used signed, documented endpoints', keyed.length > 0 && gem.state.wsAuthFailures === 0, `${keyed.length} private requests, ${gem.state.wsAuthFailures} auth failures`);

  // ---------------------------------------------------------------- restarts
  await stop(chain);
  chain = start('chain', 'chain', chainEnv);
  await until(`http://127.0.0.1:${chainPort}/health`, 'restarted chain service');
  const board2 = await get('/chain/leaderboard');
  const calls2 = (await get('/chain/calls')).calls;
  check('the chain service restarts with the same calls and leaderboard', JSON.stringify(board2.rows) === JSON.stringify(board.rows) && calls2.length === 3);
  await stop(exec);
  exec = start('executor', 'executor', execEnv);
  await until(`http://127.0.0.1:${execPort}/health`, 'restarted executor');
  const bets2 = (await get('/api/bets')).bets;
  check('the executor restarts with its ledger intact and does not place anything again', bets2.length === 3 && gem.orders.length === 6);
  const idempotent = await fetch(`${web}/chain/calls`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ betId: bets[0].id }) });
  check('committing the same bet twice returns the same call and writes nothing new', idempotent.ok && rpc.txs().length === 5);
} catch (err) {
  failed = true;
  console.error(`\nREHEARSAL ERROR: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  for (const c of [...children]) c.kill('SIGTERM');
  proxy?.close();
  await gem?.close();
  await rpc?.close();
  rmSync(tmp, { recursive: true, force: true });
}
const ok = !failed && checks.length > 0 && checks.every(Boolean);
console.log(ok ? `\nREHEARSAL PASSED (${checks.length} checks). With keys and SOL the same flow runs live: npm run preflight, then npm run dev:live.` : '\nREHEARSAL FAILED');
process.exit(ok ? 0 : 1);
