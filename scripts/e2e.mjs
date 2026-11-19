#!/usr/bin/env node
/**
 * End to end, in a real browser, against the PRODUCTION build served the way a host would serve it.
 *
 *   npm run e2e            builds the web app if needed, starts scripts/serve.mjs (fake mode, random ports), drives Chrome
 *   npm run e2e -- --show  the same with a visible browser window
 *
 * Needs Google Chrome installed (it uses the system browser through playwright-core, so nothing is downloaded).
 * What it proves that unit tests cannot: the built bundle works, pages update on their own over the real streams, a refused
 * market is explained and recovers by itself, and a person clicking under moving prices is never left with a silent button.
 * Exit code 0 only when every check passes.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const show = process.argv.includes('--show');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// GIVEN_WEB_DIST points the run at another build folder (the server reads it too), so a build under test need not replace web/dist.
if (!existsSync(join(process.env.GIVEN_WEB_DIST ?? join(ROOT, 'web/dist'), 'index.html'))) {
  console.log('Building the web app first (npm run build)...');
  const b = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (b.status !== 0) process.exit(1);
}

const freePort = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [PORT, EXEC, CHAIN] = [await freePort(), await freePort(), await freePort()];
const base = `http://127.0.0.1:${PORT}`;
const internal = `http://127.0.0.1:${EXEC}`;

// ---------------------------------------------------------------------------------------------------- the server
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', GIVEN_MODE: 'fake', GIVEN_INTERNAL_EXECUTOR_PORT: String(EXEC), GIVEN_INTERNAL_CHAIN_PORT: String(CHAIN), GIVEN_PUBLIC_URL: base, GIVEN_NO_PROJECT_ENV: '1', GIVEN_RATE_LIMIT_PER_MIN: '1000', GIVEN_DATA_ROOT: mkdtempSync(join(tmpdir(), 'given-e2e-')) };
for (const k of ['GEMINI_API_KEY', 'GEMINI_API_SECRET', 'GIVEN_PROGRAM_ID', 'GIVEN_EDGE_TRUST_PROXY']) delete env[k];
let server = null;
let serverLog = '';
/** Starts the server and waits until it says it is up. Can be called again after stopServer, to simulate a host restart. */
async function bootServer() {
  serverLog = '';
  server = spawn('node', ['scripts/serve.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  for (let i = 0; !/Given is up/.test(serverLog); i++) {
    if (server.exitCode !== null || i > 200) {
      console.error(`The server did not start:\n${serverLog}`);
      await stopServer();
      process.exit(1);
    }
    await sleep(200);
  }
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const gone = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await Promise.race([gone, sleep(4000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
}
await bootServer();

// ---------------------------------------------------------------------------------------------------- the checks
let failures = 0;
let total = 0;
async function check(name, fn) {
  total++;
  const t0 = Date.now();
  try {
    const note = await fn();
    console.log(`[  ok  ] ${name}${note ? ` (${note})` : ''}  ${Date.now() - t0}ms`);
  } catch (err) {
    failures++;
    console.log(`[ FAIL ] ${name}\n         ${err instanceof Error ? err.message.split('\n')[0] : err}`);
  }
}
const need = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const api = async (path, init) => (await fetch(base + path, { headers: { 'content-type': 'application/json', origin: base }, ...init })).json();
const dev = (path) => fetch(internal + path, { method: 'POST' }).then((r) => r.json());

const browser = await chromium.launch({ executablePath: CHROME, headless: !show });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.setDefaultTimeout(12_000);

const problems = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 140)}`);
});
const posts = [];
page.on('request', (r) => {
  if (r.method() === 'POST' && r.url().endsWith('/api/bets')) posts.push(Date.now());
});

// --sabotage proves the live-update checks can fail: it blocks both event streams, so pages can only poll.
if (process.argv.includes('--sabotage')) await ctx.route(/\/(api\/stream|chain\/events)/, (route) => route.abort());

const button = () => page.locator('.btn-primary.btn-wide');
const placeable = () => page.waitForFunction(() => /^Place bet/.test(document.querySelector('.btn-primary.btn-wide')?.textContent ?? ''));
const until = async (what, ok, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${what}`);
};

let handle = null;
let bet = null;

// ---- 1. the golden path
await check('the landing page opens and leads to the builder', async () => {
  await page.goto(base);
  need((await page.title()).includes('Given'), 'wrong title');
  await page.getByRole('link', { name: 'Build a bet' }).first().click();
  await page.waitForURL('**/app');
  await placeable();
  if (!process.argv.includes('--sabotage')) await page.waitForSelector('.live[data-state="live"]', { timeout: 8000 }); // both streams connected
});

