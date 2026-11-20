import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcile } from '../src/reconcile.ts';
import { FakeExchange } from './fake.ts';
import { TIGHT, WIDE, near, start } from './api-harness.ts';
import type { Json } from './api-harness.ts';

test('GET /health: says when our own seeder is quoting on the sandbox, and does not say so otherwise', async () => {
  const plain = await start(TIGHT);
  const seeded = await start(TIGHT, { seeded: true });
  try {
    assert.equal((await plain.call('GET', '/health')).json.seeded, false);
    assert.equal((await seeded.call('GET', '/health')).json.seeded, true);
  } finally {
    await plain.close();
    await seeded.close();
  }
});

test('GET /health: says what it is talking to and never includes a key', async () => {
  const app = await start(TIGHT);
  try {
    const { status, json } = await app.call('GET', '/health');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.venue, 'Gemini sandbox');
    assert.equal(json.sandbox, true);
    assert.deepEqual(json.users.map((u: Json) => u.user), ['primary', 'alice']);
    assert.equal(json.offerRule.refuseMarkupDollars, 0.08);
    assert.equal(json.offerRule.refuseMarkupFraction, 0.2);
    assert.equal(json.offerRule.markupWaivedForSandboxDemo, false);
    assert.doesNotMatch(JSON.stringify(json), /secret|apiKey/i);
  } finally {
    await app.close();
  }
});

test('GET /markets: offerable pairs with their quotes; refused pairs counted with reasons', async () => {
  const good = await start(TIGHT);
  try {
    const { status, json } = await good.call('GET', '/markets');
    assert.equal(status, 200);
    assert.deepEqual(json.totals, { events: 1, eventsWithOffers: 1, offerable: 1, refused: 0 });
    const event = json.events[0];
    assert.equal(event.ticker, 'ETHTEST');
    assert.equal(event.rungs.length, 2);
    const pair = event.pairs[0];
    assert.equal(pair.condition.symbol, good.exchange.symbol(1800));
    assert.equal(pair.target.symbol, good.exchange.symbol(1820));
    assert.equal(pair.quote.verdict, 'ok');
    near(pair.quote.chanceBothHappen, 0.405);
    near(pair.quote.fairPrice, 0.5);
    near(pair.quote.pricePaid, 0.5125);
    assert.ok(pair.quote.markup > 0.04 && pair.quote.markup < 0.05);
    assert.equal(typeof pair.quote.cashOutPer100, 'number');
  } finally {
    await good.close();
  }

  const wide = await start(WIDE);
  try {
    const plain = (await wide.call('GET', '/markets')).json;
    assert.deepEqual(plain.totals, { events: 1, eventsWithOffers: 0, offerable: 0, refused: 1 });
    assert.deepEqual(plain.events[0].pairs, []); // nothing is offered...
    assert.deepEqual(plain.events[0].refusedByReason, { markup_too_high: 1 }); // ...and the page can say why
    const all = (await wide.call('GET', '/markets?include=refused')).json;
    assert.equal(all.events[0].pairs[0].quote.verdict, 'refuse');
    assert.equal(all.events[0].pairs[0].quote.offerable, false);
    assert.match(all.events[0].pairs[0].quote.reasons[0].message, /more than the fair price/);
  } finally {
    await wide.close();
  }

  const demo = await start(WIDE, { waiveMarkup: true });
  try {
    const { json } = await demo.call('GET', '/markets?event=ETHTEST');
    assert.equal(json.offerRule.markupWaivedForSandboxDemo, true);
    assert.equal(json.totals.offerable, 1);
    assert.equal(json.events[0].pairs[0].quote.verdict, 'refuse'); // still labelled honestly
    assert.equal(json.events[0].pairs[0].quote.overridden, true);
  } finally {
    await demo.close();
  }
});

