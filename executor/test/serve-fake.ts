/**
 * A local executor with NO Gemini keys: the real HTTP API over the in-memory test exchange.
 *   npm run start:fake
 * For frontend and integration work. Prices follow a BTC ladder around a fixed spot, so the web app looks the
 * way it would on a healthy market. It labels itself "Local test exchange" everywhere; nothing here is Gemini.
 *
 * Extra routes under /dev (this server only, never in the real executor):
 *   POST /dev/resolve?spot=63300   settle every contract of the ladder against that price, as Gemini would at expiry
 *   POST /dev/reset                new empty exchange and ledger
 */
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/api.ts';
import { Ledger } from '../src/ledger.ts';
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
    const half = 0.02 - 0.01 * 4 * mid * (1 - mid);
    return {
      strike,
      bid: Math.max(0.01, Math.round(Math.floor((mid - half) * 100)) / 100),
      ask: Math.min(0.99, Math.round(Math.ceil((mid + half) * 100)) / 100),
      bidSize: 400,
      askSize: 400,
    };
  });
  return new FakeExchange(ticker, rungs, { title: `BTC price today at ${label} EST`, expiryDate: nextHour.toISOString() });
}

let exchange = build();
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
  if (req.method === 'POST' && url.pathname === '/dev/reset') {
    exchange = build();
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
