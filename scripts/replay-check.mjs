#!/usr/bin/env node
/**
 * Replay, checked the way it will be used: in a real browser, start to finish.   npm run e2e:replay
 *
 *   1. RECORD. The hosted server runs on the local test exchange with GIVEN_RECORD set, and Chrome drives the real app
 *      through a whole bet: place it, watch it win, reveal the call, open the leaderboard, the proof check and the call's
 *      own proof page.
 *   2. REPLAY. That server is stopped. A second one starts in replay mode on the file, with no executor and no chain
 *      service, and a fresh browser repeats the same clicks. It must show the same bet, the same order ids, the same
 *      result, the same leaderboard row and a cash check that ties out, and it must say "Replay" throughout.
 *
 * Needs Google Chrome and a built web app (it builds one if missing). Exit code 0 only when every check passes.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { parseRecording } from './lib/replay.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(join(ROOT, 'web/dist/index.html'))) {
  console.log('Building the web app first (npm run build)...');
  if (spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' }).status !== 0) process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

async function serve(extra) {
  const [port, ex, ch] = [await freePort(), await freePort(), await freePort()];
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', GIVEN_INTERNAL_EXECUTOR_PORT: String(ex), GIVEN_INTERNAL_CHAIN_PORT: String(ch), GIVEN_PUBLIC_URL: `http://127.0.0.1:${port}`, GIVEN_DATA_ROOT: mkdtempSync(join(tmpdir(), 'given-replay-')), GIVEN_RATE_LIMIT_PER_MIN: '1000', ...extra };
  for (const k of ['GEMINI_API_KEY', 'GEMINI_API_SECRET', 'GIVEN_PROGRAM_ID', 'GIVEN_EDGE_TRUST_PROXY', 'GIVEN_SEEDER']) delete env[k];
  const proc = spawn('node', ['scripts/serve.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  for (let i = 0; !/Given is up/.test(log); i++) {
    if (proc.exitCode !== null || i > 200) {
      console.error(`The server did not start:\n${log}`);
      process.exit(1);
    }
    await sleep(200);
  }
  return {
    base: `http://127.0.0.1:${port}`,
    internal: `http://127.0.0.1:${ex}`,
    ports: [ex, ch],
    async stop() {
      if (proc.exitCode !== null) return;
      const gone = new Promise((r) => proc.once('exit', r));
      proc.kill('SIGTERM');
      await Promise.race([gone, sleep(4000)]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    },
  };
}

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
const until = async (what, ok, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for: ${what}`);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: !process.argv.includes('--show') });
const file = join(mkdtempSync(join(tmpdir(), 'given-tape-')), 'session.jsonl');
const seen = { orderIds: [], handle: '', betId: '', revealSignature: '' };

/** The same clicks, used to make the recording and then to follow it. `live` is the server being recorded, or null in replay. */
async function session(page, base, live) {
  const button = () => page.locator('.btn-primary.btn-wide');
  await page.goto(`${base}/parlay`);
  await page.waitForFunction(() => /^Place bet/.test(document.querySelector('.btn-primary.btn-wide')?.textContent ?? ''));
  await button().click();
  await page.waitForSelector('.receipt');
  await page.waitForSelector('.receipt .steps li.is-done >> text=Call recorded on Solana');
  const receipt = await page.locator('.receipt').innerText();
  need(/Order 1 filled/.test(receipt) && /Order 2 filled/.test(receipt), 'both orders are not shown as filled');

  await page.getByRole('link', { name: 'See my bets' }).click();
  await page.waitForURL('**/bets');
  await page.waitForSelector('text=Orders and proof');
  if (live) {
    // The market closes with both halves happening. On the day this is Gemini settling the ladder; here it is the test exchange.
    const bet = (await (await fetch(`${base}/api/bets`)).json()).bets[0];
    seen.betId = bet.id;
    seen.orderIds = bet.legs.map((l) => l.orderId);
    await fetch(`${live.internal}/dev/resolve?spot=${bet.target.strike + 100}`, { method: 'POST' });
  }
  await until('the bet to show Won without a reload', async () => (await page.locator('text=Won').count()) >= 1, 45_000);
  await page.getByRole('button', { name: 'Reveal on Solana' }).first().click();
  await page.waitForSelector('text=Edge scored');
  await page.locator('summary', { hasText: 'Orders and proof' }).first().click();
  const details = await page.locator('article').first().innerText();

  await page.getByRole('link', { name: 'Leaderboard' }).first().click();
  await page.waitForURL('**/leaderboard');
  await page.waitForSelector('table tbody tr');
  const handle = (await page.locator('table tbody tr').first().locator('td').nth(1).innerText()).trim();

  await page.goto(`${base}/proof`);
  await page.getByRole('button', { name: 'Check against Gemini' }).click();
  await page.waitForSelector('.recon .is-ok');
  const tied = await page.locator('.recon .is-ok').innerText();

  if (live) seen.revealSignature = (await (await fetch(`${base}/chain/calls`)).json()).calls.find((c) => c.state === 'revealed').reveal.signature;
  await page.goto(`${base}/verify/${seen.revealSignature}`);
  await page.waitForSelector('text=Proof of a call');
  const verdict = await page.locator('.proofcard').innerText();
  return { details, handle, tied, verdict };
}

