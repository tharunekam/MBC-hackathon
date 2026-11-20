/**
 * Three safeguards that each failed quietly:
 *  - the operator's pause did not stop bets that were already waiting their turn;
 *  - one event that cannot be read stopped every other bet from settling, and threw away what had settled;
 *  - a setting such as GIVEN_MAX_STAKE="$25" became NaN, and a cap that is NaN is no cap at all.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createApi } from '../src/api.ts';
import { placeConditionalBet, settleBets } from '../src/bets.ts';
import { loadConfig, numberSetting } from '../src/config.ts';
import type { Exchange } from '../src/exchange.ts';
import { Ledger } from '../src/ledger.ts';
import { TIGHT, start } from './api-harness.ts';
import { FakeExchange } from './fake.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const here = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ the pause

/** Holds the first order of the first bet until `release()`, so more requests can queue behind it. */
function hold(exchange: FakeExchange) {
  let release!: () => void;
  let held!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  /** Resolves once the first order is actually being held. */
  const entered = new Promise<void>((resolve) => (held = resolve));
  const real = exchange.placeOrder.bind(exchange);
  let first = true;
  exchange.placeOrder = async (req) => {
    if (first) {
      first = false;
      held();
      await gate;
    }
    return real(req);
  };
  return Object.assign(release, { entered });
}

/** Polls until `ready()` is true: a barrier that waits for the state it needs instead of for a time to pass. */
async function until(ready: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 10_000;
  while (!ready()) {
    if (Date.now() > end) assert.fail(`gave up waiting for ${what}`);
    await sleep(2);
  }
}

test('a pause stops the bets already waiting in the queue: the one in flight finishes, the rest are refused', async () => {
  let paused = false;
  const app = await start(TIGHT, { isPaused: () => paused });
  try {
    const release = hold(app.exchange);
    const calls = [1, 2, 3, 4].map(() => app.call('POST', '/bets', app.betBody()));
    // all four have been accepted (each has done its own market read, and so is in the queue or placing): one is placing, three wait
    await release.entered;
    await until(() => app.marketReads() >= 4, 'all four requests to reach the queue');
    paused = true;
    release();
    const answers = await Promise.all(calls);
    assert.deepEqual(answers.map((a) => a.status).sort(), [201, 503, 503, 503]);
    for (const a of answers.filter((x) => x.status === 503)) assert.equal(a.json.code, 'paused');
    assert.equal(app.ledger.data.bets.length, 1, 'only the bet that was already placing exists');
    assert.equal(app.exchange.sent.length, 2, 'two orders, one bet');
  } finally {
    await app.close();
  }
});

for (const product of ['range', 'breakout'] as const) {
  test(`a pause stops the ${product} bets already waiting in the queue: the one in flight finishes, the rest are refused`, async () => {
    let paused = false;
    const app = await start(
      [
        { strike: 1800, bid: 0.8, ask: 0.82 },
        { strike: 1820, bid: 0.6, ask: 0.62 },
        { strike: 1840, bid: 0.4, ask: 0.42 },
      ],
      { isPaused: () => paused, waiveMarkup: true },
    );
    try {
      const release = hold(app.exchange);
      const body = { product, user: 'primary', event: 'ETHTEST', low: app.exchange.symbol(1800), high: app.exchange.symbol(1840), stake: 10, slippageTicks: 0 };
      const calls = [1, 2, 3, 4].map(() => app.call('POST', '/bets', body));
      await release.entered;
      await until(() => app.marketReads() >= 4, 'all four requests to reach the queue');
      paused = true;
      release();
      const answers = await Promise.all(calls);
      assert.deepEqual(answers.map((a) => a.status).sort(), [201, 503, 503, 503]);
      for (const a of answers.filter((x) => x.status === 503)) assert.equal(a.json.code, 'paused');
      assert.equal(app.ledger.data.bets.length, 1, 'only the bet that was already placing exists');
      assert.equal(app.exchange.sent.length, 2, 'two orders, one bet');
    } finally {
      await app.close();
    }
  });
}

