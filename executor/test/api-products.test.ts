import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WIDE, near, start } from './api-harness.ts';

/** A tight four-strike ladder: everything here passes the offer rule as it stands. See products.test.ts. */
const LADDER = [
  { strike: 1780, bid: 0.88, ask: 0.9 },
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.6, ask: 0.62 },
  { strike: 1840, bid: 0.4, ask: 0.42 },
];

const FALLING = '&direction=down';

test('GET /markets: each ladder also lists the pairs of a bet that a price falls, with real strikes and the real book', async () => {
  const app = await start(LADDER);
  try {
    const res = await app.call('GET', '/markets');
    const event = res.json.events[0];
    // the same offer rule, applied to the mirror: two of the six falling pairs are good value on this ladder
    assert.equal(event.down.offerableCount, 2);
    assert.equal(event.down.refusedCount, 4);
    assert.equal(event.down.pairs.length, 2);
    const pair = event.down.pairs.find((p: { condition: { strike: number }; target: { strike: number } }) => p.condition.strike === 1840 && p.target.strike === 1800);
    assert.ok(pair, 'a falling pair from 1840 down to 1800');
    assert.equal(pair.condition.symbol, app.exchange.symbol(1840));
    assert.equal(pair.condition.bid, 0.4); // the real YES book, not the mirror's
    assert.equal(pair.condition.ask, 0.42);
    near(pair.quote.chanceCondition, 0.59); // the chance it stays below 1840

    const all = await app.call('GET', '/markets?include=refused');
    assert.equal(all.json.events[0].down.pairs.length, 6);
    assert.equal(event.pairs.length, 5); // the rising pairs are unchanged
    assert.ok(event.pairs.every((p: { condition: { strike: number }; target: { strike: number } }) => p.target.strike > p.condition.strike));
  } finally {
    await app.close();
  }
});

test('GET /quote: a falling parlay is priced on the mirror and answered with real strikes', async () => {
  const app = await start(LADDER);
  try {
    const q = `/quote?event=ETHTEST&condition=${app.exchange.symbol(1840)}&target=${app.exchange.symbol(1800)}&stake=10${FALLING}`;
    const res = await app.call('GET', q);
    assert.equal(res.status, 200);
    assert.equal(res.json.product, 'parlay');
    assert.equal(res.json.direction, 'down');
    assert.equal(res.json.condition.strike, 1840);
    assert.equal(res.json.target.strike, 1800);
    assert.equal(res.json.quote.offerable, true);
    near(res.json.quote.chanceBothHappen, 0.19);
    near(res.json.quote.pricePaid, 0.2 / 0.58);
    assert.ok(res.json.stake.cost <= 10.005);
    assert.ok(res.json.stake.ifConditionFails > -0.01 && res.json.stake.ifConditionFails < 0.01);
    assert.ok(res.json.depth.maxStake > 10);

    const up = await app.call('GET', `/quote?event=ETHTEST&condition=${app.exchange.symbol(1800)}&target=${app.exchange.symbol(1840)}&stake=10`);
    assert.equal(up.json.direction, 'up'); // the default
    assert.equal(up.json.condition.strike, 1800);

    const wrongWay = await app.call('GET', `/quote?event=ETHTEST&condition=${app.exchange.symbol(1800)}&target=${app.exchange.symbol(1840)}&stake=10${FALLING}`);
    assert.equal(wrongWay.status, 400);
    assert.equal(wrongWay.json.code, 'not_a_linked_pair');
    assert.match(wrongWay.json.error, /lower than the condition strike/);

    const bad = await app.call('GET', `${q}x`);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'invalid_direction');
  } finally {
    await app.close();
  }
});

test('GET /quote: a range answers with its chance, its price, what comes back whatever happens, and what each result nets', async () => {
  const app = await start(LADDER);
  try {
    const q = `/quote?product=range&event=ETHTEST&low=${app.exchange.symbol(1800)}&high=${app.exchange.symbol(1840)}&stake=14.2`;
    const res = await app.call('GET', q);
    assert.equal(res.status, 200);
    assert.equal(res.json.product, 'range');
    assert.equal(res.json.low.strike, 1800);
    assert.equal(res.json.high.strike, 1840);
    assert.equal(res.json.quote.offerable, true);
    near(res.json.quote.chanceInRange, 0.4);
    near(res.json.quote.pricePaid, 0.42);
    near(res.json.stake.contracts, 10);
    near(res.json.stake.cost, 14.2);
    near(res.json.stake.backAlways, 10);
    near(res.json.stake.ifInRange, 5.8);
    near(res.json.stake.ifOutside, -4.2);
    assert.equal(res.json.stake.reduced, false);
    assert.ok(res.json.depth.maxStake > 14.2);

    const backwards = await app.call('GET', `/quote?product=range&event=ETHTEST&low=${app.exchange.symbol(1840)}&high=${app.exchange.symbol(1800)}&stake=10`);
    assert.equal(backwards.status, 400);
    assert.equal(backwards.json.code, 'not_a_range');

    const noStake = await app.call('GET', `/quote?product=range&event=ETHTEST&low=${app.exchange.symbol(1800)}&high=${app.exchange.symbol(1840)}`);
    assert.equal(noStake.json.stake, null);

    const unknown = await app.call('GET', `/quote?product=swap&event=ETHTEST&low=a&high=b`);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.code, 'invalid_product');
  } finally {
    await app.close();
  }
});

