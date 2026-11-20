/**
 * What a caller can read when something goes wrong on the server. An error that is not a refusal can carry a file path
 * (a ledger write that failed) or the exchange's own words, and the hosted edge hands the body on as it is. So a 500 is
 * always {"error":"internal","message":"Something went wrong on our side."}; the real error goes to the log. A bet that such
 * an error left "placing" is put right, so a repeat of its request is told the truth instead of "placing" for ever.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { UNKNOWN_NOTE } from '../src/bets.ts';
import { TIGHT, start } from './api-harness.ts';

const LADDER = [
  { strike: 1780, bid: 0.88, ask: 0.9 },
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.6, ask: 0.62 },
  { strike: 1840, bid: 0.4, ask: 0.42 },
];
const INTERNAL = { error: 'internal', message: 'Something went wrong on our side.' };
const DISK = "ENOSPC: no space left on device, open '/var/folders/zz/T/given-api-AbC123/ledger.json.tmp'";
const NO_LEAK = /ENOSPC|no space|\/var|folders|ledger\.json|\.tmp|\.ts:\d|at \/|node_modules/;

/** Everything written to the log while a test runs, so a test can say what went there and what did not reach the caller. */
function captureLog(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => void lines.push(args.map(String).join(' ')));
  return lines;
}

/** A ledger whose writes fail once `fail()` is called, as a full disk does. */
function failingDisk(ledger: { save(): void }) {
  const real = ledger.save.bind(ledger);
  const state = { failing: false };
  ledger.save = () => {
    if (state.failing) throw new Error(DISK);
    real();
  };
  return state;
}

test('a ledger write that fails after the first order filled: a plain 500, the bet is held (not "placing"), and a repeat is told so', async (t) => {
  const log = captureLog(t);
  const app = await start(TIGHT, { orderLookupWaitsMs: [0, 0, 0] });
  try {
    const disk = failingDisk(app.ledger);
    const real = app.exchange.placeOrder.bind(app.exchange);
    let orders = 0;
    app.exchange.placeOrder = async (req) => {
      const done = await real(req);
      if (++orders === 1) disk.failing = true; // the disk fills just after the outcome order filled
      return done;
    };
    const res = await app.call('POST', '/bets', app.betBody({ requestId: 'savefail_000001' }));

    assert.equal(res.status, 500);
    assert.deepEqual(res.json, INTERNAL);
    assert.doesNotMatch(JSON.stringify(res.json), NO_LEAK);
    assert.ok(log.some((line) => line.includes('ENOSPC')), 'the real error went to the log');

    const bet = app.ledger.data.bets[0]!;
    assert.equal(orders, 1);
    assert.equal(bet.legs[0]!.status, 'filled', 'the order did fill, and the ledger in memory knows');
    assert.equal(bet.status, 'unhedged', 'not "placing" for ever');
    assert.equal(bet.note, UNKNOWN_NOTE);

    disk.failing = false;
    const again = await app.call('POST', '/bets', app.betBody({ requestId: 'savefail_000001' }));
    assert.equal(again.status, 200);
    assert.equal(again.json.repeated, true);
    assert.equal(again.json.bet.status, 'unhedged');
    assert.equal(orders, 1, 'the repeat sends nothing');
  } finally {
    await app.close();
  }
});

test('the same without a request id: the bet it left behind is held, and the caller learns nothing of the disk', async (t) => {
  captureLog(t);
  const app = await start(TIGHT, { orderLookupWaitsMs: [0, 0, 0] });
  try {
    const disk = failingDisk(app.ledger);
    const real = app.exchange.placeOrder.bind(app.exchange);
    app.exchange.placeOrder = async (req) => {
      const done = await real(req);
      disk.failing = true;
      return done;
    };
    const res = await app.call('POST', '/bets', app.betBody());
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, INTERNAL);
    assert.equal(app.ledger.data.bets[0]!.status, 'unhedged');
  } finally {
    await app.close();
  }
});

