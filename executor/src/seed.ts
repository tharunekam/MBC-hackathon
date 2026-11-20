/**
 * The sandbox liquidity seeder's command (what it is and why: src/seeder.ts).
 *
 *   node src/seed.ts --dry-run [--event TICKER ...]     what it WOULD quote, from the sandbox's public prices.
 *                                                       Places nothing and needs no keys
 *   node src/seed.ts --user seeder [--event TICKER ...] quote until the ladders close or Ctrl-C (which cancels everything)
 *   node src/seed.ts --user seeder --cancel             cancel every seeder order on that account, then exit
 *
 * Options: --half-spread 0.02   --size 40   --max-dollars 400   --interval 5 (seconds)   --ladders 4
 * With no --event it picks the ladders that have prices and are open, soonest to close first, and moves on to the
 * next ones as each closes.
 *
 * The seeder account is a SECOND sandbox account: GEMINI_USER_SEEDER_KEY / GEMINI_USER_SEEDER_SECRET in .env (a
 * time-based-nonce key with trading and balance permissions, like the main one). It refuses to run as the account the
 * demo bets from, and anywhere but the sandbox. To stop it without the terminal, create executor/data/SEEDER_PAUSED:
 * it cancels everything and waits until the file is gone.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, requireUser } from './config.ts';
import { GeminiExchange } from './exchange.ts';
import { GeminiPublic } from './gemini/rest.ts';
import type { GeminiEvent } from './gemini/types.ts';
import { ladder } from './pairs.ts';
import { geminiVenue } from './seeder-venue.ts';
import { DEFAULTS, Seeder, assessBook, planQuotes, seededBook } from './seeder.ts';
import type { BookReport, SeederSettings } from './seeder.ts';

const args = process.argv.slice(2);
const has = (name: string): boolean => args.includes(`--${name}`);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const all = (name: string): string[] => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));
const num = (name: string, fallback: number): number => {
  const v = flag(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number.`);
  return n;
};
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const config = loadConfig();
// Not negotiable, whatever GIVEN_ALLOW_PRODUCTION says: resting our own quotes for our own bets to hit is a test aid.
if (!config.isSandbox) fail('The seeder only runs against Gemini\'s sandbox.');

const settings: Partial<SeederSettings> = {
  halfSpread: num('half-spread', DEFAULTS.halfSpread),
  size: num('size', DEFAULTS.size),
  maxDollars: num('max-dollars', DEFAULTS.maxDollars),
};
const intervalMs = num('interval', 5) * 1000;
const maxLadders = num('ladders', 4);
const STOP_BEFORE_SEC = 120;
const pub = new GeminiPublic(config.baseUrl);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const twoSided = (e: GeminiEvent): number => ladder(e).filter((r) => r.bid !== null && r.ask !== null).length;

/** The ladders worth quoting now: active, with prices on at least two open rungs, and not about to close. */
async function pick(): Promise<string[]> {
  const named = all('event');
  if (named.length > 0) return named;
  const soonEnough = (e: GeminiEvent) => !e.expiryDate || new Date(e.expiryDate).getTime() - Date.now() > (STOP_BEFORE_SEC + 60) * 1000;
  return (await pub.listEvents('active'))
    .filter((e) => soonEnough(e) && ladder(e).filter((r) => r.open && r.bid !== null && r.ask !== null).length >= 2)
    .sort((a, b) => new Date(a.expiryDate ?? 8.64e15).getTime() - new Date(b.expiryDate ?? 8.64e15).getTime() || a.ticker.localeCompare(b.ticker))
    .slice(0, maxLadders)
    .map((e) => e.ticker);
}

const cents = (x: number | null): string => (x === null ? '  –' : x.toFixed(2));
const summary = (r: BookReport): string =>
  `${r.ok} ok, ${r.warn} with a warning, ${r.refused} refused of ${r.pairs} pairs; median spread ${r.medianSpread === null ? 'n/a' : `${Math.round(r.medianSpread * 100)}¢`}; ${r.outOfOrder} out-of-order`;

// ------------------------------------------------------------------ dry run

