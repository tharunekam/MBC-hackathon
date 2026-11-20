/**
 * A basket sent with a request id keeps a record so a repeat can be answered from the ledger. That record must not outlive a
 * basket that placed nothing (or the same id could never be sent again), and its last write must reach the disk. A basket
 * leg may also carry "maxPrice", the highest price per $1 it may be bought at, as a single bet does.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from '../src/ledger.ts';
import { start } from './api-harness.ts';

const LADDER = [
  { strike: 1780, bid: 0.88, ask: 0.9 },
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.6, ask: 0.62 },
  { strike: 1840, bid: 0.4, ask: 0.42 },
];
const ID = 'basket_rec-0001';

type App = Awaited<ReturnType<typeof start>>;
const parlayLeg = (app: App, extra: object = {}) => ({ event: 'ETHTEST', condition: app.exchange.symbol(1800), target: app.exchange.symbol(1840), stake: 10, ...extra });
const rangeLeg = (app: App, extra: object = {}) => ({ event: 'ETHTEST', product: 'range', low: app.exchange.symbol(1800), high: app.exchange.symbol(1840), stake: 14.2, ...extra });
const breakoutLeg = (app: App, extra: object = {}) => ({ event: 'ETHTEST', product: 'breakout', low: app.exchange.symbol(1800), high: app.exchange.symbol(1840), stake: 12.4, ...extra });
const basket = (legs: object[], extra: object = {}) => ({ user: 'primary', requestId: ID, legs, ...extra });
const records = (app: App) => Object.keys(app.ledger.data.baskets ?? {});

/** The books of the exchange read as empty from the `from`th order-book read on (one per contract per check). */
function thinFrom(app: App, from: number) {
  const real = app.exchange.topOfBook.bind(app.exchange);
  const state = { reads: 0, on: true };
  app.exchange.topOfBook = async (symbol) => {
    const book = await real(symbol);
    return state.on && ++state.reads >= from ? { ...book, bidSize: 0, askSize: 0 } : book;
  };
  return state;
}

// ------------------------------------------------------------------ the record of a basket that placed nothing

test('a basket whose first leg is turned down before any order leaves no record: the same id can be sent again and is placed', async () => {
  const app = await start(LADDER, { waiveMarkup: true });
  try {
    // Both legs pass the check made first (two reads each); a moment later the first leg's own check finds nothing resting.
    const thin = thinFrom(app, 5);
    const refused = await app.call('POST', '/baskets', basket([parlayLeg(app), rangeLeg(app)]));
    assert.equal(refused.status, 422);
    assert.equal(refused.json.code, 'insufficient_depth');
    assert.equal(refused.json.leg, 0);
    assert.deepEqual(records(app), [], 'no record of a basket that placed nothing');
    assert.equal(app.ledger.data.bets.length, 0);
    assert.equal(app.exchange.sent.length, 0);
    assert.deepEqual(Object.keys(new Ledger(app.ledger.path).data.baskets ?? {}), [], 'and none on disk');

    thin.on = false; // the book is back
    const again = await app.call('POST', '/baskets', basket([parlayLeg(app), rangeLeg(app)]));
    assert.equal(again.status, 201, 'a new basket, not the answer to an old one');
    assert.equal(again.json.repeated, undefined);
    assert.equal(again.json.basket.failed, null);
    assert.equal(again.json.bets.length, 2);
    assert.equal(records(app).length, 1);
  } finally {
    await app.close();
  }
});

test('a basket whose first leg meets an error before it is even recorded leaves no record either', async () => {
  let calls = 0;
  const app = await start(LADDER, {
    waiveMarkup: true,
    newId: () => {
      // the basket's own id is the first, the first leg's bet id the second
      if (++calls === 2) throw new Error("boom at '/srv/app/ids.ts'");
      return `api${calls}`;
    },
  });
  const log = console.error;
  console.error = () => undefined;
  try {
    const first = await app.call('POST', '/baskets', basket([parlayLeg(app), rangeLeg(app)]));
    assert.equal(first.status, 201);
    assert.deepEqual(first.json.basket.failed, { index: 0, code: 'error', message: 'This bet could not be placed.' });
    assert.deepEqual(first.json.bets, []);
    assert.deepEqual(records(app), [], 'nothing was placed, so nothing is kept');
    assert.equal(app.exchange.sent.length, 0);

    const again = await app.call('POST', '/baskets', basket([parlayLeg(app), rangeLeg(app)]));
    assert.equal(again.status, 201);
    assert.equal(again.json.basket.failed, null);
    assert.equal(again.json.bets.length, 2);
  } finally {
    console.error = log;
    await app.close();
  }
});

// ------------------------------------------------------------------ the last write of a basket's record