await check('a bet is placed: two filled orders and a call recorded, shown on one receipt', async () => {
  const before = posts.length;
  await button().click();
  await page.waitForSelector('.receipt');
  const text = await page.locator('.receipt').innerText();
  need(/Order 1 filled/.test(text) && /Order 2 filled/.test(text), 'both orders not shown as filled');
  await page.waitForSelector('.receipt .steps li.is-done >> text=Call recorded on Solana');
  need(/If it holds .* but stops short/.test(text), 'the losing outcome is missing from the receipt');
  need(posts.length === before + 1, `expected one POST /api/bets, saw ${posts.length - before}`);
  bet = (await api('/api/bets')).bets[0];
  need(bet && bet.status === 'open', 'the bet is not open in the ledger');
});

await check('"How this bet pays" shows the placed bet, not the quote', async () => {
  const panel = await page.locator('.payoff').innerText();
  const ifBoth = `+$${bet.payoffs.ifBothHit.toFixed(2)}`;
  need(panel.includes(ifBoth), `expected ${ifBoth} in the panel, got: ${panel.replace(/\n/g, ' | ')}`);
});

await check('after placing: the chart is locked to the bet, and the receipt says what happens next', async () => {
  const locked = await page.locator('.chart-locked').count();
  need(locked === 1, 'the chart is still interactive after the bet was placed');
  const events = await page.evaluate(() => getComputedStyle(document.querySelector('.chart-locked')).pointerEvents);
  need(events === 'none', `the locked chart still takes pointer events (${events})`);
  need(!/Drag the two markers/.test(await page.locator('.chart-hint').innerText()), 'the chart still tells you to drag the markers');
  const next = await page.locator('.receipt .next-step').innerText();
  need(/My bets by itself/.test(next), `no next-step line on the receipt: ${next}`);
});

await check('My bets lists it', async () => {
  await page.getByRole('link', { name: 'See my bets' }).click();
  await page.waitForURL('**/app/bets');
  await page.waitForSelector('text=Orders and proof');
});

// ---- 2. it updates by itself
await check('a second bet is made and its call recorded (through the same public port)', async () => {
  const pair = { event: bet.eventTicker, condition: bet.condition.symbol, target: bet.target.symbol, stake: 10 };
  const second = await api('/api/bets', { method: 'POST', body: JSON.stringify(pair) });
  need(second.bet, JSON.stringify(second).slice(0, 120));
  const call = await api('/chain/calls', { method: 'POST', body: JSON.stringify({ betId: second.bet.id }) });
  need(call.state === 'committed', 'second call not committed');
  await page.waitForFunction(() => document.querySelectorAll('.bets-list > *, [data-bet]').length >= 2 || (document.body.innerText.match(/Orders and proof/g) ?? []).length >= 2);
});

await check('the result arrives on its own: bets flip to Won with no reload', async () => {
  const t0 = Date.now();
  await dev(`/dev/resolve?spot=${bet.target.strike + 100}`);
  // 6 seconds: the executor settles every 3 and tells the page at once. Polling alone would take 8 more, so this only passes
  // when the live stream is really delivering.
  await until('both bets to show Won', async () => (await page.locator('text=Won').count()) >= 2, 6_000);
  return `${Date.now() - t0}ms after the market resolved`;
});

await check('revealing a call from the page records it and scores an edge', async () => {
  await page.getByRole('button', { name: 'Reveal on Solana' }).first().click();
  await page.waitForSelector('text=Edge scored');
});

await check('the leaderboard shows the handle, and updates by itself when another call is revealed elsewhere', async () => {
  await page.getByRole('link', { name: 'Leaderboard' }).first().click();
  await page.waitForURL('**/leaderboard');
  await page.waitForSelector('table tbody tr');
  const calls = async () => Number((await page.locator('table tbody tr').first().locator('td').nth(2).innerText()).trim());
  need((await calls()) === 1, 'expected one call on the board');
  handle = (await page.locator('table tbody tr').first().locator('td').nth(1).innerText()).trim();
  const open = (await api('/chain/calls')).calls.find((c) => c.state === 'committed');
  await api(`/chain/calls/${open.id}/reveal`, { method: 'POST' });
  await until('the row to show 2 calls', async () => (await calls()) === 2, 6_000); // polling alone would take up to 10s
});

await check('a revealed call has a proof page with the verdict and the verify control', async () => {
  const revealed = (await api('/chain/calls')).calls.find((c) => c.state === 'revealed');
  await page.goto(`${base}/verify/${revealed.reveal?.signature ?? revealed.revealSignature}`);
  await page.waitForSelector('text=Proof of a call');
  need(/Called it/.test(await page.locator('.proofcard').innerText()), 'no verdict on the card');
  need(await page.getByRole('heading', { name: 'Check it on Solana' }).count(), 'no verify section');
});