// ---------------------------------------------------------------------------------------------------- 1. record
let recorded;
const live = await serve({ GIVEN_MODE: 'fake', GIVEN_RECORD: file });
await check('a whole bet is recorded while the app is used for real (local test exchange)', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  recorded = await session(page, live.base, live);
  seen.handle = recorded.handle;
  need(/Called it/.test(recorded.verdict), 'the recorded call was not a win');
  need(/\$0\.00/.test(recorded.tied), 'the recorded cash check did not tie out');
  await sleep(800); // let the snapshot that follows the last step land
});
await live.stop();
await check('the recording holds what the page was shown, and no key or salt', async () => {
  const text = readFileSync(file, 'utf8');
  const tape = parseRecording(text);
  const steps = tape.entries.filter((e) => e.method !== 'GET').map((e) => e.url.split('?')[0]);
  need(steps.length === 3, `expected bet, call and reveal; recorded ${steps.join(', ')}`);
  need(!/secret|apiKey|api_key|"salt"/i.test(text), 'something secret-looking is in the recording');
  return `${tape.entries.length} answers, ${(text.length / 1024).toFixed(0)} KB`;
});

// ---------------------------------------------------------------------------------------------------- 2. replay
const replay = await serve({ GIVEN_MODE: 'replay', GIVEN_REPLAY: file });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  // Live streams are not part of a recording, so their 404 is expected; anything else is a problem.
  if (m.type() === 'error' && !/Failed to load resource.*404/.test(m.text())) problems.push(`console: ${m.text().slice(0, 140)}`);
});

await check('nothing is running behind the replay', async () => {
  for (const port of replay.ports) {
    const up = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
    need(!up, `something answers on port ${port}`);
  }
});

await check('the app says it is a replay, in the nav and in the footer, and does not claim to be live', async () => {
  await page.goto(`${replay.base}/parlay`);
  await page.waitForFunction(() => /^Place bet/.test(document.querySelector('.btn-primary.btn-wide')?.textContent ?? ''));
  need((await page.locator('header .chip', { hasText: 'Replay' }).count()) >= 1, 'no "Replay" label in the nav');
  need(/A recording of a real session on Local test exchange \(not Gemini\)/.test(await page.locator('footer').innerText()), 'the footer does not say it is a recording');
  need((await page.locator('.live[data-state="live"]').count()) === 0, 'it shows the live badge');
});

await check('the same clicks give the same bet, order ids, result, leaderboard row and cash check as on the day', async () => {
  const again = await session(page, replay.base, null);
  for (const id of seen.orderIds) need(again.details.includes(id), `order id ${id} is not on the replayed bet`);
  need(again.handle === seen.handle, `leaderboard shows ${again.handle}, the recording had ${seen.handle}`);
  need(again.tied === recorded.tied, `cash check shows "${again.tied}", the recording had "${recorded.tied}"`);
  need(again.verdict === recorded.verdict, 'the call\'s proof page differs from the recording');
  need((await page.locator('header .chip', { hasText: 'Replay' }).count()) >= 1, 'the label went away');
});

await check('a step the recording does not have is refused', async () => {
  const res = await fetch(`${replay.base}/api/settle`, { method: 'POST' });
  const body = await res.json();
  need(res.status === 409 && body.code === 'replay_ended', `got ${res.status} ${body.code}`);
});

await check('no page errors during the replay', async () => {
  need(problems.length === 0, `${problems.length}: ${problems.slice(0, 3).join(' || ')}`);
});

await browser.close();
await replay.stop();
console.log(failures === 0 ? `\nREPLAY CHECK PASSED (${total} checks).` : `\nREPLAY CHECK FAILED: ${failures} of ${total}.`);
process.exit(failures === 0 ? 0 : 1);