test('GET /quote: the five numbers, the plan for a stake, and the depth limit', async () => {
  const app = await start([
    { strike: 1800, bid: 0.8, ask: 0.84 },
    { strike: 1820, bid: 0.4, ask: 0.42, askSize: 5 },
  ]);
  try {
    const q = `/quote?event=ETHTEST&condition=${app.exchange.symbol(1800)}&target=${app.exchange.symbol(1820)}`;
    const bare = (await app.call('GET', q)).json;
    near(bare.quote.chanceBothHappen, 0.41);
    near(bare.quote.fairPrice, 0.5);
    near(bare.quote.pricePaid, 0.525);
    near(bare.quote.allInPrice, 0.554072, 1e-6);
    near(bare.quote.markup, 0.054072, 1e-6);
    assert.equal(bare.quote.cashOutPer100, 92.19);
    assert.equal(bare.quote.verdict, 'warn');
    assert.equal(bare.stake, null);

    // $2 fits inside the 5 contracts on offer: 3.78 YES at 0.42 = 1.5876. The refund order is sized to cover that even if
    // it fills two cents past the best price (1.5876 / 0.78 -> 2.04 NO), and is counted at the price it should fill at
    // (2.04 at 0.20 = 0.408), so the plan is the bet that will be placed and never costs more than the $2 asked for.
    const small = (await app.call('GET', `${q}&stake=2`)).json;
    assert.equal(small.stake.reduced, false);
    assert.equal(small.stake.outcomeContracts, 3.78);
    assert.equal(small.stake.hedgeContracts, 2.04);
    assert.equal(small.stake.cost, 2);
    assert.ok(small.stake.cost <= 2);
    near(small.stake.ifBothHit, 3.78 - 1.9956);
    // The refund is the stake and a few cents more (the contracts bought for the worse price that did not come), never less.
    assert.ok(small.stake.ifConditionFails >= 0 && small.stake.ifConditionFails < 0.06);
    // most that fits: 5 YES = 2.10, refund sized two cents past the best price 2.10 / 0.78 -> 2.70 NO at 0.20 = 0.54 -> 2.64 total
    assert.deepEqual(small.depth, { outcomeAvailable: 5, conditionAvailable: 1000, maxStake: 2.64 });

    const big = (await app.call('GET', `${q}&stake=100`)).json;
    assert.equal(big.stake.reduced, true);
    assert.equal(big.stake.outcomeContracts, 5);
    assert.equal(big.stake.cost, 2.64);

    assert.equal((await app.call('GET', '/quote?event=ETHTEST')).status, 400);
    assert.equal((await app.call('GET', `${q}&stake=-1`)).status, 400);
    assert.equal((await app.call('GET', q.replace('ETHTEST', 'NOPE'))).status, 404);
    const swapped = await app.call('GET', `/quote?event=ETHTEST&condition=${app.exchange.symbol(1820)}&target=${app.exchange.symbol(1800)}`);
    assert.equal(swapped.status, 400);
    assert.equal(swapped.json.code, 'not_a_linked_pair');
  } finally {
    await app.close();
  }
});

test('POST /bets then GET /bets and GET /flow: a bet placed over HTTP shows up, to the cent', async () => {
  const app = await start(TIGHT);
  try {
    const placed = await app.call('POST', '/bets', app.betBody());
    assert.equal(placed.status, 201);
    const bet = placed.json.bet;
    assert.equal(bet.status, 'open');
    assert.equal(bet.user, 'primary');
    assert.equal(bet.legs.length, 2);
    assert.equal(bet.legs[0].quantityFilled, 19.51); // $10 at 0.5125
    assert.equal(bet.legs[1].quantityFilled, 10); // 19.51 * 0.41 = 7.9991 -> / 0.80 = 9.9989 -> 10.00
    near(bet.cost, 9.9991);
    assert.equal(bet.offer.verdict, 'ok');
    assert.equal(bet.scorable, false); // not settled yet
    assert.equal(placed.json.stakeReduced, null);
    assert.equal(app.exchange.sent.length, 2);

    const mine = (await app.call('GET', '/bets?user=primary')).json;
    assert.equal(mine.count, 1);
    assert.equal(mine.bets[0].id, bet.id);
    assert.equal((await app.call('GET', '/bets?user=alice')).json.count, 0);
    assert.equal((await app.call('GET', '/bets')).json.count, 1);
    assert.equal((await app.call('GET', '/bets?user=mallory')).status, 404);

    const flow = (await app.call('GET', '/flow')).json;
    assert.equal(flow.bets, 1);
    assert.equal(flow.ordersSent, 2);
    assert.equal(flow.ordersFilled, 2);
    near(flow.contracts, 29.51);
    near(flow.premium, 9.9991); // 19.51 * 0.41 + 10 * 0.20
    // production fees, rounded up per order: 0.07*19.51*0.41*0.59 = 0.3304 -> 0.34; 0.07*10*0.2*0.8 = 0.112 -> 0.12
    near(flow.feesAtProductionRates, 0.46);
    assert.equal(flow.feesCharged, 0); // the sandbox charged nothing
    assert.equal(flow.productionFeeCoef, 0.07);
    assert.match(flow.note, /sandbox/);
    assert.equal((await app.call('GET', '/flow?user=alice')).json.ordersSent, 0);
    near(mine.bets[0].flow.feesAtProductionRates, 0.46);

    // the baseline was taken before the first order, so the books tie out
    const rec = await reconcile(app.exchange, app.ledger, 'primary');
    assert.equal(rec.ok, true);
    near(rec.cashDifference!, 0);
  } finally {
    await app.close();
  }
});