await check('the call can be saved as a picture to post', async () => {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save image' }).click()]);
  const name = download.suggestedFilename();
  need(/^given-[a-z]+-[a-z]+-\d+-[1-9A-HJ-NP-Za-km-z]{8}\.png$/.test(name), `saved as ${name}`);
  const file = await download.path();
  const bytes = readFileSync(file);
  need(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'the file is not a PNG');
  need(bytes.readUInt32BE(16) === 2400 && bytes.readUInt32BE(20) === 1260, `the picture is ${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`);
  need(bytes.length > 30_000, `the picture is only ${bytes.length} bytes: probably blank`);
  await page.waitForSelector('text=Image saved');
  // GIVEN_E2E_KEEP=<folder> keeps the picture so a person can look at it.
  if (process.env.GIVEN_E2E_KEEP) copyFileSync(file, join(process.env.GIVEN_E2E_KEEP, name));
});

await check('Proof page reconciles to the cent', async () => {
  await page.goto(`${base}/proof`);
  await page.getByRole('button', { name: 'Check against Gemini' }).click();
  await page.waitForSelector('.recon .is-ok');
  need(/\$0\.00/.test(await page.locator('.recon .is-ok').innerText()), 'difference is not $0.00');
});

// ---- 3. a market that is not open is explained, and recovers by itself
await check('a market that is not open yet is refused with its reason, then opens with no reload', async () => {
  await dev('/dev/reset');
  for (const k of [61500, 62000, 62500, 63000, 63500, 64000, 64500, 65000]) await dev(`/dev/state?strike=${k}&state=post_only`);
  await page.goto(`${base}/app`);
  await page.waitForSelector('.btn-primary.btn-wide');
  await until('the button to explain a not-open market', async () => /not open/i.test(await button().innerText()), 10_000);
  need(await button().isDisabled(), 'the button should be off');
  need(/few minutes/.test(await page.locator('.quote-card .note').first().innerText()), 'no reason shown');
  for (const k of [61500, 62000, 62500, 63000, 63500, 64000, 64500, 65000]) await dev(`/dev/state?strike=${k}&state=open`);
  await until('the button to turn into Place bet by itself', async () => /^Place bet/.test(await button().innerText()), 8_000); // the page re-reads prices when the executor says they changed
});

// ---- 4. clicking under moving prices
await check('under moving prices and slow fills, a click is never silent', async () => {
  await dev('/dev/churn?on=1&slowMs=700&everyMs=500');
  await page.goto(`${base}/app`);
  await page.waitForSelector('.btn-primary.btn-wide');
  const silent = [];
  let live = 0;
  for (let i = 0; i < 12; i++) {
    const again = page.getByRole('button', { name: 'Make another' });
    if (await again.count()) await again.click();
    await page.waitForSelector('.btn-primary.btn-wide');
    await sleep([0, 80, 250, 600, 1100][i % 5]);
    if (!(await button().isEnabled())) continue; // off, with a reason: fine
    live++;
    const label = (await button().innerText()).trim();
    need(!/\$0\.00/.test(label), `a live button reads "${label}"`);
    const before = posts.length;
    const box = await button().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await sleep(120);
    await page.mouse.up();
    await page.waitForSelector('.receipt, .note-bad', { timeout: 8000 }).catch(() => {});
    const answered = (await page.locator('.receipt').count()) + (await page.locator('.note-bad').count());
    if (posts.length === before || answered === 0) silent.push(i);
  }
  await dev('/dev/churn?on=0');
  need(live >= 4, `only ${live} clicks were possible`);
  need(silent.length === 0, `silent clicks at attempts ${silent.join(', ')}`);
  return `${live} real clicks, none silent`;
});

// ---- 5. the host restarts while a page is open
await check('when the server restarts under an open page, the page recovers by itself', async () => {
  await page.goto(`${base}/app`);
  await placeable();
  if (!process.argv.includes('--sabotage')) await page.waitForSelector('.live[data-state="live"]', { timeout: 8000 });
  const mark = problems.length;
  await stopServer();
  await sleep(3000); // down for a few seconds: the page keeps what it had and shows that it is reconnecting
  const stale = await button().innerText();
  need(/^Place bet/.test(stale) || /Checking/.test(stale), `the page lost its state while the server was away ("${stale}")`);
  await bootServer();
  await until('the live badge to return without a reload', async () => (await page.locator('.live[data-state="live"]').count()) === 1, 30_000);
  await until('the builder to be usable again', async () => /^Place bet/.test(await button().innerText()), 10_000);
  // Failed requests while the server was away are expected and are not counted against the run. Anything else still is.
  const expected = (p) => /Failed to load resource.*net::ERR_/.test(p);
  problems.splice(mark, problems.length - mark, ...problems.slice(mark).filter((p) => !expected(p)));
});

