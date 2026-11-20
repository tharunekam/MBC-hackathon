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
 * Last, the other products on a second ladder through the same paths: a falling parlay, a range and a three-bet basket are
 * placed, their calls committed, settled, revealed and verified from Solana, and the revealed bet ids say what each was.
 *
 * `--chaos` injects failures while the flow runs (a rate-limited Solana node, a dropped transaction whose blockhash expires,
 * a Gemini socket that dies right after accepting an order) and requires the same end state: six orders, five records, no
 * duplicates.
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
const chaos = process.argv.includes('--chaos');
const chaosLog = [];

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
let gem, rpc, proxy, execStream, chainStream;
try {
  // ---------------------------------------------------------------- the world
  const SPOT = 63240;
  const cdf = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp((-z * z) / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
  const STRIKES = Array.from({ length: 8 }, (_, i) => 61500 + i * 500);
  const next = new Date(); next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
  const ticker = `BTC${next.toISOString().slice(2, 13).replace(/[-T]/g, '')}00`;
  const rungs = STRIKES.map((strike) => { const mid = 1 - cdf(Math.log(strike / SPOT) / 0.012); return { strike, bid: Math.max(0.01, Math.round((mid - 0.01) * 100) / 100), ask: Math.min(0.99, Math.round((mid + 0.01) * 100) / 100), bidSize: 400, askSize: 400 }; });
  const exchange = new FakeExchange(ticker, rungs, { title: 'BTC price today at 8pm EST', expiryDate: next.toISOString() });
  const later = []; // ladders added after the first phase: [exchange, ticker]
  gem = await startFakeGemini({ apiKey: API_KEY, apiSecret: API_SECRET, events: () => Promise.all([exchange.getEvent(ticker), ...later.map(([x, t]) => x.getEvent(t))]), books: exchange.books });
  rpc = await startFakeRpc();
  const authority = Keypair.generate();
  const keypairPath = join(tmp, 'authority.json');
  writeFileSync(keypairPath, JSON.stringify(Array.from(authority.secretKey)), { mode: 0o600 });
  rpc.fund(authority.publicKey.toBase58(), 1_000_000_000);
  console.log(`Gemini stand-in ${gem.baseUrl}   Solana stand-in ${rpc.url}   ladder ${ticker}\n`);

  // ---------------------------------------------------------------- the real services
  const [execPort, chainPort, webPort] = [await freePort(), await freePort(), await freePort()];
  const execEnv = { GIVEN_PORT: String(execPort), GIVEN_DATA_DIR: join(tmp, 'exec'), GEMINI_BASE_URL: gem.baseUrl, GEMINI_WS_URL: gem.wsUrl, GEMINI_API_KEY: API_KEY, GEMINI_API_SECRET: process.argv.includes('--sabotage') ? 'not-the-secret' : API_SECRET, GIVEN_ALLOW_PRODUCTION: '1', GIVEN_TAKER_FEE_COEF: '0' };
  const chainEnv = { GIVEN_CHAIN: 'devnet', SOLANA_RPC_URL: rpc.url, GIVEN_CHAIN_KEYPAIR: keypairPath, GIVEN_CHAIN_DATA_DIR: join(tmp, 'chain'), GIVEN_CHAIN_PORT: String(chainPort), GIVEN_EXECUTOR_URL: `http://127.0.0.1:${execPort}`, GIVEN_SELF_INGEST: '1', GIVEN_BACKFILL_MS: '0', GIVEN_PROGRAM_ID: '' }; // blank: a real program id in the repo .env must not reach the Solana stand-in
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
    if (chaos && req.method === 'POST') {
      // Faults are injected just before the matching request is forwarded.
      if (url.pathname === '/chain/calls') {
        const n = (chaosLog.filter((x) => x.startsWith('commit')).length);
        if (n === 0) { rpc.rateLimitNext(1); chaosLog.push('commit#1: node answers 429 once'); }
        else if (n === 1) { rpc.dropNext(); setTimeout(() => rpc.expireBlockhashes(), 200); chaosLog.push('commit#2: transaction dropped, blockhash expires'); }
        else chaosLog.push(`commit#${n + 1}: clean`);
      }
      if (url.pathname === '/api/bets') {
        const n = chaosLog.filter((x) => x.startsWith('bet')).length;
        if (n === 2) { gem.state.dropAfterPlace = true; chaosLog.push('bet#3: Gemini socket dies right after accepting an order'); }
        else chaosLog.push(`bet#${n + 1}: clean`);
      }
    }
    const [, which, ...rest] = url.pathname.split('/');
    const target = which === 'api' ? execPort : which === 'chain' ? chainPort : null;
    if (!target) { res.writeHead(404); return res.end(); }
    if (req.method === 'GET' && /\/(stream|events)$/.test(url.pathname)) {
      // Server-sent events are piped through as they arrive; buffering would wait for a stream that never ends.
      const ctrl = new AbortController();
      res.on('close', () => ctrl.abort());
      try {
        const up = await fetch(`http://127.0.0.1:${target}/${rest.join('/')}${url.search}`, { signal: ctrl.signal });
        res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'text/event-stream', 'cache-control': 'no-cache' });
        for await (const chunk of up.body) res.write(chunk);
      } catch { /* the client went away */ }
      return res.end();
    }
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

  // ---------------------------------------------------------------- watch the live streams while the flow runs
  const watch = (url) => {
    const seen = { events: [], status: 0 };
    const ctrl = new AbortController();
    fetch(url, { signal: ctrl.signal }).then(async (res) => {
      seen.status = res.status;
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const name = /^event: (.+)$/m.exec(buf.slice(0, i))?.[1];
          buf = buf.slice(i + 2);
          if (name) seen.events.push(name);
        }
      }
    }).catch(() => {});
    return { seen, stop: () => ctrl.abort() };
  };
  execStream = watch(`${web}/api/stream?topics=markets,bets`);
  chainStream = watch(`${web}/chain/events?topics=calls,leaderboard`);
  await sleep(300);

  // ---------------------------------------------------------------- drive it with the seed script
  const out = await new Promise((done) => {
    const c = spawn(process.execPath, [join(ROOT, 'scripts/seed-history.mjs'), 'all'], { env: { ...process.env, GIVEN_WEB: web } });
    let text = ''; c.stdout.on('data', (d) => (text += d)); c.stderr.on('data', (d) => (text += d));
    c.on('close', (code) => done({ code, text }));
  });
  console.log(out.text.trim().split('\n').map((l) => `        ${l}`).join('\n'), '\n');
  check('seed script placed, settled, committed and revealed', out.code === 0, out.code === 0 ? '' : out.text.slice(-300));
  if (chaos) {
    console.log(chaosLog.filter((x) => !x.endsWith('clean')).map((x) => `        injected: ${x}`).join('\n'));
    check('the faults really happened', chaosLog.length >= 3 && (rpc.calls.get('sendTransaction') ?? 0) > 5, `${rpc.calls.get('sendTransaction') ?? 0} sendTransaction calls`);
  }

  // ---------------------------------------------------------------- the checks
  await sleep(500);
  const count = (seen, name) => seen.events.filter((e) => e === name).length;
  check('both services streamed live updates while the flow ran', execStream.seen.status === 200 && chainStream.seen.status === 200 && execStream.seen.events.includes('hello') && chainStream.seen.events.includes('hello'));
  check('the executor announced every bet and the settlement', count(execStream.seen, 'bets') >= 4, `${count(execStream.seen, 'bets')} bets events`);
  check('the chain service announced every commit and reveal, and the leaderboard change', count(chainStream.seen, 'calls') >= 5 && count(chainStream.seen, 'leaderboard') >= 1, `${count(chainStream.seen, 'calls')} calls, ${count(chainStream.seen, 'leaderboard')} leaderboard events`);

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

  // ---------------------------------------------------------------- the other products, on a second ladder
  const post = async (path, body) => {
    const res = await fetch(web + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const ETH = Array.from({ length: 8 }, (_, i) => 1740 + i * 20);
  const ticker2 = ticker.replace('BTC', 'ETH');
  const rungs2 = ETH.map((strike) => { const mid = 1 - cdf(Math.log(strike / 1806) / 0.012); return { strike, bid: Math.max(0.01, Math.round((mid - 0.01) * 100) / 100), ask: Math.min(0.99, Math.round((mid + 0.01) * 100) / 100), bidSize: 400, askSize: 400 }; });
  const exchange2 = new FakeExchange(ticker2, rungs2, { title: 'ETH price today at 8pm EST', expiryDate: next.toISOString() });
  later.push([exchange2, ticker2]);
  for (const [symbol, book] of exchange2.books) exchange.books.set(symbol, book);
  const e2 = (await get(`/api/markets?event=${ticker2}`)).events[0];
  check('the second ladder lists pairs for a rising and a falling parlay', e2.offerableCount > 0 && e2.down.offerableCount > 0, `${e2.offerableCount} rising, ${e2.down.offerableCount} falling`);

  const rising = e2.pairs.find((x) => x.quote.offerable);
  const falling = e2.down.pairs.find((x) => x.quote.offerable);
  check('a falling pair has its condition on the higher strike', falling.condition.strike > falling.target.strike);
  let box = null;
  for (let i = 0; i < e2.rungs.length && !box; i++) for (let j = i + 1; j < e2.rungs.length && !box; j++) {
    const q = await get(`/api/quote?product=range&event=${ticker2}&low=${e2.rungs[i].symbol}&high=${e2.rungs[j].symbol}&stake=10`);
    if (q.quote.offerable && q.stake?.cost >= 1) box = { low: e2.rungs[i], high: e2.rungs[j], quote: q };
  }
  check('some range on the second ladder is on offer, quoted with what always comes back', !!box && box.quote.stake.backAlways > 0 && box.quote.stake.ifInRange > 0 && box.quote.stake.ifOutside < 0);

  const ordersBefore = gem.orders.length;
  const fall = await post('/api/bets', { user: 'primary', event: ticker2, condition: falling.condition.symbol, target: falling.target.symbol, direction: 'down', stake: 10 });
  check('a falling parlay is placed: a NO on the lower strike and a YES on the higher', fall.status === 201 && fall.json.bet.status === 'open' && /^dn-/.test(fall.json.bet.id) && fall.json.bet.legs[0].outcome === 'no' && fall.json.bet.legs[0].symbol === falling.target.symbol && fall.json.bet.legs[1].outcome === 'yes' && fall.json.bet.legs[1].symbol === falling.condition.symbol, fall.json.error ?? '');
  const ranged = await post('/api/bets', { product: 'range', user: 'primary', event: ticker2, low: box.low.symbol, high: box.high.symbol, stake: 14 });
  check('a range is placed: a YES on the lower strike and a NO on the higher, the same size', ranged.status === 201 && ranged.json.bet.status === 'open' && /^rg-/.test(ranged.json.bet.id) && ranged.json.bet.legs[0].outcome === 'yes' && ranged.json.bet.legs[1].outcome === 'no' && ranged.json.bet.legs[0].quantityFilled === ranged.json.bet.legs[1].quantityFilled, ranged.json.error ?? '');
  const basket = await post('/api/baskets', {
    user: 'primary',
    name: 'Rehearsal basket',
    legs: [
      { event: ticker2, condition: rising.condition.symbol, target: rising.target.symbol, stake: 10 },
      { event: ticker2, condition: falling.condition.symbol, target: falling.target.symbol, direction: 'down', stake: 10 },
      { product: 'range', event: ticker2, low: box.low.symbol, high: box.high.symbol, stake: 14 },
    ],
  });
  check('a three-leg basket is placed in one request, every leg open and tagged with the basket', basket.status === 201 && basket.json.basket.failed === null && basket.json.bets.length === 3 && basket.json.bets.every((b) => b.status === 'open' && b.basket?.id === basket.json.basket.id), basket.json.error ?? '');
  check('Gemini received two signed orders for each of the five new bets', gem.orders.length - ordersBefore === 10, `${gem.orders.length - ordersBefore} orders`);
  const refusedBasket = await post('/api/baskets', { user: 'primary', legs: [{ event: ticker2, condition: rising.target.symbol, target: rising.condition.symbol, stake: 10 }, { event: ticker2, condition: rising.condition.symbol, target: rising.target.symbol, stake: 10 }] });
  check('a basket with a leg that is not a real pair is refused before anything is bought, naming the leg', refusedBasket.status === 422 && refusedBasket.json.leg === 0 && gem.orders.length - ordersBefore === 10, refusedBasket.json.error ?? '');

  const placed = [fall.json.bet, ranged.json.bet, ...basket.json.bets];
  const committed = [];
  for (const b of placed) committed.push((await post('/chain/calls', { betId: b.id })).json);
  check('every new bet has its call committed on Solana', committed.every((c) => c.state === 'committed' && c.commitSignature), committed.map((c) => c.state).join(','));

  const insideSpot = (box.low.strike + box.high.strike) / 2;
  for (const strike of ETH) exchange2.resolve(strike, insideSpot >= strike ? 'yes' : 'no');
  const settled = (await post('/api/settle', {})).json;
  const mine = (await get('/api/bets')).bets.filter((b) => placed.some((x) => x.id === b.id));
  check('all five settle, and the range that the price landed inside is a win', mine.length === 5 && mine.every((b) => b.status === 'settled') && mine.filter((b) => b.product === 'range').every((b) => b.settlement.targetResolved === 'yes'), `${settled.settled.length} settled`);

  const reveals = [];
  for (const c of committed) {
    const r = await post(`/chain/calls/${c.id}/reveal`, {});
    if (r.status === 200) reveals.push(r.json);
    else check(`a refused reveal is the void one (${r.json.code})`, r.json.code === 'void_call');
  }
  check('the calls that count are revealed on Solana', reveals.length >= 2 && reveals.every((r) => r.state === 'revealed' && r.reveal.signature), `${reveals.length} of ${committed.length}`);
  const publics = await Promise.all(reveals.map((r) => get(`/chain/reveals/${r.reveal.signature}`)));
  const kindOf = (id) => (id.startsWith('rg-') ? 'range' : id.startsWith('dn-') ? 'falling' : 'rising');
  check('every public reveal carries the committed bet id, so the proof page can say what kind of bet it was', publics.every((x) => typeof x.betId === 'string' && placed.some((b) => b.id === x.betId)), publics.map((x) => kindOf(x.betId)).join(','));
  const verifies2 = await Promise.all(reveals.map((r) => get(`/chain/calls/${r.id}/verify`)));
  check('each new revealed call re-reads from Solana and its hash recomputes', verifies2.every((v) => v.matches === true));
  const recon = await get('/api/reconcile');
  check('the executor ledger still names every order Gemini holds', recon.ordersChecked === recon.ordersMatched && recon.mismatches.length === 0, `${recon.ordersMatched} of ${recon.ordersChecked}`);
} catch (err) {
  failed = true;
  console.error(`\nREHEARSAL ERROR: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  for (const c of [...children]) c.kill('SIGTERM');
  execStream?.stop();
  chainStream?.stop();
  proxy?.close();
  await gem?.close();
  await rpc?.close();
  rmSync(tmp, { recursive: true, force: true });
}
const ok = !failed && checks.length > 0 && checks.every(Boolean);
console.log(ok ? `\nREHEARSAL PASSED (${checks.length} checks). With keys and SOL the same flow runs live: npm run preflight, then npm run dev:live.` : '\nREHEARSAL FAILED');
process.exit(ok ? 0 : 1);