test('a basket that placed every leg has its record finished on the disk: done, nothing failed', async () => {
  const app = await start(LADDER, { waiveMarkup: true });
  try {
    const res = await app.call('POST', '/baskets', basket([parlayLeg(app), rangeLeg(app)]));
    assert.equal(res.status, 201);
    const onDisk = new Ledger(app.ledger.path).data.baskets![res.json.basket.id]!;
    assert.equal(onDisk.done, true, 'not left looking as if the basket were interrupted');
    assert.equal(onDisk.failed, null);
    assert.equal(onDisk.clientRequestId, ID);

    // A server started from that file answers a repeat with the whole basket, not "interrupted".
    const reborn = await start(LADDER, { ledger: new Ledger(app.ledger.path), exchange: app.exchange, waiveMarkup: true, idFrom: 100 });
    try {
      const again = await reborn.call('POST', '/baskets', basket([parlayLeg(reborn), rangeLeg(reborn)]));
      assert.equal(again.status, 200);
      assert.equal(again.json.basket.failed, null);
      assert.equal(again.json.bets.length, 2);
    } finally {
      await reborn.close();
    }
  } finally {
    await app.close();
  }
});

test('a basket whose second leg could not be completed has the failure on its record on the disk', async () => {
  const app = await start(LADDER, { waiveMarkup: true });
  try {
    // Reads 1 to 4: the check of both legs. 5 and 6: the first leg's own check. From the 7th, the second leg finds an empty book.
    thinFrom(app, 7);
    const res = await app.call('POST', '/baskets', basket([parlayLeg(app), rangeLeg(app)]));
    assert.equal(res.status, 201);
    assert.equal(res.json.bets.length, 1);
    assert.equal(res.json.basket.failed.index, 1);
    assert.equal(res.json.basket.failed.code, 'insufficient_depth');
    const onDisk = new Ledger(app.ledger.path).data.baskets![res.json.basket.id]!;
    assert.equal(onDisk.done, true);
    assert.equal(onDisk.failed?.index, 1);
    assert.equal(onDisk.failed?.code, 'insufficient_depth');
  } finally {
    await app.close();
  }
});

// ------------------------------------------------------------------ a leg's price limit

test('a leg that carries a price limit it cannot meet refuses the whole basket before anything is bought, naming the leg', async () => {
  for (const [legs, at] of [
    [(app: App) => [parlayLeg(app, { maxPrice: 0.01 }), rangeLeg(app)], 0],
    [(app: App) => [parlayLeg(app), rangeLeg(app, { maxPrice: 0.01 })], 1],
    [(app: App) => [parlayLeg(app), breakoutLeg(app, { maxPrice: 0.01 })], 1],
  ] as const) {
    const app = await start(LADDER, { waiveMarkup: true });
    try {
      const res = await app.call('POST', '/baskets', basket(legs(app)));
      assert.equal(res.status, 422, `leg ${at}`);
      assert.equal(res.json.code, 'price_above_limit');
      assert.equal(res.json.leg, at);
      assert.equal(app.exchange.sent.length, 0, 'nothing was bought, not even the legs before it');
      assert.equal(app.ledger.data.bets.length, 0);
      assert.deepEqual(records(app), []);
    } finally {
      await app.close();
    }
  }
});

test('a leg\'s price limit that is not between 0 and 1 is a 400, naming the leg, whatever the product', async () => {
  const app = await start(LADDER, { waiveMarkup: true });
  try {
    for (const bad of [0, 1, 1.5, -0.2, 'cheap', true]) {
      for (const [at, legs] of [
        [1, [parlayLeg(app), rangeLeg(app, { maxPrice: bad })]],
        [0, [parlayLeg(app, { maxPrice: bad }), rangeLeg(app)]],
        [1, [parlayLeg(app), breakoutLeg(app, { maxPrice: bad })]],
      ] as const) {
        const res = await app.call('POST', '/baskets', basket([...legs]));
        assert.equal(res.status, 400, JSON.stringify(bad));
        assert.equal(res.json.code, 'invalid_max_price');
        assert.equal(res.json.leg, at);
        assert.match(res.json.error, new RegExp(`^Leg ${at + 1}: `));
      }
    }
    assert.equal(app.exchange.sent.length, 0);
    // null and absent mean "no limit of its own"
    assert.equal((await app.call('POST', '/baskets', basket([parlayLeg(app, { maxPrice: null }), rangeLeg(app)], { requestId: undefined }))).status, 201);
  } finally {
    await app.close();
  }
});

test('a leg\'s price limit reaches its orders: the first order is limited at the best price when the limit leaves no room, and reaches past it when none is given', async () => {
  const unlimited = await start(LADDER, { waiveMarkup: true });
  const limited = await start(LADDER, { waiveMarkup: true });
  try {
    assert.equal((await unlimited.call('POST', '/baskets', basket([parlayLeg(unlimited), rangeLeg(unlimited)]))).status, 201);
    const quote = await limited.call('GET', `/quote?event=ETHTEST&condition=${limited.exchange.symbol(1800)}&target=${limited.exchange.symbol(1840)}&stake=10`);
    const price: number = quote.json.quote.pricePaid ?? quote.json.quote.allInPrice;
    assert.ok(price > 0 && price < 1);
    const res = await limited.call('POST', '/baskets', basket([parlayLeg(limited, { maxPrice: price + 0.0005 }), rangeLeg(limited)]));
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const ask = 0.42; // the outcome leg is bought on the 1840 strike
    assert.ok(unlimited.exchange.sent[0]!.limitPrice > ask + 1e-9, 'without a limit of its own the order may reach past the best price');
    assert.ok(limited.exchange.sent[0]!.limitPrice <= ask + 1e-9, 'with one it may not');
  } finally {
    await unlimited.close();
    await limited.close();
  }
});
