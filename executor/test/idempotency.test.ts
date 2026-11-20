/**
 * POST /bets and POST /baskets are safe to repeat. An app that times out, a gateway that answers 504 while the executor
 * carries on, or a double click used to place the same bet twice. With a "requestId" the second request finds the first
 * one's bet (or basket) in the ledger, inside the same per-user queue, and answers with it without sending an order.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from '../src/ledger.ts';
import { TIGHT, start } from './api-harness.ts';
import type { Json } from './api-harness.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ID = 'req_0001-abcdef';

const LADDER = [
  { strike: 1780, bid: 0.88, ask: 0.9 },
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.6, ask: 0.62 },
  { strike: 1840, bid: 0.4, ask: 0.42 },
];

type App = Awaited<ReturnType<typeof start>>;
const basketBody = (app: App, extra: object = {}) => ({
  user: 'primary',
  name: 'Two views',
  legs: [
    { event: 'ETHTEST', condition: app.exchange.symbol(1800), target: app.exchange.symbol(1840), stake: 10 },
    { event: 'ETHTEST', product: 'range', low: app.exchange.symbol(1800), high: app.exchange.symbol(1840), stake: 14.2 },
  ],
  ...extra,
});

test('the same request twice places one bet: the second answer is 200, "repeated", and the very same bet', async () => {
  const app = await start(TIGHT);
  try {
    const first = await app.call('POST', '/bets', app.betBody({ requestId: ID }));
    assert.equal(first.status, 201);
    assert.equal(first.json.repeated, undefined, 'a fresh placement reads exactly as it did before');
    assert.equal(first.json.bet.clientRequestId, ID);
    const sent = app.exchange.sent.length;
    assert.equal(sent, 2);

    const again = await app.call('POST', '/bets', app.betBody({ requestId: ID }));
    assert.equal(again.status, 200);
    assert.equal(again.json.repeated, true);
    assert.deepEqual(again.json.bet, first.json.bet, 'the same bet, field for field');
    assert.deepEqual(again.json.stakeReduced, first.json.stakeReduced);
    assert.equal(app.exchange.sent.length, sent, 'no order went out for the repeat');
    assert.equal(app.ledger.data.bets.length, 1);
    assert.equal((await app.call('GET', '/reconcile')).json.ok, true);
  } finally {
    await app.close();
  }
});

test('a repeat gets the original bet whatever its state: a bet that failed stays the answer for its id', async () => {
  const app = await start(TIGHT);
  try {
    app.exchange.setBook(1820, { askSize: 0 }); // the depth read still says there is size; the order finds none
    app.exchange.reportedDepth.set(app.exchange.symbol(1820), { askSize: 1000, bidSize: 1000 });
    const first = await app.call('POST', '/bets', app.betBody({ requestId: ID }));
    assert.equal(first.status, 201);
    assert.equal(first.json.bet.status, 'failed');
    const again = await app.call('POST', '/bets', app.betBody({ requestId: ID }));
    assert.equal(again.status, 200);
    assert.equal(again.json.repeated, true);
    assert.equal(again.json.bet.id, first.json.bet.id);
    assert.equal(app.ledger.data.bets.length, 1);
  } finally {
    await app.close();
  }
});

test('two different request ids are two bets', async () => {
  const app = await start(TIGHT);
  try {
    const a = await app.call('POST', '/bets', app.betBody({ requestId: ID }));
    const b = await app.call('POST', '/bets', app.betBody({ requestId: 'req_0002-abcdef' }));
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.notEqual(a.json.bet.id, b.json.bet.id);
    assert.equal(b.json.repeated, undefined);
    assert.equal(app.ledger.data.bets.length, 2);
    assert.deepEqual(app.ledger.data.bets.map((x) => x.clientRequestId), [ID, 'req_0002-abcdef']);
  } finally {
    await app.close();
  }
});

test('with no request id nothing changes: the same body twice is still two bets, both 201', async () => {
  const app = await start(TIGHT);
  try {
    const a = await app.call('POST', '/bets', app.betBody());
    const b = await app.call('POST', '/bets', app.betBody());
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.equal(a.json.repeated, undefined);
    assert.equal(b.json.repeated, undefined);
    assert.equal(app.ledger.data.bets.length, 2);
    assert.ok(app.ledger.data.bets.every((x) => x.clientRequestId === undefined && !('clientRequestId' in x)));
    // a null id is "none", as a null maxPrice is
    const c = await app.call('POST', '/bets', app.betBody({ requestId: null }));
    assert.equal(c.status, 201);
  } finally {
    await app.close();
  }
});

test('two identical requests sent at the same moment: one places it, the other waits for it and gets it', async () => {
  const app = await start(TIGHT);
  try {
    const slow = app.exchange.placeOrder.bind(app.exchange);
    app.exchange.placeOrder = async (req) => (await sleep(30), slow(req));
    const [a, b] = await Promise.all([app.call('POST', '/bets', app.betBody({ requestId: ID })), app.call('POST', '/bets', app.betBody({ requestId: ID }))]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    const [fresh, repeat] = a.status === 201 ? [a, b] : [b, a];
    assert.equal(repeat.json.repeated, true);
    assert.equal(repeat.json.bet.id, fresh.json.bet.id);
    assert.equal(repeat.json.bet.status, 'open', 'it waited for the first to finish, so it reads the finished bet, not one half placed');
    assert.equal(app.ledger.data.bets.length, 1);
    assert.equal(app.exchange.sent.length, 2);
  } finally {
    await app.close();
  }
});

test('a client that gives up mid-request and tries again gets the original bet, and the money is spent once', async () => {
  const app = await start(TIGHT);
  try {
    const slow = app.exchange.placeOrder.bind(app.exchange);
    app.exchange.placeOrder = async (req) => (await sleep(150), slow(req)); // a bet that takes about 300 ms, as on a slow exchange
    const cash = await app.exchange.cash();

    const gone = new AbortController();
    const first = fetch(`${app.base}/bets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(app.betBody({ requestId: ID })), signal: gone.signal }).then(
      () => 'answered',
      (err: Error) => err.name,
    );
    await sleep(60); // the first order is on its way
    gone.abort();
    assert.equal(await first, 'AbortError', 'the client really went away');

    const retry = await app.call('POST', '/bets', app.betBody({ requestId: ID }));
    assert.equal(retry.status, 200);
    assert.equal(retry.json.repeated, true);
    assert.equal(retry.json.bet.status, 'open', 'the bet the first request went on to place');
    assert.equal(app.ledger.data.bets.length, 1);
    assert.equal(app.ledger.data.bets[0]!.id, retry.json.bet.id);
    assert.equal(app.exchange.sent.length, 2, 'two orders in all: one bet');
    const spent = cash - (await app.exchange.cash());
    assert.ok(spent > 9 && spent < 10.01, `one bet's worth was spent, got ${spent}`);
  } finally {
    await app.close();
  }
});

test('the id is on the bet in the file, so a restarted executor still recognises a repeat', async () => {
  const app = await start(TIGHT);
  let restarted: App | undefined;
  try {
    const first = await app.call('POST', '/bets', app.betBody({ requestId: ID }));
    assert.equal(first.status, 201);
    const reloaded = new Ledger(app.ledger.path);
    assert.equal(reloaded.data.bets[0]!.clientRequestId, ID);
    const sent = app.exchange.sent.length;

    restarted = await start(TIGHT, { ledger: reloaded, exchange: app.exchange, idFrom: 100 });
    const again = await restarted.call('POST', '/bets', restarted.betBody({ requestId: ID }));
    assert.equal(again.status, 200);
    assert.equal(again.json.repeated, true);
    assert.equal(again.json.bet.id, first.json.bet.id);
    assert.equal(app.exchange.sent.length, sent);
    assert.equal(reloaded.data.bets.length, 1);
  } finally {
    await restarted?.close();
    await app.close();
  }
});

test('ranges and breakouts are repeat-safe too', async () => {
  const app = await start(LADDER);
  try {
    for (const product of ['range', 'breakout'] as const) {
      const body = { product, user: 'primary', event: 'ETHTEST', low: app.exchange.symbol(1800), high: app.exchange.symbol(1840), stake: 10, requestId: `${product}-req-0001` };
      const a = await app.call('POST', '/bets', body);
      const b = await app.call('POST', '/bets', body);
      assert.deepEqual([a.status, b.status], [201, 200], product);
      assert.equal(b.json.repeated, true);
      assert.equal(b.json.bet.id, a.json.bet.id);
      assert.equal(b.json.bet.product, product);
      assert.equal(app.ledger.data.bets.filter((x) => x.product === product).length, 1);
    }
  } finally {
    await app.close();
  }
});

test('the id belongs to one account: another user sending the same id places their own bet', async () => {
  const app = await start(TIGHT);
  try {
    const mine = await app.call('POST', '/bets', app.betBody({ requestId: ID }));
    const theirs = await app.call('POST', '/bets', app.betBody({ requestId: ID, user: 'alice' }));
    assert.deepEqual([mine.status, theirs.status], [201, 201]);
    assert.notEqual(mine.json.bet.id, theirs.json.bet.id);
  } finally {
    await app.close();
  }
});

test('a request that is refused places nothing and records nothing, so the same id can be sent again', async () => {
  const app = await start(TIGHT);
  try {
    const refused = await app.call('POST', '/bets', app.betBody({ requestId: ID, maxPrice: 0.3 }));
    assert.equal(refused.status, 422);
    assert.equal(refused.json.code, 'price_above_limit');
    assert.ok(refused.json.quote, 'the refusal still carries the quote it was refused on');
    assert.equal(app.ledger.data.bets.length, 0);
    const later = await app.call('POST', '/bets', app.betBody({ requestId: ID }));
    assert.equal(later.status, 201);
    assert.equal(later.json.repeated, undefined);
  } finally {
    await app.close();
  }
});

test('a malformed request id is 400 bad_request_id, before anything is placed', async () => {
  const app = await start(TIGHT);
  try {
    const bad: Array<[string, unknown]> = [
      ['too short', 'short'],
      ['seven characters', 'abcdefg'],
      ['too long', 'a'.repeat(65)],
      ['a space', 'has a space1'],
      ['a slash', 'bad/slash-id1'],
      ['a newline at the end', 'abcdefgh\n'],
      ['empty', ''],
      ['a number', 12345678],
      ['an object', { id: 'abcdefgh' }],
      ['a list', ['abcdefgh']],
      ['a boolean', true],
    ];
    for (const [why, requestId] of bad) {
      const res = await app.call('POST', '/bets', app.betBody({ requestId }));
      assert.equal(res.status, 400, why);
      assert.equal(res.json.code, 'bad_request_id', why);
      const basket = await app.call('POST', '/baskets', { ...basketBody(app), requestId });
      assert.equal(basket.status, 400, `${why} (basket)`);
      assert.equal(basket.json.code, 'bad_request_id', `${why} (basket)`);
    }
    for (const fine of ['abcdefgh', 'A'.repeat(64), 'a-b_c-d_9Z', '550e8400-e29b-41d4-a716-446655440000']) {
      assert.equal((await app.call('POST', '/bets', app.betBody({ requestId: fine, stake: 2 }))).status, 201, fine);
    }
    assert.equal(app.ledger.data.bets.length, 4);
  } finally {
    await app.close();
  }
});

// ------------------------------------------------------------------ baskets

test('the same basket request twice places one basket: the second is 200, "repeated", and the same bets', async () => {
  const app = await start(LADDER);
  try {
    const first = await app.call('POST', '/baskets', basketBody(app, { requestId: ID }));
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(first.json.repeated, undefined);
    const sent = app.exchange.sent.length;
    assert.equal(app.ledger.data.bets.length, 2);
    assert.ok(app.ledger.data.bets.every((b) => b.clientRequestId === ID), 'on every bet of the basket');
    const record = app.ledger.data.baskets![first.json.basket.id]!;
    assert.equal(record.clientRequestId, ID, 'and on the basket record');
    assert.equal(record.done, true);

    const again = await app.call('POST', '/baskets', basketBody(app, { requestId: ID }));
    assert.equal(again.status, 200);
    assert.equal(again.json.repeated, true);
    assert.deepEqual(again.json.basket, first.json.basket);
    assert.deepEqual(again.json.bets, first.json.bets);
    assert.equal(app.exchange.sent.length, sent, 'no order went out for the repeat');
    assert.equal(app.ledger.data.bets.length, 2);
    assert.equal((await app.call('GET', '/reconcile')).json.ok, true);
  } finally {
    await app.close();
  }
});

test('a basket repeat survives a restart, and two ids are two baskets', async () => {
  const app = await start(LADDER);
  let restarted: App | undefined;
  try {
    const first = await app.call('POST', '/baskets', basketBody(app, { requestId: ID }));
    const reloaded = new Ledger(app.ledger.path);
    restarted = await start(LADDER, { ledger: reloaded, exchange: app.exchange, idFrom: 100 });
    const sent = app.exchange.sent.length;
    const again = await restarted.call('POST', '/baskets', basketBody(restarted, { requestId: ID }));
    assert.equal(again.status, 200);
    assert.equal(again.json.basket.id, first.json.basket.id);
    assert.equal(app.exchange.sent.length, sent);

    const other = await restarted.call('POST', '/baskets', basketBody(restarted, { requestId: 'req_0002-abcdef' }));
    assert.equal(other.status, 201);
    assert.notEqual(other.json.basket.id, first.json.basket.id);
    assert.equal(reloaded.data.bets.length, 4);
  } finally {
    await restarted?.close();
    await app.close();
  }
});

test('with no request id a basket is placed every time, as before; and a basket and a bet may use the same id', async () => {
  const app = await start(LADDER);
  try {
    assert.equal((await app.call('POST', '/baskets', basketBody(app))).status, 201);
    assert.equal((await app.call('POST', '/baskets', basketBody(app))).status, 201);
    assert.equal(app.ledger.data.bets.length, 4);
    assert.equal(app.ledger.data.baskets, undefined, 'no record is kept for a basket that came without an id');

    const basket = await app.call('POST', '/baskets', basketBody(app, { requestId: ID }));
    assert.equal(basket.status, 201);
    // The bets of that basket are not what a single-bet request with the same id means.
    const single = await app.call('POST', '/bets', { user: 'primary', event: 'ETHTEST', condition: app.exchange.symbol(1800), target: app.exchange.symbol(1840), stake: 5, requestId: ID });
    assert.equal(single.status, 201);
    assert.equal(single.json.repeated, undefined);
    const singleAgain = await app.call('POST', '/bets', { user: 'primary', event: 'ETHTEST', condition: app.exchange.symbol(1800), target: app.exchange.symbol(1840), stake: 5, requestId: ID });
    assert.equal(singleAgain.status, 200);
    assert.equal(singleAgain.json.bet.id, single.json.bet.id);
  } finally {
    await app.close();
  }
});

test('a basket that is refused whole records nothing, so its id can be sent again', async () => {
  const app = await start(LADDER);
  try {
    const bad = basketBody(app, { requestId: ID });
    (bad.legs[1] as Json).low = app.exchange.symbol(1840); // low above high: not a range
    (bad.legs[1] as Json).high = app.exchange.symbol(1800);
    const refused = await app.call('POST', '/baskets', bad);
    assert.equal(refused.status, 422);
    assert.equal(refused.json.refused, true);
    assert.equal(app.ledger.data.baskets, undefined);
    const fine = await app.call('POST', '/baskets', basketBody(app, { requestId: ID }));
    assert.equal(fine.status, 201);
  } finally {
    await app.close();
  }
});

test('a basket the process died in the middle of is answered as it stands: the legs it never reached are not placed', async () => {
  const app = await start(LADDER);
  try {
    const first = await app.call('POST', '/baskets', basketBody(app, { requestId: ID }));
    const id = first.json.basket.id;
    // As a crash after the first bet would leave the file: the second bet and the basket's closing write never happened.
    app.ledger.data.bets.pop();
    const record = app.ledger.data.baskets![id]!;
    record.done = false;
    record.failed = null;
    app.ledger.save();
    const sent = app.exchange.sent.length;

    const again = await app.call('POST', '/baskets', basketBody(app, { requestId: ID }));
    assert.equal(again.status, 200);
    assert.equal(again.json.repeated, true);
    assert.equal(again.json.bets.length, 1);
    assert.deepEqual(again.json.basket.failed, { index: 1, code: 'interrupted', message: 'This basket was interrupted before every bet was placed. The rest were not placed.' });
    assert.equal(app.exchange.sent.length, sent);
  } finally {
    await app.close();
  }
});

test('a basket whose later leg could not be completed repeats with the same failure', async () => {
  const app = await start(LADDER);
  try {
    // The second leg's own order finds nothing, though the up-front check saw size.
    app.exchange.reportedDepth.set(app.exchange.symbol(1800), { bidSize: 1000, askSize: 1000 });
    app.exchange.reportedDepth.set(app.exchange.symbol(1840), { bidSize: 1000, askSize: 1000 });
    const real = app.exchange.placeOrder.bind(app.exchange);
    app.exchange.placeOrder = async (req) => {
      if (/-rg-/.test(req.clientOrderId)) app.exchange.setBook(1800, { askSize: 0 });
      return real(req);
    };
    const first = await app.call('POST', '/baskets', basketBody(app, { requestId: ID }));
    assert.equal(first.status, 201);
    assert.notEqual(first.json.basket.failed, null, 'the second leg did not go through');
    const again = await app.call('POST', '/baskets', basketBody(app, { requestId: ID }));
    assert.equal(again.status, 200);
    assert.deepEqual(again.json.basket, first.json.basket);
    assert.equal(again.json.bets.length, first.json.bets.length);
  } finally {
    await app.close();
  }
});