test('a pause also stops a basket and a cash-out that are waiting', async () => {
  let paused = false;
  const app = await start(
    [
      { strike: 1800, bid: 0.8, ask: 0.82 },
      { strike: 1820, bid: 0.6, ask: 0.62 },
      { strike: 1840, bid: 0.4, ask: 0.42 },
    ],
    { isPaused: () => paused },
  );
  try {
    const placed = await app.call('POST', '/bets', app.betBody({ target: app.exchange.symbol(1840) }));
    assert.equal(placed.status, 201);
    const sent = app.exchange.sent.length;

    const release = hold(app.exchange);
    const slow = app.call('POST', '/bets', app.betBody());
    await sleep(50);
    const basket = app.call('POST', '/baskets', {
      user: 'primary',
      legs: [
        { event: 'ETHTEST', condition: app.exchange.symbol(1800), target: app.exchange.symbol(1840), stake: 5 },
        { event: 'ETHTEST', condition: app.exchange.symbol(1800), target: app.exchange.symbol(1840), stake: 5 },
      ],
    });
    const out = app.call('POST', '/cashout', { bet: placed.json.bet.id });
    await sleep(50);
    paused = true;
    release();
    const [first, b, c] = await Promise.all([slow, basket, out]);
    assert.equal(first.status, 201);
    assert.equal(b.status, 503);
    assert.equal(b.json.code, 'paused');
    assert.equal(c.status, 503);
    assert.equal(c.json.code, 'paused');
    assert.equal(app.ledger.data.bets.length, 2, 'the basket placed nothing');
    assert.equal(app.ledger.data.bets.find((x) => x.id === placed.json.bet.id)!.status, 'open', 'and the bet was not sold');
    assert.equal(app.exchange.sent.length, sent + 2, 'only the bet that was already placing sent orders');
  } finally {
    await app.close();
  }
});

test('a repeat of a request that already placed its bet is still answered during a pause: it places nothing, and it is how the app learns the bet exists', async () => {
  let paused = false;
  const app = await start(TIGHT, { isPaused: () => paused });
  try {
    const release = hold(app.exchange);
    const body = app.betBody({ requestId: 'pause-req-0001' });
    const first = app.call('POST', '/bets', body);
    await sleep(50);
    const repeat = app.call('POST', '/bets', body);
    await sleep(50);
    paused = true;
    release();
    const [a, b] = await Promise.all([first, repeat]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.json.repeated, true);
    assert.equal(b.json.bet.id, a.json.bet.id);
    // A request that has not placed anything is refused while paused, as before.
    assert.equal((await app.call('POST', '/bets', app.betBody({ requestId: 'pause-req-0002' }))).status, 503);
  } finally {
    await app.close();
  }
});

// ------------------------------------------------------------------ one unreadable event

const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = log;
  }
};

/** Two events on one ledger, so the order of the bets is the order the settle pass meets them. */
async function twoEvents() {
  const strikes = [
    { strike: 1800, bid: 0.8, ask: 0.82 },
    { strike: 1820, bid: 0.4, ask: 0.41 },
  ];
  const a = new FakeExchange('EVA', strikes);
  const b = new FakeExchange('EVB', strikes);
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-settle-')), 'ledger.json'));
  let n = 0;
  const base = { ledger, newId: () => `s${++n}`, now: () => new Date('2026-11-17T23:10:00Z'), waiveMarkup: false };
  const bet = (ex: FakeExchange, ticker: string) =>
    placeConditionalBet({ ...base, exchange: ex }, { user: 'primary', eventTicker: ticker, conditionSymbol: ex.symbol(1800), targetSymbol: ex.symbol(1820), stake: 10, slippageTicks: 0 });
  const first = await bet(a, 'EVA');
  const second = await bet(b, 'EVB');
  const third = await bet(b, 'EVB');
  return { a, b, ledger, base, first, second, third };
}

test('one event that cannot be read does not stop the others settling, and what settled is saved', async () => {
  const { b, ledger, base, first, second, third } = await twoEvents();
  b.resolve(1800, 'no');
  b.resolve(1820, 'no');
  const reads: string[] = [];
  const exchange = {
    getEvent: async (ticker: string) => {
      reads.push(ticker);
      if (ticker === 'EVA') throw new Error('Gemini https://api/events/EVA -> HTTP 404 {"reason":"EventNotFound"}'); // retired, or an outage
      return b.getEvent(ticker);
    },
  } as unknown as Exchange;

  const done = await quietly(() => settleBets({ ...base, exchange }));
  assert.deepEqual(done.unreadable, ['EVA']);
  assert.deepEqual(done.settled.map((x) => x.id).sort(), [second.id, third.id].sort());
  assert.equal(first.status, 'open', 'the unreadable event\'s bet is left exactly as it was, to be tried again');
  assert.deepEqual(reads, ['EVA', 'EVB'], 'each event is read once');

  const onDisk = new Ledger(ledger.path);
  assert.equal(onDisk.bet(second.id)!.status, 'settled', 'saved, not only in memory');
  assert.equal(onDisk.bet(third.id)!.status, 'settled');
  assert.equal(onDisk.bet(first.id)!.status, 'open');
});