test('GET /quote: a range on a wide book is not offered and says why', async () => {
  const app = await start(WIDE);
  try {
    const res = await app.call('GET', `/quote?product=range&event=ETHTEST&low=${app.exchange.symbol(1800)}&high=${app.exchange.symbol(1820)}&stake=10`);
    assert.equal(res.json.quote.offerable, false);
    assert.ok(res.json.quote.reasons.some((r: { code: string }) => r.code === 'markup_too_high'));
  } finally {
    await app.close();
  }
});

test('POST /bets: a falling parlay and a range are placed, listed with their product, and reconcile to the cent', async () => {
  const app = await start(LADDER);
  try {
    const down = await app.call('POST', '/bets', app.betBody({ condition: app.exchange.symbol(1840), target: app.exchange.symbol(1800), direction: 'down' }));
    assert.equal(down.status, 201, JSON.stringify(down.json));
    assert.equal(down.json.bet.product, 'parlay');
    assert.equal(down.json.bet.direction, 'down');
    assert.equal(down.json.bet.status, 'open');
    assert.equal(down.json.bet.condition.strike, 1840);
    assert.equal(down.json.bet.target.strike, 1800);

    const range = await app.call('POST', '/bets', {
      product: 'range',
      user: 'primary',
      event: 'ETHTEST',
      low: app.exchange.symbol(1780),
      high: app.exchange.symbol(1820),
      stake: 14,
      slippageTicks: 0,
    });
    assert.equal(range.status, 201, JSON.stringify(range.json));
    assert.equal(range.json.bet.product, 'range');
    assert.equal(range.json.bet.status, 'open');
    assert.equal(range.json.bet.payoffs.hedged, true);
    assert.ok(range.json.bet.payoffs.ifInRange > 0 && range.json.bet.payoffs.ifOutside < 0);

    const listed = await app.call('GET', '/bets');
    assert.equal(listed.json.count, 2);
    assert.deepEqual(listed.json.bets.map((b: { product: string }) => b.product).sort(), ['parlay', 'range']);

    const rec = await app.call('GET', '/reconcile');
    assert.equal(rec.json.ok, true, JSON.stringify(rec.json.mismatches));
    const flow = await app.call('GET', '/flow');
    assert.equal(flow.json.bets, 2);
    assert.equal(flow.json.ordersSent, 4);
  } finally {
    await app.close();
  }
});

test('POST /bets: a range that is poor value is refused with the offer rule\'s numbers, and no order is sent', async () => {
  const app = await start(WIDE);
  try {
    const res = await app.call('POST', '/bets', { product: 'range', user: 'primary', event: 'ETHTEST', low: app.exchange.symbol(1800), high: app.exchange.symbol(1820), stake: 10 });
    assert.equal(res.status, 422);
    assert.equal(res.json.code, 'offer_refused');
    assert.equal(res.json.refused, true);
    assert.ok(res.json.quote.reasons.length > 0);
    assert.equal(app.exchange.sent.length, 0);

    const flipped = await app.call('POST', '/bets', { product: 'range', user: 'primary', event: 'ETHTEST', low: app.exchange.symbol(1820), high: app.exchange.symbol(1800), stake: 10 });
    assert.equal(flipped.status, 400);
    assert.equal(flipped.json.code, 'not_a_range');
  } finally {
    await app.close();
  }
});

const leg = (app: Awaited<ReturnType<typeof start>>, extra: object) => ({ event: 'ETHTEST', stake: 10, ...extra });