if (has('dry-run')) {
  const tickers = await pick();
  if (tickers.length === 0) fail('No ladder has prices on two open rungs right now (new hourly ladders start post-only). Try again in a few minutes.');
  let offerableBefore = 0;
  let offerableAfter = 0;
  for (const ticker of tickers) {
    const event = await pub.getEvent(ticker);
    const rungs = ladder(event);
    const quotes = planQuotes(rungs, settings);
    const before = assessBook(rungs);
    const after = assessBook(seededBook(rungs, quotes));
    offerableBefore += before.ok + before.warn;
    offerableAfter += after.ok + after.warn;
    const tiedUp = quotes.reduce((sum, q) => sum + ((q.bid ?? 0) + (q.ask !== null ? 1 - q.ask : 0)) * q.size, 0);
    console.log(`\n${event.ticker}  ${event.title}  (closes ${event.expiryDate ?? 'unknown'})`);
    console.log('  strike        market bid/ask   fair    our bid/ask   size');
    quotes.forEach((q, i) => {
      const r = rungs[i]!;
      const ours = q.size > 0 ? `${cents(q.bid)} / ${cents(q.ask)}` : r.open ? '   (none)  ' : ' (not open) ';
      console.log(`  ${String(q.strike).padEnd(12)}  ${cents(r.bid)} / ${cents(r.ask)}     ${q.fair === null ? '  – ' : q.fair.toFixed(3)}   ${ours}   ${q.size || ''}`);
    });
    console.log(`  as it is:   ${summary(before)}`);
    console.log(`  with ours:  ${summary(after)}`);
    console.log(`  money tied up in resting quotes: $${tiedUp.toFixed(2)}`);
  }
  console.log(`\nNothing was placed. Pairs the offer rule would offer with no waiver: ${offerableBefore} now, ${offerableAfter} with these quotes resting.`);
  console.log('The offer rule counts Gemini\'s production fee on top of the spread, which is why a 4 cent book still refuses many pairs.');
  process.exit(0);
}

// ------------------------------------------------------------------ live

const user = flag('user') ?? 'seeder';
if (user === 'primary' || user === config.pinnedUser) fail(`"${user}" is the account the demo bets from. The seeder must be a different sandbox account (GEMINI_USER_SEEDER_KEY / _SECRET).`);
let exchange: GeminiExchange;
try {
  exchange = new GeminiExchange(config, requireUser(config, user));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const stamp = () => new Date().toISOString().slice(11, 19);
const seeder = new Seeder(geminiVenue(exchange), { settings, stopBeforeExpirySec: STOP_BEFORE_SEC, log: (line) => console.log(`${stamp()} ${line}`) });

if (has('cancel')) {
  const sent = await seeder.cancelAll();
  console.log(`Cancelled ${sent} seeder order(s) on "${user}".`);
  exchange.close();
  process.exit(0);
}

const pauseFile = resolve(dirname(fileURLToPath(import.meta.url)), '../data/SEEDER_PAUSED');
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`\n${stamp()} stopping: cancelling everything that is resting...`);
  const sent = await seeder.cancelAll().catch(() => -1);
  console.log(sent < 0 ? 'COULD NOT CANCEL. Run: node src/seed.ts --user ' + user + ' --cancel' : `cancelled ${sent} order(s).`);
  exchange.close();
  process.exit(sent < 0 ? 1 : 0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

console.log(`Seeder on Gemini's SANDBOX as "${user}": ${Math.round((settings.halfSpread ?? 0) * 200)}¢ books, ${settings.size} contracts a side, up to $${settings.maxDollars} a ladder.`);
console.log('These are our own test quotes. Say so wherever a demo that uses them is shown. Ctrl-C cancels everything.');
await seeder.cancelAll(); // anything an earlier run left behind

let tickers: string[] = [];
let picked = 0;
let paused = false;
while (!stopping) {
  try {
    if (existsSync(pauseFile)) {
      if (!paused) {
        console.log(`${stamp()} ${pauseFile} exists: cancelling and waiting`);
        await seeder.cancelAll();
        paused = true;
      }
    } else {
      paused = false;
      // Look for ladders at the start, when the list runs dry, and once a minute (the next hour's ladders appear).
      if (tickers.length === 0 || Date.now() - picked > 60_000) {
        const found = await pick();
        for (const t of found) if (!tickers.includes(t) && tickers.length < maxLadders) tickers.push(t);
        picked = Date.now();
        if (tickers.length === 0) console.log(`${stamp()} no ladder with prices on two open rungs yet`);
      }
      for (const ticker of [...tickers]) {
        if (stopping) break;
        if ((await seeder.cycle(ticker)) === 'stopped') {
          console.log(`${stamp()} ${ticker} is closed or about to close: its quotes are cancelled`);
          tickers = tickers.filter((t) => t !== ticker);
        }
      }
      const s = seeder.stats;
      console.log(`${stamp()} ${tickers.join(' ') || '(no ladders)'}: ${seeder.resting().length} quotes resting; placed ${s.placed}, cancelled ${s.cancelled}, filled ${s.filled.toFixed(0)} contracts, errors ${s.errors}`);
    }
  } catch (err) {
    console.error(`${stamp()} pass failed, trying again: ${err instanceof Error ? err.message : String(err)}`);
  }
  await sleep(intervalMs);
}