test('a parlay never costs more than the stake asked for, and the quote is the bet that is placed', async () => {
  // Found by placing a "$10.00" bet that came to $10.04: the refund order is sized to cover the stake even if it fills two
  // cents past the best price, and the quote had been counting it at the best price. For several stakes, on a rising and
  // a falling bet: the plan fits the stake, and the bet placed costs what the plan said, to the cent.
  const LADDER = [
    { strike: 1780, bid: 0.88, ask: 0.9 },
    { strike: 1800, bid: 0.8, ask: 0.82 },
    { strike: 1820, bid: 0.6, ask: 0.62 },
    { strike: 1840, bid: 0.4, ask: 0.42 },
  ];
  for (const stake of [1, 5, 10, 25, 37.5]) {
    for (const way of ['up', 'down'] as const) {
      const app = await start(LADDER, { waiveMarkup: true });
      try {
        const [condition, target] = way === 'up' ? [app.exchange.symbol(1800), app.exchange.symbol(1840)] : [app.exchange.symbol(1840), app.exchange.symbol(1800)];
        const dir = way === 'down' ? '&direction=down' : '';
        const quote = (await app.call('GET', `/quote?event=ETHTEST&condition=${condition}&target=${target}&stake=${stake}${dir}`)).json;
        assert.ok(quote.stake.cost <= stake + 1e-9, `${way} $${stake}: the plan costs ${quote.stake.cost}`);
        assert.ok(quote.stake.cost > stake * 0.97, `${way} $${stake}: the plan uses the stake (${quote.stake.cost})`);
        assert.ok(quote.stake.ifConditionFails >= 0, `${way} $${stake}: the refund covers the stake (${quote.stake.ifConditionFails})`);

        const placed = (await app.call('POST', '/bets', { user: 'primary', event: 'ETHTEST', condition, target, stake, ...(way === 'down' ? { direction: 'down' } : {}) })).json;
        assert.equal(placed.bet.status, 'open', JSON.stringify(placed));
        assert.ok(placed.bet.cost <= stake + 1e-9, `${way} $${stake}: the bet cost ${placed.bet.cost}`);
        near(placed.bet.cost, quote.stake.cost, 0.006);
        near(placed.bet.payoffs.ifBothHit, quote.stake.ifBothHit, 0.006);
        assert.ok(placed.bet.payoffs.ifConditionFails >= 0);
      } finally {
        await app.close();
      }
    }
  }
});

test('POST /bets: refusals are a clear 422 with the reason, and nothing is sent', async () => {
  const wide = await start(WIDE);
  try {
    const refused = await wide.call('POST', '/bets', wide.betBody());
    assert.equal(refused.status, 422);
    assert.equal(refused.json.code, 'offer_refused');
    assert.equal(refused.json.refused, true);
    assert.match(refused.json.error, /more than the fair price/);
    assert.equal(refused.json.quote.verdict, 'refuse');
    assert.equal(wide.exchange.sent.length, 0);
    assert.equal(wide.ledger.data.bets.length, 0);
  } finally {
    await wide.close();
  }

  const thin = await start([
    { strike: 1800, bid: 0.8, ask: 0.82 },
    { strike: 1820, bid: 0.4, ask: 0.41, askSize: 5 },
  ]);
  try {
    const reduced = await thin.call('POST', '/bets', thin.betBody());
    assert.equal(reduced.status, 201);
    assert.equal(reduced.json.stakeReduced.requested, 10);
    assert.equal(reduced.json.stakeReduced.reducedTo, 2.56);
    assert.equal(reduced.json.bet.legs[0].quantityFilled, 5);

    // the 5 contracts are gone now: the next bet is refused for depth, not half-filled
    const empty = await thin.call('POST', '/bets', thin.betBody());
    assert.equal(empty.status, 422);
    assert.equal(empty.json.code, 'insufficient_depth');

    thin.exchange.setBook(1820, { askSize: 100 });
    thin.exchange.setMarketState(1800, 'post_only');
    const paused = await thin.call('POST', '/bets', thin.betBody());
    assert.equal(paused.status, 422);
    assert.equal(paused.json.code, 'market_closed');
    assert.equal(thin.exchange.sent.length, 2); // only the first bet's two orders ever went out
  } finally {
    await thin.close();
  }
});