test('an event that cannot be read at all fails only itself, and it is read again next time', async () => {
  const { a, ledger, base, first } = await twoEvents();
  a.resolve(1800, 'no');
  a.resolve(1820, 'no');
  let down = true;
  const exchange = { getEvent: async (t: string) => (down ? Promise.reject(new Error('fetch failed')) : a.getEvent(t)) } as unknown as Exchange;
  const early = await quietly(() => settleBets({ ...base, exchange }));
  assert.deepEqual(early.unreadable.sort(), ['EVA', 'EVB']);
  assert.equal(early.settled.length, 0);
  down = false;
  const later = await quietly(() => settleBets({ ...base, exchange })); // EVB is still not in this exchange: it is named again
  assert.deepEqual(later.unreadable, ['EVB']);
  assert.equal(later.settled.some((x) => x.id === first.id), true);
  assert.equal(new Ledger(ledger.path).bet(first.id)!.status, 'settled');
});

test('if the pass fails for some other reason, the bets it had already settled are still saved', async () => {
  const { a, b, ledger, base, first, second, third } = await twoEvents();
  b.resolve(1800, 'no');
  b.resolve(1820, 'no');
  // The bets are met in ledger order: first (EVA, not resolved), second, third (both EVB). The third is damaged, so the
  // pass blows up on it after the second has been settled in memory.
  (third as { legs: unknown }).legs = null;
  const exchange = { getEvent: (t: string) => (t === 'EVA' ? a : b).getEvent(t) } as unknown as Exchange;
  await assert.rejects(settleBets({ ...base, exchange }), TypeError);
  assert.equal(second.status, 'settled');
  const onDisk = JSON.parse(readFileSync(ledger.path, 'utf8')) as { bets: Array<{ id: string; status: string }> };
  assert.equal(onDisk.bets.find((x) => x.id === second.id)!.status, 'settled', 'saved even though the pass did not finish');
  assert.equal(onDisk.bets.find((x) => x.id === first.id)!.status, 'open');
});

test('POST /settle with an event that cannot be read answers 200 and names it, instead of 502 for every bet', async () => {
  const app = await start(TIGHT);
  try {
    assert.equal((await app.call('POST', '/bets', app.betBody())).status, 201);
    app.exchange.resolve(1800, 'no');
    app.exchange.resolve(1820, 'no');
    const real = app.exchange.getEvent.bind(app.exchange);
    app.exchange.getEvent = async () => {
      throw new Error('Gemini https://api/events/ETHTEST -> HTTP 500');
    };
    const down = await quietly(() => app.call('POST', '/settle'));
    assert.equal(down.status, 200);
    assert.deepEqual(down.json.unreadable, ['ETHTEST']);
    assert.deepEqual(down.json.settled, []);
    assert.equal(down.json.stillOpen, 1);

    app.exchange.getEvent = real;
    const up = await app.call('POST', '/settle');
    assert.equal(up.json.settled.length, 1);
    assert.deepEqual(up.json.unreadable, []);
  } finally {
    await app.close();
  }
});

// ------------------------------------------------------------------ settings that are not numbers

test('a numeric setting that is not a usable number stops loadConfig, and says which one', () => {
  const bad: Array<[string, string]> = [
    ['GIVEN_MAX_STAKE', '$25'],
    ['GIVEN_MAX_STAKE', '25 dollars'],
    ['GIVEN_MAX_STAKE', 'NaN'],
    ['GIVEN_MAX_STAKE', 'Infinity'],
    ['GIVEN_MAX_STAKE', '-5'],
    ['GIVEN_MAX_STAKE', '0'],
    ['GIVEN_MAX_STAKE', '0x19'],
    ['GIVEN_RATE_LIMIT_PER_MIN', '20/min'],
    ['GIVEN_RATE_LIMIT_PER_MIN', '0'],
    ['GIVEN_RATE_LIMIT_PER_MIN', 'many'],
    ['GIVEN_TAKER_FEE_COEF', '0,07'],
    ['GIVEN_TAKER_FEE_COEF', '7%'],
    ['GIVEN_TAKER_FEE_COEF', '-0.07'],
    ['GIVEN_TAKER_FEE_COEF', 'Infinity'],
    ['GIVEN_AUTO_SETTLE_MS', 'soon'],
    ['GIVEN_AUTO_SETTLE_MS', '-1'],
    ['GIVEN_PORT', '80a'],
    ['GIVEN_PORT', '99999'],
    ['GIVEN_PORT', '8787.5'],
  ];
  for (const [name, value] of bad) {
    assert.throws(() => loadConfig({ [name]: value }), (err: unknown) => err instanceof Error && err.message.startsWith(`${name} must be`) && err.message.includes(value.slice(0, 40)), `${name}=${value}`);
  }
});

