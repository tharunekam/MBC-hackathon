/**
 * A local executor with NO Gemini keys: the real HTTP API over the in-memory test exchange.
 *   npm run start:fake
 * For frontend and integration work. Prices follow a BTC ladder around a fixed spot, so the web app looks the
 * way it would on a healthy market. It labels itself "Local test exchange" everywhere; nothing here is Gemini.
 *
 * Extra routes under /dev (this server only, never in the real executor):
 *   POST /dev/resolve?spot=63300   settle every contract of the ladder against that price, as Gemini would at expiry
 *   POST /dev/reset                new empty exchange and ledger
 *   POST /dev/churn?on=1&slowMs=2000&everyMs=800   wobbling prices, a rung that empties, a rung that goes post-only, slow fills
 */
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/api.ts';
import { Ledger } from '../src/ledger.ts';
import { createLiveHub } from '../src/live.ts';
import { FakeExchange } from './fake.ts';

const PORT = Number(process.env.GIVEN_PORT ?? 8741);
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
const ticker = `BTC${nextHour.toISOString().slice(2, 13).replace(/[-T]/g, '')}00`;
const label = new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone: 'America/New_York' }).format(nextHour).replace(' ', '').toLowerCase();
const STRIKES = Array.from({ length: 8 }, (_, i) => 61500 + i * 500);

function build() {
  const rungs = STRIKES.map((strike) => {
    const mid = 1 - cdf(Math.log(strike / SPOT) / SIGMA);
    // A flat 2 cent spread: tighter than Gemini production (median about 4 cents) so most pairs pass the value rule.
    return {
      strike,
      bid: Math.max(0.01, Math.round((mid - 0.01) * 100) / 100),
      ask: Math.min(0.99, Math.round((mid + 0.01) * 100) / 100),
      bidSize: 400,
      askSize: 400,
    };
  });
  return new FakeExchange(ticker, rungs, { title: `BTC price today at ${label} EST`, expiryDate: nextHour.toISOString() });
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
    pinnedUser: 'primary',
    maxStake: 100,
    newId: () => `f${(++n).toString(36)}${Math.random().toString(36).slice(2, 5)}`,
  });
let api = handler();


const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/dev/resolve') {
    const spot = Number(url.searchParams.get('spot') ?? SPOT);
    for (const strike of STRIKES) exchange.resolve(strike, spot >= strike ? 'yes' : 'no');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ resolvedAt: spot, yes: STRIKES.filter((k) => spot >= k) }));
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
  if (req.method === 'POST' && url.pathname === '/dev/reset') {
    api.close();
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
server.listen(PORT, '127.0.0.1', () => console.log(`Local test exchange + executor API on http://127.0.0.1:${PORT}  (no Gemini; ${ticker}, spot ${SPOT})`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
