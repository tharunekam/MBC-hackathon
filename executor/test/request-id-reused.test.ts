/**
 * A request id sent again for the SAME request answers with the bet (or basket) placed the first time. Sent again for a
 * DIFFERENT request it answers 409 "request_id_reused" and places nothing: before, whatever else the caller asked for, it
 * got the first bet back with 200 and nothing said it was not what it asked for.
 *
 * "Different" is what the person chose: the product, the market, the two levels, the direction and the stake to the cent
 * (the legs of a basket, in order). The price limit, the slippage, what to do if the hedge fails and a basket's name are not
 * choices, so changing them is still a repeat.
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
const ID = 'req_reuse-0001';
const WORDS = 'That request id was already used for a different request. Send a new request id for a new bet.';

type App = Awaited<ReturnType<typeof start>>;
const up = (app: App, extra: object = {}) => app.betBody({ condition: app.exchange.symbol(1800), target: app.exchange.symbol(1820), requestId: ID, ...extra });
const box = (app: App, product: 'range' | 'breakout', extra: object = {}) => ({
  product,
  user: 'primary',
  event: 'ETHTEST',
  low: app.exchange.symbol(1800),
  high: app.exchange.symbol(1840),
  stake: product === 'range' ? 14.2 : 12.4,
  slippageTicks: 0,
  requestId: ID,
  ...extra,
});
// two legs that a basket places: a Stake Back and a range, on the same ladder
const leg = (app: App, extra: object = {}) => ({ event: 'ETHTEST', condition: app.exchange.symbol(1800), target: app.exchange.symbol(1840), stake: 10, ...extra });
const leg2 = (app: App, extra: object = {}) => ({ event: 'ETHTEST', product: 'range', low: app.exchange.symbol(1800), high: app.exchange.symbol(1840), stake: 14.2, ...extra });
const basket = (app: App, legs: object[], extra: object = {}) => ({ user: 'primary', requestId: ID, legs, ...extra });

async function reused(call: Promise<{ status: number; json: { code?: string; error?: string; bet?: unknown; repeated?: boolean } }>) {
  const res = await call;
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'request_id_reused');
  assert.equal(res.json.error, WORDS);
  assert.equal(res.json.bet, undefined, 'the first bet is not handed back as if it were the answer');
}

test('a bet sent again with the same choices is a repeat; with any other choice it is request_id_reused, and nothing is sent', async () => {
  const app = await start(LADDER, { waiveMarkup: true });
  try {
    const first = await app.call('POST', '/bets', up(app));
    assert.equal(first.status, 201);
    const sent = app.exchange.sent.length;
    const same = await app.call('POST', '/bets', up(app));
    assert.equal(same.status, 200);
    assert.equal(same.json.repeated, true);
    assert.equal(same.json.bet.id, first.json.bet.id);

    // each thing the person chose
    await reused(app.call('POST', '/bets', up(app, { stake: 40 })));
    await reused(app.call('POST', '/bets', up(app, { stake: 10.01 })));
    await reused(app.call('POST', '/bets', up(app, { target: app.exchange.symbol(1840) })));
    await reused(app.call('POST', '/bets', up(app, { condition: app.exchange.symbol(1780) })));
    await reused(app.call('POST', '/bets', up(app, { direction: 'down' })));
    await reused(app.call('POST', '/bets', box(app, 'range')));
    await reused(app.call('POST', '/bets', box(app, 'breakout')));
    assert.equal(app.exchange.sent.length, sent, 'no order for any of them');
    assert.equal(app.ledger.data.bets.length, 1);
  } finally {
    await app.close();
  }
});

test('what is not a choice may differ: the stake to the cent, the price limit, the slippage, the hedge rule', async () => {
  const app = await start(LADDER, { waiveMarkup: true });
  try {
    const first = await app.call('POST', '/bets', up(app, { stake: 10 }));
    assert.equal(first.status, 201);
    for (const extra of [{ stake: 10.004 }, { stake: '10' }, { stake: ' 10.00 ' }, { maxPrice: 0.9 }, { slippageTicks: 3 }, { onHedgeFail: 'leave' }, { maxPrice: 0.5, slippageTicks: 0, onHedgeFail: 'unwind' }]) {
      const again = await app.call('POST', '/bets', up(app, extra));
      assert.equal(again.status, 200, JSON.stringify(extra));
      assert.equal(again.json.repeated, true);
      assert.equal(again.json.bet.id, first.json.bet.id);
    }
    assert.equal(app.ledger.data.bets.length, 1);
  } finally {
    await app.close();
  }
});

test('a range and a breakout are told apart from each other and from a different pair of levels', async () => {
  const app = await start(LADDER, { waiveMarkup: true });
  try {
    const ranged = await app.call('POST', '/bets', box(app, 'range'));
    assert.equal(ranged.status, 201);
    assert.equal((await app.call('POST', '/bets', box(app, 'range', { maxPrice: 0.9 }))).json.repeated, true);
    await reused(app.call('POST', '/bets', box(app, 'breakout', { stake: 14.2 })));
    await reused(app.call('POST', '/bets', box(app, 'range', { high: app.exchange.symbol(1820) })));
    await reused(app.call('POST', '/bets', box(app, 'range', { low: app.exchange.symbol(1780) })));
    await reused(app.call('POST', '/bets', box(app, 'range', { stake: 20 })));
    await reused(app.call('POST', '/bets', up(app)));

    const app2 = await start(LADDER, { waiveMarkup: true });
    try {
      assert.equal((await app2.call('POST', '/bets', box(app2, 'breakout'))).status, 201);
      assert.equal((await app2.call('POST', '/bets', box(app2, 'breakout'))).json.repeated, true);
      await reused(app2.call('POST', '/bets', box(app2, 'range', { stake: 12.4 })));
    } finally {
      await app2.close();
    }
  } finally {
    await app.close();
  }
});

test('a falling bet is a repeat of itself, and is not the rising bet on the same levels', async () => {
  const app = await start(LADDER, { waiveMarkup: true });
  try {
    const down = (extra: object = {}) => app.betBody({ condition: app.exchange.symbol(1820), target: app.exchange.symbol(1800), direction: 'down', requestId: ID, ...extra });
    assert.equal((await app.call('POST', '/bets', down())).status, 201);
    assert.equal((await app.call('POST', '/bets', down())).json.repeated, true);
    assert.equal((await app.call('POST', '/bets', down({ direction: undefined }))).status, 409);
    await reused(app.call('POST', '/bets', down({ condition: app.exchange.symbol(1840) })));
  } finally {
    await app.close();
  }
});

test('the choice is remembered across a restart: the ledger carries it, and the answer does not show it', async () => {
  const app = await start(LADDER, { waiveMarkup: true });
  let restarted: App | undefined;
  try {
    const first = await app.call('POST', '/bets', up(app));
    assert.equal(first.status, 201);
    assert.equal(first.json.bet.requestKey, undefined, 'the fingerprint is not part of the bet the page sees');
    assert.equal((await app.call('GET', '/bets')).json.bets[0].requestKey, undefined);
    assert.match(app.ledger.bet(first.json.bet.id)!.requestKey ?? '', /^[0-9a-f]{16}$/);

    restarted = await start(LADDER, { ledger: new Ledger(app.ledger.path), exchange: app.exchange, waiveMarkup: true, idFrom: 100 });
    assert.equal((await restarted.call('POST', '/bets', up(restarted))).json.repeated, true);
    await reused(restarted.call('POST', '/bets', up(restarted, { stake: 99 })));
  } finally {
    await restarted?.close();
    await app.close();
  }
});

test('a bet recorded before choices were kept has nothing to compare, so a repeat of its id is answered as before', async () => {
  const app = await start(LADDER, { waiveMarkup: true });
  try {
    const first = await app.call('POST', '/bets', up(app));
    delete app.ledger.bet(first.json.bet.id)!.requestKey;
    const again = await app.call('POST', '/bets', up(app, { stake: 40 }));
    assert.equal(again.status, 200);
    assert.equal(again.json.repeated, true);
  } finally {
    await app.close();
  }
});

test('a request id is one account\'s: another account may use the same id for another bet', async () => {
  const app = await start(LADDER, { waiveMarkup: true });
  try {
    assert.equal((await app.call('POST', '/bets', up(app))).status, 201);
    const other = await app.call('POST', '/bets', up(app, { user: 'alice', stake: 40 }));
    assert.equal(other.status, 201);
  } finally {
    await app.close();
  }
});

// ------------------------------------------------------------------ baskets

test('a basket sent again with the same legs is a repeat, whatever its name and price limits; any other list is request_id_reused', async () => {
  const app = await start(LADDER, { waiveMarkup: true });
  try {
    const first = await app.call('POST', '/baskets', basket(app, [leg(app), leg2(app)], { name: 'Mine' }));
    assert.equal(first.status, 201);
    const sent = app.exchange.sent.length;

    for (const extra of [{}, { name: 'Another name' }, { name: undefined }]) {
      const again = await app.call('POST', '/baskets', basket(app, [leg(app), leg2(app)], extra));
      assert.equal(again.status, 200);
      assert.equal(again.json.repeated, true);
      assert.equal(again.json.basket.id, first.json.basket.id);
    }
    const limited = await app.call('POST', '/baskets', basket(app, [leg(app, { maxPrice: 0.99 }), leg2(app, { maxPrice: 0.98 })]));
    assert.equal(limited.json.repeated, true, 'a price limit is not a choice');

    const wrong = [
      basket(app, [leg2(app), leg(app)]), // the same legs the other way round: the list is ordered
      basket(app, [leg(app, { stake: 11 }), leg2(app)]),
      basket(app, [leg(app), leg2(app, { stake: 14.21 })]),
      basket(app, [leg(app), leg2(app), leg(app, { stake: 7 })]),
      basket(app, [leg(app), leg2(app, { high: app.exchange.symbol(1820) })]),
      basket(app, [leg(app, { direction: 'down' }), leg2(app)]),
      basket(app, [leg(app), leg2(app, { product: 'breakout' })]),
    ];
    for (const body of wrong) await reused(app.call('POST', '/baskets', body));
    assert.equal(app.exchange.sent.length, sent, 'nothing more was sent');
    assert.equal(app.ledger.data.bets.length, 2);
  } finally {
    await app.close();
  }
});

test('a basket\'s choice is kept on its record and survives a restart', async () => {
  const app = await start(LADDER, { waiveMarkup: true });
  let restarted: App | undefined;
  try {
    const first = await app.call('POST', '/baskets', basket(app, [leg(app), leg2(app)]));
    assert.equal(first.status, 201);
    assert.match(app.ledger.data.baskets![first.json.basket.id]!.requestKey ?? '', /^[0-9a-f]{16}$/);
    restarted = await start(LADDER, { ledger: new Ledger(app.ledger.path), exchange: app.exchange, waiveMarkup: true, idFrom: 100 });
    assert.equal((await restarted.call('POST', '/baskets', basket(restarted, [leg(restarted), leg2(restarted)]))).json.repeated, true);
    await reused(restarted.call('POST', '/baskets', basket(restarted, [leg(restarted, { stake: 9 }), leg2(restarted)])));
  } finally {
    await restarted?.close();
    await app.close();
  }
});
