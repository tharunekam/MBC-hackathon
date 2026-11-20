/**
 * A local executor with NO Gemini keys: the real HTTP API over the in-memory test exchange.
 *   npm run start:fake
 * For frontend and integration work. Prices follow a BTC ladder around a fixed spot, so the web app looks the
 * way it would on a healthy market. It labels itself "Local test exchange" everywhere; nothing here is Gemini.
 *
 * Extra routes under /dev (this server only, never in the real executor):
 *   POST /dev/resolve?spot=63300   settle every contract of the ladder against that price, as Gemini would at expiry
 *   GET  /dev/round                whether rounds are on (FAKE_ROUND_MINUTES), when this one closes, and how the last finished
 *   POST /dev/reset                new empty exchange and ledger
 *   POST /dev/state?strike=63500&state=post_only   put one rung in a market state (state=open restores it)
 *   POST /dev/churn?on=1&slowMs=2000&everyMs=800   wobbling prices, a rung that empties, a rung that goes post-only, slow fills
 */
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/api.ts';
import { numberSetting } from '../src/config.ts';
import { Ledger } from '../src/ledger.ts';
import { createLiveHub } from '../src/live.ts';
import { FakeExchange } from './fake.ts';

// The same settings, read the same way as the real executor: a value that is not a usable number stops this server too.
let PORT: number;
let MAX_STAKE: number;
let RATE_LIMIT: number | undefined;
try {
  PORT = numberSetting('GIVEN_PORT', process.env.GIVEN_PORT, { atLeast: 0, atMost: 65535, whole: true }) ?? 8741;
  MAX_STAKE = numberSetting('GIVEN_MAX_STAKE', process.env.GIVEN_MAX_STAKE, { above: 0 }) ?? 100;
  RATE_LIMIT = numberSetting('GIVEN_RATE_LIMIT_PER_MIN', process.env.GIVEN_RATE_LIMIT_PER_MIN, { above: 0 });
} catch (err) {
  console.error(`Refusing to start. ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const SPOT = Number(process.env.FAKE_SPOT ?? 63240);
const SIGMA = 0.012;

// Normal-distribution ladder: the chance of finishing at or above each strike.
function cdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

const nextHour = new Date();
nextHour.setMinutes(0, 0, 0);
nextHour.setHours(nextHour.getHours() + 1);
const stamp = nextHour.toISOString().slice(2, 13).replace(/[-T]/g, '');
const ticker = `BTC${stamp}00`;
const STRIKES = Array.from({ length: 8 }, (_, i) => 61500 + i * 500);

/**
 * Other assets listed beside Bitcoin, when FAKE_ASSETS names them (`npm run dev` does: FAKE_ASSETS=ETH,SOL). Each has its own ladder
 * and its own finishing price, and closes and reopens with Bitcoin's round. Left unset, Bitcoin is the only market, which is what
 * the tests and the browser checks expect.
 */
const OTHER = { ETH: { spot: 3180, step: 25, sigma: 0.014 }, SOL: { spot: 148, step: 1, sigma: 0.016 } } as const;
type Code = keyof typeof OTHER;
const EXTRA = (process.env.FAKE_ASSETS ?? '')
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter((c): c is Code => c in OTHER);
const extraSpot = new Map<Code, number>(EXTRA.map((c) => [c, OTHER[c].spot]));
const extraTicker = (c: Code) => `${c}${stamp}00`;
function extraRungs(c: Code, spot: number) {
  const { step, sigma } = OTHER[c];
  const base = Math.round(spot / step) * step;
  return Array.from({ length: 8 }, (_, i) => {
    const strike = base + (i - 4) * step;
    const mid = 1 - cdf(Math.log(strike / spot) / sigma);
    return { strike, bid: Math.max(0.01, Math.round((mid - 0.01) * 100) / 100), ask: Math.min(0.99, Math.round((mid + 0.01) * 100) / 100), bidSize: 400, askSize: 400 };
  });
}
const extraTitle = (c: Code, closes: Date) => titleFor(closes).replace('BTC', c);

/**
 * Rounds: with FAKE_ROUND_MINUTES set (as `npm run dev` does) the ladder closes by itself that many minutes after it
 * opens, settles against a price drawn from its own odds, and opens again for the next round. Without it a bet placed here
 * never settled unless someone knew to call /dev/resolve, so a person trying the app with no keys could not see a result, a
 * reveal or a leaderboard row. Left unset (the tests and the browser checks), the ladder closes at the top of the hour and
 * only /dev/resolve settles it, so a check is never interrupted by a round ending under it.
 */
const ROUND_MS = Math.max(0, Number(process.env.FAKE_ROUND_MINUTES ?? 0) || 0) * 60_000;
/** How long after a round resolves before the ladder opens again: long enough for auto-settle (3 s) to have run. */
const REOPEN_AFTER_MS = 8000;
const round = { spot: SPOT, closesAt: ROUND_MS > 0 ? new Date(Date.now() + ROUND_MS) : nextHour, resolvedAt: null as number | null, finish: null as number | null };

const titleFor = (closes: Date): string =>
  `BTC price today at ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', ...(closes.getMinutes() ? { minute: '2-digit' } : {}), timeZone: 'America/New_York' }).format(closes).replace(' ', '').toLowerCase()} EST`;

function rungsAt(spot: number) {
  return STRIKES.map((strike) => {
    const mid = 1 - cdf(Math.log(strike / spot) / SIGMA);
    // A flat 2 cent spread: tighter than Gemini production (median about 4 cents) so most pairs pass the value rule.
    return {
      strike,
      bid: Math.max(0.01, Math.round((mid - 0.01) * 100) / 100),
      ask: Math.min(0.99, Math.round((mid + 0.01) * 100) / 100),
      bidSize: 400,
      askSize: 400,
    };
  });
}

function build() {
  const ex = new FakeExchange(ticker, rungsAt(round.spot), { title: titleFor(round.closesAt), expiryDate: round.closesAt.toISOString() });
  for (const c of EXTRA) {
    extraSpot.set(c, OTHER[c].spot);
    ex.addEvent(extraTicker(c), extraRungs(c, OTHER[c].spot), { title: extraTitle(c, round.closesAt), expiryDate: round.closesAt.toISOString() });
  }
  // With the other assets on (npm run dev), each asset also lists the next three hours, so the time picker has real choices.
  // They are ordinary markets with their own ladders; only the first closes and settles with the demo round.
  if (EXTRA.length > 0) {
    for (let k = 0; k <= 3; k++) {
      const closes = new Date(nextHour.getTime() + k * 3_600_000);
      // The first hour is already the demo round's ticker, so its twin takes minute 01 (the same close, a different code).
      const code = (c: string) => `${c}${closes.toISOString().slice(2, 13).replace(/[-T]/g, '')}${k === 0 ? '01' : '00'}`;
      const meta = (c: string) => ({ title: titleFor(closes).replace('BTC', c), expiryDate: closes.toISOString() });
      ex.addEvent(code('BTC'), rungsAt(SPOT), meta('BTC'));
      for (const c of EXTRA) ex.addEvent(code(c), extraRungs(c, OTHER[c].spot), meta(c));
    }
  }
  return ex;
}

/** A finishing price drawn from the same bell curve the ladder's prices come from, so the odds on screen are honest ones. */
function drawFinish(): number {
  const z = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  return Math.round(round.spot * Math.exp(SIGMA * z) * 100) / 100;
}

const hub = createLiveHub();

/**
 * Optional misbehaviour, switched on over HTTP, that mimics what the real sandbox does and a still book never shows:
 * prices that wobble every second, a rung whose depth briefly drops to nothing, a rung that goes post-only for a few
 * seconds, and orders that take a couple of seconds to fill. The browser checks use it to prove the page holds up.
 */
const churn = { timer: null as NodeJS.Timeout | null, slowMs: 0, tick: 0 };
function decorate(ex: FakeExchange): FakeExchange {
  const place = ex.placeOrder.bind(ex);
  ex.placeOrder = async (req) => {
    if (churn.slowMs > 0) await new Promise((r) => setTimeout(r, churn.slowMs));
    return place(req);
  };
  return ex;
}
function churnOnce(): void {
  const k = ++churn.tick;
  const base = build(); // untouched copy of the quiet prices
  for (const strike of STRIKES) {
    const b = base.books.get(base.symbol(strike))!;
    const wobble = ((k + strike / 500) % 3) - 1; // -1, 0 or +1 cent, different per rung, moving each tick
    const bid = b.bid === null ? null : Math.min(0.97, Math.max(0.01, b.bid + wobble / 100));
    const ask = b.ask === null ? null : Math.min(0.99, Math.max(bid ?? 0.01, b.ask + wobble / 100));
    exchange.setBook(strike, { bid, ask });
  }
  // One rung is empty for one tick in four, and another is post-only for one tick in five.
  exchange.setBook(STRIKES[3]!, { bidSize: k % 4 === 0 ? 0 : 400, askSize: k % 4 === 0 ? 0 : 400 });
  exchange.setMarketState(STRIKES[5]!, k % 5 === 0 ? 'post_only' : 'open');
}

let exchange = decorate(build());
let ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-fake-')), 'ledger.json'));
let n = 0;

const handler = () =>
  createApi({
    ledger,
    users: ['primary'],
    exchangeFor: () => exchange,
    isConnected: () => true,
    markets: { listEvents: () => exchange.listEvents(), getEvent: (t) => exchange.getEvent(t) },
    isSandbox: true,
    venueName: 'Local test exchange',
    feeCoef: 0,
    waiveMarkup: false,
    marketsCacheMs: 1000,
    live: hub,
    refreshMs: 1500,
    autoSettleMs: 3000, // a resolved event settles its bets within seconds, so the page updates by itself
    quoteCacheMs: 1000,
    pinnedUser: process.env.GIVEN_PINNED_USER || 'primary',
    maxStake: MAX_STAKE,
    // The same settings the real executor reads, so a hosted staging run exercises the same protections.
    corsOrigins: (process.env.GIVEN_CORS_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
    trustProxy: process.env.GIVEN_TRUST_PROXY === '1',
    ...(RATE_LIMIT !== undefined ? { rateLimit: { max: RATE_LIMIT, windowMs: 60_000 } } : {}),
    newId: () => `f${(++n).toString(36)}${Math.random().toString(36).slice(2, 5)}`,
  });
let api = handler();

/** Settles every contract of the ladder against a price, as Gemini would at expiry. */
function resolveAt(price: number): void {
  for (const strike of STRIKES) exchange.resolve(strike, price >= strike ? 'yes' : 'no', price);
  for (const c of EXTRA) {
    const spot = extraSpot.get(c)!;
    const z = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
    const finish = Math.round(spot * Math.exp(OTHER[c].sigma * z) * 100) / 100;
    for (const rung of extraRungs(c, spot)) exchange.resolveExtra(extraTicker(c), rung.strike, finish >= rung.strike ? 'yes' : 'no', finish);
  }
  round.resolvedAt = Date.now();
  round.finish = price;
  hub.publish('markets');
}

/** Opens the ladder for the next round, around a price a little off the last so the rounds are not all alike. */
function reopen(): void {
  round.spot = Math.round((SPOT + (Math.random() - 0.5) * 500) / 10) * 10;
  round.closesAt = new Date(Date.now() + ROUND_MS);
  round.resolvedAt = null;
  round.finish = null;
  exchange.relist(rungsAt(round.spot), { title: titleFor(round.closesAt), expiryDate: round.closesAt.toISOString() });
  for (const c of EXTRA) {
    const spot = Math.round((OTHER[c].spot * (1 + (Math.random() - 0.5) * 0.03)) / OTHER[c].step) * OTHER[c].step;
    extraSpot.set(c, spot);
    exchange.relistExtra(extraTicker(c), extraRungs(c, spot), { title: extraTitle(c, round.closesAt), expiryDate: round.closesAt.toISOString() });
  }
  hub.publish('markets');
}

// The round clock. A round that has resolved (by the clock or by /dev/resolve) opens again once its bets have settled:
// reopening under a bet that is still open would hand it the next round's result.
const live = (status: string) => status === 'open' || status === 'unhedged' || status === 'placing';
const roundClock =
  ROUND_MS > 0
    ? setInterval(() => {
        if (round.resolvedAt === null) {
          if (Date.now() >= round.closesAt.getTime()) resolveAt(drawFinish());
        } else if (Date.now() - round.resolvedAt >= REOPEN_AFTER_MS && !ledger.data.bets.some((b) => live(b.status) || (b.status === 'cashed_out' && !b.called))) {
          reopen();
        }
      }, 1000)
    : null;
roundClock?.unref();

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/dev/resolve') {
    const spot = Number(url.searchParams.get('spot') ?? SPOT);
    resolveAt(spot);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ resolvedAt: spot, yes: STRIKES.filter((k) => spot >= k), reopens: ROUND_MS > 0 }));
  }
  if (req.method === 'GET' && url.pathname === '/dev/round') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ rounds: ROUND_MS > 0, minutes: ROUND_MS / 60_000, spot: round.spot, closesAt: round.closesAt.toISOString(), resolved: round.resolvedAt !== null, finish: round.finish }));
  }
  if (req.method === 'POST' && url.pathname === '/dev/churn') {
    // /dev/churn?on=1&slowMs=2000   (on=0 stops it)
    if (churn.timer) clearInterval(churn.timer);
    churn.timer = null;
    churn.slowMs = Number(url.searchParams.get('slowMs') ?? 0);
    if (url.searchParams.get('on') !== '0') churn.timer = setInterval(churnOnce, Number(url.searchParams.get('everyMs') ?? 800));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ churn: !!churn.timer, slowMs: churn.slowMs }));
  }
  if (req.method === 'POST' && url.pathname === '/dev/state') {
    // /dev/state?strike=63500&state=post_only   (state=open puts it back)
    exchange.setMarketState(Number(url.searchParams.get('strike')), url.searchParams.get('state') ?? 'open');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === 'POST' && url.pathname === '/dev/reset') {
    api.close();
    Object.assign(round, { spot: SPOT, closesAt: ROUND_MS > 0 ? new Date(Date.now() + ROUND_MS) : nextHour, resolvedAt: null, finish: null });
    exchange = decorate(build());
    ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-fake-')), 'ledger.json'));
    api = handler();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ reset: true }));
  }
  // Allow the local web dev server to call /dev routes and the API alike.
  api(req, res);
});
server.on('error', (err) => {
  console.error(`Could not start: ${err.message}`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () =>
  console.log(
    `Local test exchange + executor API on http://127.0.0.1:${PORT}  (no Gemini; ${ticker}, spot ${SPOT}` +
      (ROUND_MS > 0 ? `; a round closes and settles by itself every ${ROUND_MS / 60_000} min)` : '; settles only on POST /dev/resolve)'),
  ),
);
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
