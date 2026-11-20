#!/usr/bin/env node
/**
 * Checks a deployed demo from the outside, the way a judge's browser would reach it.
 *
 *   node scripts/check-deploy.mjs https://given.example.com           read-only checks (places nothing)
 *   node scripts/check-deploy.mjs https://given.example.com --bet     also places ONE small sandbox bet and records its call
 *
 * Exit code 0 only when every check passes. Run it after each deploy and again just before recording the video.
 */
const args = process.argv.slice(2);
const url = (args.find((a) => /^https?:\/\//.test(a)) ?? '').replace(/\/+$/, '');
const withBet = args.includes('--bet');
if (!url) {
  console.error('Usage: node scripts/check-deploy.mjs https://your-demo.example.com [--bet]');
  process.exit(2);
}

let failures = 0;
const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ ok: true });
    console.log(`[  ok  ] ${name}${note ? ` (${note})` : ''} ${Date.now() - t0}ms`);
  } catch (err) {
    failures++;
    results.push({ ok: false });
    console.log(`[ FAIL ] ${name}: ${err instanceof Error ? err.message : err}`);
  }
}
const need = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const get = (path, init) => fetch(url + path, { signal: AbortSignal.timeout(20_000), ...init });
const json = async (path, init) => {
  const r = await get(path, init);
  const body = await r.json().catch(() => null);
  return { status: r.status, body, headers: r.headers };
};

let health = null;
let markets = null;

await check('the page loads over a real connection', async () => {
  const r = await get('/');
  const html = await r.text();
  need(r.status === 200, `status ${r.status}`);
  need(/<div id="root">/.test(html), 'not the app shell');
  need(url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost') || url.startsWith('https://'), 'a public demo must be served over https');
  return r.headers.get('content-encoding') ? `compressed ${r.headers.get('content-encoding')}` : 'not compressed';
});
await check('a deep link works (the app shell, not a 404)', async () => {
  const r = await get('/bets');
  need(r.status === 200 && /<div id="root">/.test(await r.text()), `status ${r.status}`);
});
await check('the host health check answers', async () => {
  const { status, body } = await json('/healthz');
  need(status === 200 && body?.ok, `status ${status} ${JSON.stringify(body)}`);
  health = body;
  return `${body.mode}, ${body.venue}, chain ${body.network}`;
});
await check('it says what it is: not production Gemini', async () => {
  need(/sandbox|test/i.test(health?.venue ?? ''), `venue is "${health?.venue}"`);
});
await check('real ladders load', async () => {
  const { status, body } = await json('/api/markets');
  need(status === 200, `status ${status}`);
  markets = body;
  need(body.events.length > 0, 'no events');
  const offerable = body.events.reduce((n, e) => n + e.offerableCount, 0);
  return `${body.events.length} ladders, ${offerable} offerable pairs`;
});
await check('a quote comes back', async () => {
  const ev = markets.events.find((e) => e.pairs.some((p) => p.quote.offerable)) ?? markets.events[0];
  const p = ev.pairs.find((x) => x.quote.offerable) ?? ev.pairs[0];
  const { status, body } = await json(`/api/quote?event=${ev.ticker}&condition=${p.condition.symbol}&target=${p.target.symbol}&stake=5`);
  need(status === 200, `status ${status}`);
  need(body.quote && 'offerable' in body.quote, 'no quote in the answer');
});
await check('a repeat read is a 304 (caching works end to end)', async () => {
  const first = await get('/api/markets');
  const tag = first.headers.get('etag');
  await first.arrayBuffer();
  need(tag, 'no ETag');
  const again = await get('/api/markets', { headers: { 'If-None-Match': tag } });
  need(again.status === 304, `status ${again.status}`);
});
await check('live updates connect and say hello', async () => {
  const ctrl = new AbortController();
  const r = await fetch(`${url}/api/stream?topics=markets,bets`, { signal: ctrl.signal });
  need(r.status === 200 && /event-stream/.test(r.headers.get('content-type') ?? ''), `status ${r.status}`);
  const reader = r.body.getReader();
  const first = await Promise.race([reader.read(), new Promise((_, no) => setTimeout(() => no(new Error('no event in 8s: is something buffering the stream?')), 8000))]);
  ctrl.abort();
  need(/event: hello/.test(new TextDecoder().decode(first.value)), 'first event was not hello');
});
await check('the leaderboard and the chain service answer', async () => {
  const lb = await json('/chain/leaderboard');
  need(lb.status === 200, `leaderboard status ${lb.status}`);
  const ch = await json('/chain/health');
  need(ch.status === 200 && ch.body?.service === 'given-chain', 'chain health');
  return `${lb.body.rows?.length ?? 0} rows, ${ch.body.network}${ch.body.program ? `, program ${String(ch.body.program).slice(0, 6)}…` : ''}`;
});
await check('internal and admin routes are not reachable from outside', async () => {
  for (const [m, p] of [['POST', '/api/dev/reset'], ['POST', '/chain/admin/backfill'], ['GET', '/api/'], ['PUT', '/api/bets']]) {
    const r = await get(p, { method: m });
    need(r.status === 404, `${m} ${p} answered ${r.status}`);
  }
});
await check('a bet from another site is refused', async () => {
  const r = await get('/api/bets', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  need(r.status === 403, `status ${r.status}`);
});

if (withBet) {
  await check('one small bet, its two orders, and its Solana record', async () => {
    need(['live', 'fake'].includes(health?.mode), `bets need live (or staging fake) mode; this server is "${health?.mode}"`);
    const origin = new URL(url).origin;
    const post = (p, b) => get(p, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(b) });
    const ladders = [...markets.events].filter((e) => !e.ladderOutOfOrder).sort((a, b) => b.offerableCount - a.offerableCount);
    let placed = null;
    const tried = [];
    for (const ev of ladders.slice(0, 4)) {
      for (const pair of ev.pairs.filter((x) => x.quote.offerable).slice(0, 3)) {
        const r = await post('/api/bets', { event: ev.ticker, condition: pair.condition.symbol, target: pair.target.symbol, stake: 2 });
        const body = await r.json();
        if (r.status === 201) {
          placed = body.bet;
          break;
        }
        tried.push(`${ev.ticker}: ${body.code}`);
      }
      if (placed) break;
    }
    need(placed, `no pair accepted a bet (${tried.slice(0, 4).join('; ')}). New hourly ladders are often post-only for the first minutes.`);
    need(placed.legs.filter((l) => l.status === 'filled').length === 2, 'both orders did not fill');
    const callRes = await post('/chain/calls', { betId: placed.id });
    const call = await callRes.json();
    need(callRes.status < 300 && call.commitSignature, `no call recorded (${call.error ?? callRes.status})`);
    return `bet ${placed.id}, cost $${placed.cost}, commit ${call.commitSignature.slice(0, 10)}…`;
  });
}

console.log(failures === 0 ? `\nDEPLOY CHECK PASSED (${results.length} checks) for ${url}` : `\nDEPLOY CHECK FAILED: ${failures} of ${results.length} checks failed for ${url}`);
process.exit(failures === 0 ? 0 : 1);