test('a ledger write that fails before any order went out: a plain 500 and the bet is failed, not "placing"', async (t) => {
  captureLog(t);
  const app = await start(TIGHT, { orderLookupWaitsMs: [0, 0, 0] });
  try {
    const real = app.ledger.save.bind(app.ledger);
    app.ledger.save = () => {
      if (app.ledger.data.bets.length > 0) throw new Error(DISK); // the cash snapshot is saved; the bet's own record is not
      real();
    };
    const res = await app.call('POST', '/bets', app.betBody({ requestId: 'savefail_000002' }));
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, INTERNAL);
    assert.equal(app.exchange.sent.length, 0, 'no order went out');
    assert.equal(app.ledger.data.bets.length, 1);
    assert.equal(app.ledger.data.bets[0]!.status, 'failed');
    assert.match(app.ledger.data.bets[0]!.note ?? '', /could not be recorded, so no order was sent/);
  } finally {
    await app.close();
  }
});

test('a range and a breakout that meet the same failure are held too', async (t) => {
  captureLog(t);
  for (const product of ['range', 'breakout'] as const) {
    const app = await start(LADDER, { waiveMarkup: true, orderLookupWaitsMs: [0, 0, 0] });
    try {
      const disk = failingDisk(app.ledger);
      const real = app.exchange.placeOrder.bind(app.exchange);
      app.exchange.placeOrder = async (req) => {
        const done = await real(req);
        disk.failing = true;
        return done;
      };
      const res = await app.call('POST', '/bets', { product, user: 'primary', event: 'ETHTEST', low: app.exchange.symbol(1800), high: app.exchange.symbol(1840), stake: 12.4, slippageTicks: 0 });
      assert.equal(res.status, 500, product);
      assert.deepEqual(res.json, INTERNAL);
      assert.equal(app.ledger.data.bets[0]!.status, 'unhedged', product);
    } finally {
      await app.close();
    }
  }
});

test('any other error is a plain 500 too: a bug\'s message and path never reach the caller', async (t) => {
  const log = captureLog(t);
  const app = await start(TIGHT);
  try {
    app.exchange.getEvent = async () => {
      throw new Error("Cannot read properties of undefined (reading 'contracts') at /srv/given/executor/src/pairs.ts:44:12");
    };
    for (const path of ['/markets?event=ETHTEST', '/quote?event=ETHTEST&condition=a&target=b']) {
      const res = await app.call('GET', path);
      assert.equal(res.status, 500, path);
      assert.deepEqual(res.json, INTERNAL, path);
    }
    assert.ok(log.some((line) => line.includes('/srv/given/executor/src/pairs.ts')), 'the log has it');
    assert.ok(log.some((line) => line.includes('GET /markets')), 'and which request it was');
    assert.ok(!log.some((line) => line.includes('event=ETHTEST')), 'but not the query string');
  } finally {
    await app.close();
  }
});

test('an exchange or network failure is a 502 with its own sentence; the raw text goes to the log', async (t) => {
  const log = captureLog(t);
  const app = await start(TIGHT);
  try {
    app.exchange.getEvent = async () => {
      throw new Error('Gemini REST GET /v1/prediction-markets/events/ETHTEST failed: fetch failed (connect ECONNREFUSED 10.1.2.3:443)');
    };
    const res = await app.call('GET', '/markets?event=ETHTEST');
    assert.equal(res.status, 502);
    assert.equal(res.json.code, 'gemini_error');
    assert.equal(res.json.error, 'Gemini did not answer. Try again in a moment.');
    assert.doesNotMatch(JSON.stringify(res.json), /ECONNREFUSED|10\.1\.2\.3|prediction-markets/);
    assert.ok(log.some((line) => line.includes('ECONNREFUSED')));
  } finally {
    await app.close();
  }
});

test('errors the API wrote itself still say what they say', async () => {
  const app = await start(TIGHT);
  try {
    const res = await app.call('POST', '/bets', { user: 'primary' });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'missing_field');
    assert.equal((await app.call('GET', '/nowhere')).json.code, 'not_found');
    assert.equal((await app.call('POST', '/bets', app.betBody({ event: 'NOPE' }))).status, 404);
  } finally {
    await app.close();
  }
});