test('POST /bets: bad requests get a plain explanation', async () => {
  const app = await start(TIGHT);
  try {
    const cases: Array<[unknown, number, string]> = [
      [app.betBody({ user: 'mallory' }), 404, 'unknown_user'],
      [app.betBody({ user: undefined }), 400, 'missing_user'],
      [app.betBody({ stake: 0 }), 400, 'invalid_stake'],
      [app.betBody({ stake: 'lots' }), 400, 'invalid_stake'],
      [app.betBody({ event: '' }), 400, 'missing_field'],
      [app.betBody({ event: 'NOPE' }), 404, 'unknown_event'],
      [app.betBody({ maxPrice: 2 }), 400, 'invalid_max_price'],
      [app.betBody({ maxPrice: 0.3 }), 422, 'price_above_limit'],
      [app.betBody({ condition: app.exchange.symbol(1820), target: app.exchange.symbol(1800) }), 400, 'not_a_linked_pair'],
      ['{not json', 400, 'invalid_json'],
      ['[1,2]', 400, 'invalid_json'],
    ];
    for (const [body, status, code] of cases) {
      const res = await app.call('POST', '/bets', body);
      assert.equal(res.status, status, `${code}: ${JSON.stringify(res.json)}`);
      assert.equal(res.json.code, code);
      assert.equal(typeof res.json.error, 'string');
    }
    assert.equal(app.exchange.sent.length, 0);

    assert.equal((await app.call('GET', '/nope')).status, 404);
    const wrong = await app.call('GET', '/settle');
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'POST');
  } finally {
    await app.close();
  }
});

test('POST /settle: clean results settle; an unclear one is flagged for review, never left open', async () => {
  const app = await start(TIGHT);
  try {
    const first = (await app.call('POST', '/bets', app.betBody({ stake: 4 }))).json.bet;
    const nothing = (await app.call('POST', '/settle')).json;
    assert.deepEqual([nothing.settled.length, nothing.needsReview.length, nothing.stillOpen], [0, 0, 1]);

    app.exchange.resolve(1800, 'no'); // the condition fails: money back
    app.exchange.resolve(1820, 'no');
    const done = (await app.call('POST', '/settle')).json;
    assert.equal(done.settled.length, 1);
    assert.equal(done.settled[0].id, first.id);
    assert.equal(done.settled[0].scorable, true);
    assert.ok(done.settled[0].settlement.pnl >= 0 && done.settled[0].settlement.pnl < 0.01);
    assert.equal(done.stillOpen, 0);
    assert.equal((await reconcile(app.exchange, app.ledger, 'primary')).ok, true);
  } finally {
    await app.close();
  }

  const voided = await start(TIGHT);
  try {
    const bet = (await voided.call('POST', '/bets', voided.betBody({ stake: 4 }))).json.bet;
    voided.exchange.settleUnclear(1800, { resolutionSide: null, settlementValue: '1800.00' }, 0.5);
    voided.exchange.settleUnclear(1820, { resolutionSide: null }, 0.5);
    voided.setClock('2026-11-18T00:05:00Z');
    const done = (await voided.call('POST', '/settle')).json;
    assert.equal(done.settled.length, 0);
    assert.equal(done.needsReview.length, 1);
    assert.equal(done.needsReview[0].id, bet.id);
    assert.equal(done.needsReview[0].status, 'needs_review');
    assert.equal(done.needsReview[0].scorable, false);
    assert.equal(done.stillOpen, 0);
    const listed = (await voided.call('GET', '/bets?user=primary')).json.bets[0];
    assert.equal(listed.status, 'needs_review');
    assert.equal(listed.review.condition.settlementValue, '1800.00');
  } finally {
    await voided.close();
  }
});

