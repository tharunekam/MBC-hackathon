import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApi } from '../src/api.ts';
import { Ledger } from '../src/ledger.ts';
import { reconcile } from '../src/reconcile.ts';
import { FakeExchange } from './fake.ts';

const near = (actual: number, expected: number, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);

/** Offerable as it stands: fair 0.50, 4.1 cents over at production fees. */
const TIGHT = [
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.4, ask: 0.41 },
];
/** The sandbox's bot book: about 18 cents over fair. */
const WIDE = [
  { strike: 1800, bid: 0.83, ask: 0.97 },
  { strike: 1820, bid: 0.35, ask: 0.54 },
];

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Runs the real HTTP handler on a spare local port, backed by the in-memory exchange. */
async function start(strikes: ConstructorParameters<typeof FakeExchange>[1], opts: { waiveMarkup?: boolean; seeded?: boolean } = {}) {
  const exchange = new FakeExchange('ETHTEST', strikes);
  const other = new FakeExchange('ETHTEST', strikes); // a second user's account
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-api-')), 'ledger.json'));
  let clock = new Date('2026-11-17T23:10:00Z');
  let n = 0;
  let sessionsOpened = 0;
  const sessions = new Map<string, FakeExchange>();
  const api = createApi({
    ledger,
    users: ['primary', 'alice'],
    exchangeFor: (user) => {
      if (!sessions.has(user)) {
        sessionsOpened++;
        sessions.set(user, user === 'primary' ? exchange : other);
      }
      return sessions.get(user)!;
    },
    isConnected: (user) => sessions.has(user),
    markets: { listEvents: () => exchange.listEvents(), getEvent: (t) => exchange.getEvent(t) },
    isSandbox: true,
    feeCoef: 0,
    waiveMarkup: opts.waiveMarkup ?? false,
    seeded: opts.seeded,
    marketsCacheMs: 0,
    now: () => clock,
    newId: () => `api${++n}`,
  });
  const server = createServer(api);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : null) as Json };
  };
  const betBody = (extra: object = {}) => ({
    user: 'primary',
    event: 'ETHTEST',
    condition: exchange.symbol(1800),
    target: exchange.symbol(1820),
    stake: 10,
    slippageTicks: 0,
    ...extra,
  });
  return {
    exchange,
    other,
    ledger,
    call,
    betBody,
    setClock: (iso: string) => (clock = new Date(iso)),
    sessionsOpened: () => sessionsOpened,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

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

    // $2 fits inside the 5 contracts on offer: 3.80 YES at 0.42 = 1.596, hedge 1.995 -> 2.00 NO at 0.20 = 0.40
    const small = (await app.call('GET', `${q}&stake=2`)).json;
    assert.equal(small.stake.reduced, false);
    assert.equal(small.stake.outcomeContracts, 3.8);
    assert.equal(small.stake.hedgeContracts, 2);
    assert.equal(small.stake.cost, 2);
    near(small.stake.ifBothHit, 3.8 - 1.996);
    assert.ok(small.stake.ifConditionFails >= 0 && small.stake.ifConditionFails < 0.01);
    // most that fits: 5 YES = 2.10, hedge 2.625 -> 2.63 NO = 0.526 -> 2.63 total
    assert.deepEqual(small.depth, { outcomeAvailable: 5, conditionAvailable: 1000, maxStake: 2.63 });

    const big = (await app.call('GET', `${q}&stake=100`)).json;
    assert.equal(big.stake.reduced, true);
    assert.equal(big.stake.outcomeContracts, 5);
    assert.equal(big.stake.cost, 2.63);

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