test('a quote whose order books cannot be read says so in its own words, for every product; the exchange\'s text goes to the log', async (t) => {
  const log = captureLog(t);
  const app = await start(LADDER, { waiveMarkup: true });
  try {
    app.exchange.depthUnavailable = true;
    const sym = (strike: number) => app.exchange.symbol(strike);
    const urls = [
      `/quote?event=ETHTEST&condition=${sym(1800)}&target=${sym(1840)}&stake=10`,
      `/quote?product=range&event=ETHTEST&low=${sym(1800)}&high=${sym(1840)}&stake=10`,
      `/quote?product=breakout&event=ETHTEST&low=${sym(1800)}&high=${sym(1840)}&stake=10`,
    ];
    for (const url of urls) {
      const res = await app.call('GET', url);
      assert.equal(res.status, 200, url);
      assert.deepEqual(res.json.depth, { unavailable: 'The live order book could not be read just now.' }, url);
    }
    assert.ok(log.some((line) => line.includes('No order-book depth arrived')));
  } finally {
    await app.close();
  }
});

test('a basket leg that meets an error: the leg failed with its own sentence, no path; the bet it left behind is failed, not "placing"', async (t) => {
  const log = captureLog(t);
  const app = await start(LADDER, { waiveMarkup: true, orderLookupWaitsMs: [0, 0, 0] });
  try {
    const real = app.ledger.save.bind(app.ledger);
    let thrown = false;
    app.ledger.save = () => {
      if (!thrown && app.ledger.data.bets.length === 2) {
        thrown = true; // the second leg's bet has just been recorded
        throw new Error(DISK);
      }
      real();
    };
    const res = await app.call('POST', '/baskets', {
      user: 'primary',
      legs: [
        { event: 'ETHTEST', condition: app.exchange.symbol(1800), target: app.exchange.symbol(1840), stake: 10 },
        { event: 'ETHTEST', product: 'range', low: app.exchange.symbol(1800), high: app.exchange.symbol(1840), stake: 14.2 },
      ],
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.json.basket.failed, { index: 1, code: 'error', message: 'This bet could not be placed.' });
    assert.doesNotMatch(JSON.stringify(res.json), NO_LEAK);
    assert.equal(res.json.bets.length, 1);
    assert.ok(log.some((line) => line.includes('ENOSPC')));
    assert.equal(app.ledger.data.bets.length, 2);
    assert.equal(app.ledger.data.bets[1]!.status, 'failed');
    assert.match(app.ledger.data.bets[1]!.note ?? '', /could not be recorded, so no order was sent/);
    assert.equal(app.exchange.sent.length, 2, 'only the first leg\'s two orders');
  } finally {
    await app.close();
  }
});

test('an order book that cannot be read is refused in the app\'s own words, for every product and for a cash-out; the exchange\'s text goes to the log', async (t) => {
  const log = captureLog(t);
  const app = await start(LADDER, { waiveMarkup: true });
  try {
    const sym = (strike: number) => app.exchange.symbol(strike);
    const placed = await app.call('POST', '/bets', app.betBody({ condition: sym(1800), target: sym(1820) }));
    assert.equal(placed.status, 201);
    app.exchange.depthUnavailable = true;
    const bodies = [
      app.betBody({ condition: sym(1800), target: sym(1840) }),
      { product: 'range', user: 'primary', event: 'ETHTEST', low: sym(1800), high: sym(1840), stake: 10 },
      { product: 'breakout', user: 'primary', event: 'ETHTEST', low: sym(1800), high: sym(1840), stake: 10 },
    ];
    for (const body of bodies) {
      const res = await app.call('POST', '/bets', body);
      assert.equal(res.status, 422);
      assert.equal(res.json.code, 'no_depth');
      assert.equal(res.json.error, 'Could not read the live order book, so no order was sent.');
    }
    const out = await app.call('POST', '/cashout', { bet: placed.json.bet.id });
    assert.equal(out.status, 422);
    assert.equal(out.json.code, 'no_bid');
    assert.equal(out.json.error, 'Could not read the live order book, so nothing was priced.');
    const quote = await app.call('GET', `/cashout?bet=${placed.json.bet.id}`);
    assert.equal(quote.json.reason, 'Could not read the live order book, so nothing was priced.');
    assert.ok(log.some((line) => line.includes('No order-book depth arrived')));
  } finally {
    await app.close();
  }
});