test('POST /review: records what Gemini paid for a bet settled without a clean result, behind an admin token', async () => {
  const off = await start(TIGHT);
  try {
    const res = await off.call('POST', '/review', { betId: 'x', payout: 1, note: 'from the account' }, { 'X-Admin-Token': 'anything' });
    assert.equal(res.status, 404, 'with no token configured the route does not exist');
    assert.equal(res.json.code, 'not_enabled');
  } finally {
    await off.close();
  }

  const app = await start(TIGHT, { adminToken: 'admin-secret' });
  try {
    const admin = { 'X-Admin-Token': 'admin-secret' };
    const open = (await app.call('POST', '/bets', app.betBody({ stake: 4 }))).json.bet;
    assert.equal((await app.call('POST', '/review', { betId: open.id, payout: 1, note: 'from the account' })).status, 401);
    assert.equal((await app.call('POST', '/review', { betId: open.id, payout: 1, note: 'from the account' }, { 'X-Admin-Token': 'admin-secreT' })).status, 401);
    assert.equal((await app.call('POST', '/review', { betId: 'nope', payout: 1, note: 'from the account' }, admin)).status, 404);
    const early = await app.call('POST', '/review', { betId: open.id, payout: 1, note: 'from the account' }, admin);
    assert.equal(early.status, 409, 'an open bet cannot be given a payout');
    assert.equal(early.json.code, 'not_in_review');

    app.exchange.settleUnclear(1800, { resolutionSide: null, settlementValue: '1800.00' }, 0.5);
    app.exchange.settleUnclear(1820, { resolutionSide: null }, 0.5);
    app.setClock('2026-11-18T00:05:00Z');
    await app.call('POST', '/settle');
    const off0 = (await app.call('GET', '/reconcile?user=primary')).json;
    assert.equal(off0.ok, false);
    assert.deepEqual(off0.betsNeedingReview, [open.id]);

    assert.equal((await app.call('POST', '/review', { betId: open.id, payout: 9999, note: 'from the account' }, admin)).status, 400);
    assert.equal((await app.call('POST', '/review', { betId: open.id, payout: 1 }, admin)).json.code, 'bad_note');
    const paid = Math.round(off0.cashDifference * 100) / 100;
    const done = await app.call('POST', '/review', { betId: open.id, payout: paid, note: 'account history: both contracts paid 0.50' }, admin);
    assert.equal(done.status, 200);
    assert.equal(done.json.status, 'needs_review');
    assert.equal(done.json.scorable, false);
    assert.equal(done.json.review.resolved.payout, paid);

    const after = (await app.call('GET', '/reconcile?user=primary')).json;
    assert.equal(after.ok, true, `still off by ${after.cashDifference}`);
    assert.deepEqual(after.betsNeedingReview, []);
    assert.deepEqual(after.betsResolvedByHand, [open.id]);
    assert.equal((await app.call('GET', '/bets?user=primary')).json.bets[0].review.resolved.payout, paid);
  } finally {
    await app.close();
  }
});

test('one exchange session per user, reused across requests; simultaneous bets do not collide', async () => {
  const app = await start(TIGHT);
  try {
    const [a, b, c] = await Promise.all([
      app.call('POST', '/bets', app.betBody({ stake: 2 })),
      app.call('POST', '/bets', app.betBody({ stake: 2 })),
      app.call('POST', '/bets', app.betBody({ stake: 2, user: 'alice' })),
    ]);
    assert.deepEqual([a.status, b.status, c.status], [201, 201, 201]);
    assert.equal(new Set([a.json.bet.id, b.json.bet.id, c.json.bet.id]).size, 3);
    await app.call('GET', `/quote?event=ETHTEST&condition=${app.exchange.symbol(1800)}&target=${app.exchange.symbol(1820)}&stake=2`);
    await app.call('POST', '/settle');
    assert.equal(app.sessionsOpened(), 2); // primary and alice: one each, however many requests
    assert.equal(app.exchange.sent.length, 4); // primary's two bets went to primary's account
    assert.equal(app.other.sent.length, 2); // alice's went to hers
    assert.equal((await reconcile(app.exchange, app.ledger, 'primary')).ok, true);
    assert.equal((await reconcile(app.other, app.ledger, 'alice')).ok, true);
  } finally {
    await app.close();
  }
});

test('CORS: a local frontend is allowed, another website is refused before anything happens', async () => {
  const app = await start(TIGHT);
  try {
    const pre = await app.call('OPTIONS', '/bets', undefined, {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.match(pre.headers.get('access-control-allow-methods')!, /POST/);
    assert.match(pre.headers.get('access-control-allow-headers')!, /Content-Type/i);

    const ok = await app.call('GET', '/health', undefined, { Origin: 'http://127.0.0.1:3000' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3000');

    const evil = await app.call('POST', '/bets', app.betBody(), { Origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal(evil.json.code, 'origin_not_allowed');
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    assert.equal(app.exchange.sent.length, 0);
    assert.equal((await app.call('GET', '/health', undefined, { Origin: 'http://localhost.evil.example' })).status, 403);
  } finally {
    await app.close();
  }
});