test('POST /baskets: places every leg, tags each bet with the basket, and the whole thing reconciles and settles', async () => {
  const app = await start(LADDER);
  try {
    const res = await app.call('POST', '/baskets', {
      user: 'primary',
      name: 'Ether chops',
      legs: [
        leg(app, { condition: app.exchange.symbol(1800), target: app.exchange.symbol(1840) }),
        leg(app, { condition: app.exchange.symbol(1840), target: app.exchange.symbol(1800), direction: 'down' }),
        leg(app, { product: 'range', low: app.exchange.symbol(1800), high: app.exchange.symbol(1840), stake: 14.2 }),
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.basket.size, 3);
    assert.equal(res.json.basket.name, 'Ether chops');
    assert.equal(res.json.basket.failed, null);
    assert.equal(res.json.bets.length, 3);
    assert.ok(res.json.bets.every((b: { basket: { id: string; size: number }; status: string }) => b.basket.id === res.json.basket.id && b.basket.size === 3 && b.status === 'open'));
    assert.deepEqual(res.json.bets.map((b: { product: string; direction?: string }) => `${b.product}${b.direction ? `-${b.direction}` : ''}`), ['parlay', 'parlay-down', 'range']);

    const listed = await app.call('GET', '/bets');
    assert.equal(listed.json.count, 3);
    assert.equal(listed.json.bets.filter((b: { basket?: { id: string } }) => b.basket?.id === res.json.basket.id).length, 3);

    assert.equal((await app.call('GET', '/reconcile')).json.ok, true);

    // the price lands inside the range, between 1800 and 1840: each product pays its own way
    app.exchange.resolve(1840, 'no');
    app.exchange.resolve(1800, 'yes');
    const settled = await app.call('POST', '/settle');
    assert.equal(settled.json.settled.length, 3);
    const byProduct = Object.fromEntries(settled.json.settled.map((b: { id: string; product: string; direction?: string; settlement: { targetResolved: string; conditionResolved: string } }) => [`${b.product}${b.direction ? `-${b.direction}` : ''}`, b.settlement]));
    assert.deepEqual(byProduct['parlay'], { ...byProduct['parlay'], conditionResolved: 'yes', targetResolved: 'no' }); // it held 1800 but missed 1840
    assert.equal(byProduct['parlay-down'].conditionResolved, 'yes'); // it stayed below 1840 ...
    assert.equal(byProduct['parlay-down'].targetResolved, 'no'); //   ... and did not fall below 1800
    assert.equal(byProduct['range'].targetResolved, 'yes'); // inside the range
    assert.equal((await app.call('GET', '/reconcile')).json.ok, true);
  } finally {
    await app.close();
  }
});

test('POST /baskets: a leg that is not offered refuses the whole basket before anything is bought, naming the leg', async () => {
  const app = await start(WIDE);
  try {
    const res = await app.call('POST', '/baskets', {
      user: 'primary',
      legs: [leg(app, { condition: app.exchange.symbol(1800), target: app.exchange.symbol(1820) }), leg(app, { product: 'range', low: app.exchange.symbol(1800), high: app.exchange.symbol(1820) })],
    });
    assert.equal(res.status, 422);
    assert.equal(res.json.code, 'offer_refused');
    assert.equal(res.json.leg, 0);
    assert.match(res.json.error, /^Leg 1:/);
    assert.equal(app.exchange.sent.length, 0);
    assert.equal((await app.call('GET', '/bets')).json.count, 0);
  } finally {
    await app.close();
  }
});

test('POST /baskets: bad requests are named leg by leg', async () => {
  const app = await start(LADDER);
  try {
    const one = await app.call('POST', '/baskets', { user: 'primary', legs: [leg(app, { condition: app.exchange.symbol(1800), target: app.exchange.symbol(1840) })] });
    assert.equal(one.status, 400);
    assert.equal(one.json.code, 'invalid_legs');

    const missing = await app.call('POST', '/baskets', {
      user: 'primary',
      legs: [leg(app, { condition: app.exchange.symbol(1800), target: app.exchange.symbol(1840) }), leg(app, { product: 'range', low: app.exchange.symbol(1800) })],
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error, 'Leg 2: "high" is required.');

    const stake = await app.call('POST', '/baskets', {
      user: 'primary',
      legs: [leg(app, { condition: app.exchange.symbol(1800), target: app.exchange.symbol(1840) }), leg(app, { condition: app.exchange.symbol(1800), target: app.exchange.symbol(1840), stake: -1 })],
    });
    assert.equal(stake.status, 400);
    assert.match(stake.json.error, /^Leg 2: /);

    const notPair = await app.call('POST', '/baskets', {
      user: 'primary',
      legs: [leg(app, { condition: app.exchange.symbol(1800), target: app.exchange.symbol(1840) }), leg(app, { condition: app.exchange.symbol(1840), target: app.exchange.symbol(1800) })],
    });
    assert.equal(notPair.status, 422);
    assert.equal(notPair.json.code, 'not_a_linked_pair');
    assert.equal(notPair.json.leg, 1);
    assert.equal(app.exchange.sent.length, 0);

    const unknownUser = await app.call('POST', '/baskets', { user: 'nobody', legs: [] });
    assert.equal(unknownUser.status, 404);
  } finally {
    await app.close();
  }
});