test('the numeric settings that are fine still load, and an unset or empty one means the default', () => {
  const set = loadConfig({
    GIVEN_MAX_STAKE: '25',
    GIVEN_RATE_LIMIT_PER_MIN: ' 20 ',
    GIVEN_TAKER_FEE_COEF: '0.07',
    GIVEN_AUTO_SETTLE_MS: '0',
    GIVEN_PORT: '8788',
  });
  assert.equal(set.maxStake, 25);
  assert.equal(set.rateLimitPerMin, 20);
  assert.equal(set.takerFeeCoef, 0.07);
  assert.equal(set.autoSettleMs, 0);
  assert.equal(set.port, 8788);
  assert.equal(loadConfig({ GIVEN_TAKER_FEE_COEF: '0' }).takerFeeCoef, 0, 'a zero fee is allowed: the sandbox charges none');
  assert.equal(loadConfig({ GIVEN_MAX_STAKE: '12.5' }).maxStake, 12.5);
  assert.equal(loadConfig({ GIVEN_MAX_STAKE: '1e2' }).maxStake, 100);
  const bare = loadConfig({ GIVEN_MAX_STAKE: '', GIVEN_RATE_LIMIT_PER_MIN: '', GIVEN_TAKER_FEE_COEF: '', GIVEN_AUTO_SETTLE_MS: '', GIVEN_PORT: '' });
  assert.equal(bare.maxStake, null);
  assert.equal(bare.rateLimitPerMin, null);
  assert.equal(bare.takerFeeCoef, 0, 'sandbox default');
  assert.equal(bare.autoSettleMs, 20_000);
  assert.equal(bare.port, 8787);
  assert.equal(numberSetting('X', undefined), undefined);
});

test('the API refuses to be built with a cap, a limit or a fee that is not a usable number', () => {
  const ok = { ledger: new Ledger(join(mkdtempSync(join(tmpdir(), 'given-cfg-')), 'ledger.json')), users: ['primary'], exchangeFor: () => new FakeExchange('E', TIGHT), markets: { listEvents: async () => [], getEvent: async () => { throw new Error('x'); } }, isSandbox: true, feeCoef: 0, waiveMarkup: false };
  createApi(ok).close(); // the baseline builds
  createApi({ ...ok, maxStake: 25, rateLimit: { max: 20, windowMs: 60_000 } }).close();
  for (const maxStake of [Number('$25'), 0, -1, Infinity]) assert.throws(() => createApi({ ...ok, maxStake }), /maxStake/, String(maxStake));
  for (const max of [Number('20/min'), 0, -3]) assert.throws(() => createApi({ ...ok, rateLimit: { max, windowMs: 60_000 } }), /rateLimit/, String(max));
  assert.throws(() => createApi({ ...ok, rateLimit: { max: 5, windowMs: NaN } }), /rateLimit/);
  for (const feeCoef of [NaN, -0.07]) assert.throws(() => createApi({ ...ok, feeCoef }), /feeCoef/, String(feeCoef));
});

/** Runs a server entry point with one bad setting; it must exit 1 with a message and never listen. */
function startWith(script: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script], {
      cwd: resolve(here, '..'),
      env: { ...process.env, GIVEN_DATA_DIR: mkdtempSync(join(tmpdir(), 'given-boot-')), GIVEN_PORT: '0', GIVEN_NO_PROJECT_ENV: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000); // if it did start, it is not left running
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
}

test('the real server stops at startup, with a plain message, when a setting is not a number', async () => {
  for (const [name, value] of [['GIVEN_MAX_STAKE', '$25'], ['GIVEN_RATE_LIMIT_PER_MIN', '20/min'], ['GIVEN_TAKER_FEE_COEF', '0,07']] as const) {
    const { code, out } = await startWith('src/server.ts', { [name]: value });
    assert.equal(code, 1, `${name}: ${out}`);
    assert.match(out, new RegExp(`Refusing to start\\. ${name} must be`));
    assert.doesNotMatch(out, /Given executor API on/, 'it never listened');
    assert.doesNotMatch(out, /\bat .*\.ts:\d+/, 'a message, not a stack trace');
  }
});

test('the local test exchange server reads the same settings the same way', async () => {
  for (const [name, value] of [['GIVEN_MAX_STAKE', '$25'], ['GIVEN_RATE_LIMIT_PER_MIN', '20/min']] as const) {
    const { code, out } = await startWith('test/serve-fake.ts', { [name]: value });
    assert.equal(code, 1, `${name}: ${out}`);
    assert.match(out, new RegExp(`Refusing to start\\. ${name} must be`));
    assert.doesNotMatch(out, /Local test exchange \+ executor API on/);
  }
});