// ---- 6. phones
await check('on a phone: no sideways scroll on any page, and the quote follows the chart', async () => {
  await dev('/dev/reset');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/', '/app', '/app/bets', '/leaderboard', '/proof']) {
    await page.goto(base + path);
    await sleep(700);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    need(over <= 1, `${path} scrolls sideways by ${over}px`);
  }
  await page.goto(`${base}/app`);
  await placeable();
  const tops = await page.evaluate(() => ['.chart-card', '.quote-card', '.payoff'].map((s) => document.querySelector(s).getBoundingClientRect().top));
  need(tops[0] < tops[1] && tops[1] < tops[2], `order on a phone is ${tops.map(Math.round)}`);
  const chart = await page.locator('.chart-card').boundingBox();
  const btn = await button().boundingBox();
  need(btn.y + btn.height - chart.y < 1100, 'the Place bet button is more than a screen and a bit below the chart');
});

// ---- 6b. a real exchange's listing
await check('with dozens of ladders listed and most unpriced: the builder opens on one you can bet on, and a phone still does not scroll sideways', async () => {
  // Gemini's sandbox on 2026-11-18 listed 34 ladders, four with prices. The tabs ran 6,000px wide on a phone and the page
  // could open on a ladder with nothing to quote. The local test exchange lists only a few, so thirty unpriced ladders
  // are added to its real answer on the way to the page.
  await page.route('**/api/markets', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const model = body.events[0];
    const dead = Array.from({ length: 30 }, (_, i) => ({
      ...model,
      ticker: `DEAD${i}`,
      title: `Commodity ${i} price on November ${18 + (i % 3)}?`,
      rungs: model.rungs.map((r, j) => ({ ...r, symbol: `DEAD${i}-${j}`, bid: null, ask: null })),
      pairs: [],
      offerableCount: 0,
      refusedCount: 0,
      refusedByReason: {},
    }));
    await route.fulfill({ response: res, json: { ...body, events: [...dead.slice(0, 15), ...body.events, ...dead.slice(15)] } });
  });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/app`);
    await placeable(); // it opened on a ladder with an offer, not on the first of the thirty-odd listed
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const tabs = () => page.locator('.seg [role="tab"]').allInnerTexts();
    need((await sideways()) <= 1, `/app scrolls sideways by ${await sideways()}px`);
    const shown = await tabs();
    need(shown.length >= 1 && shown.length < 10, `${shown.length} tabs shown`);
    need(!shown.some((t) => /Commodity|\?/.test(t)), `an unpriced ladder or a question mark is in the tabs: ${shown.join(' | ')}`);
    const more = page.locator('.more-markets');
    need(/^30 more markets have no prices right now/.test(await more.innerText()), `the note reads "${await more.innerText()}"`);
    const inView = () =>
      page.evaluate(() => {
        const strip = document.querySelector('.seg').getBoundingClientRect();
        const tab = document.querySelector('.seg [aria-selected="true"]').getBoundingClientRect();
        const card = document.querySelector('.chart-card').getBoundingClientRect();
        return strip.right <= card.right + 1 && tab.left >= strip.left - 1 && tab.right <= strip.right + 1;
      });
    need(await inView(), 'the chosen tab is not visible inside its strip, or the strip leaves the card');
    const chosen = await page.locator('.seg [aria-selected="true"]').innerText();
    await more.click();
    await until('all the ladders to be listed', async () => (await tabs()).length === shown.length + 30, 5000);
    need((await sideways()) <= 1, `with every ladder listed, /app scrolls sideways by ${await sideways()}px`);
    need((await page.locator('.seg [aria-selected="true"]').innerText()) === chosen, 'listing the unpriced ladders changed the chosen one');
    need(await inView(), 'with every ladder listed, the chosen tab is not visible inside its strip');
    await more.click();
    await until('the unpriced ladders to be put away again', async () => (await tabs()).length === shown.length, 5000);
  } finally {
    await page.unroute('**/api/markets');
  }
});

// ---- 7. nothing broke quietly
await check('no console errors or page errors during the whole run', async () => {
  const real = problems.filter((p) => !/Failed to load resource.*(422|409)/.test(p));
  need(real.length === 0, `${real.length}: ${real.slice(0, 3).join(' || ')}`);
});

await browser.close();
await stopServer();
console.log(failures === 0 ? `\nE2E PASSED (${total} checks) against the production build.` : `\nE2E FAILED: ${failures} of ${total} checks failed.\n--- server log tail ---\n${serverLog.split('\n').slice(-15).join('\n')}`);
process.exit(failures === 0 ? 0 : 1);
