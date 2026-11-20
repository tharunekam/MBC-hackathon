/**
 * The bounded wait for a bet's second order (src/second-leg-wait.ts, GIVEN_SECOND_LEG_WAIT_MS, off by default).
 *
 * Every scenario starts the same way as the bet that lost $1.55 on the sandbox: the first order fills, and only then does
 * the second order's contract stop taking orders. What happens next is checked for all four bets the service places.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApi } from '../src/api.ts';
import { placeConditionalBet } from '../src/bets.ts';
import type { Deps } from '../src/bets.ts';
import { placeBreakoutBet } from '../src/breakout-bet.ts';
import { loadConfig } from '../src/config.ts';
import type { GeminiContract } from '../src/gemini/types.ts';
import { Ledger } from '../src/ledger.ts';
import type { BetRecord } from '../src/ledger.ts';
import { placeRangeBet } from '../src/range-bet.ts';
import { ensureBaseline, reconcile } from '../src/reconcile.ts';
import { MAX_SECOND_LEG_WAIT_MS, SECOND_LEG_POLL_MS, clampSecondLegWaitMs, isTemporarilyClosed } from '../src/second-leg-wait.ts';
import { FakeExchange } from './fake.ts';

/** The tight four-strike ladder the product tests use: every bet below passes the offer rule as it stands. */
const LADDER = [
  { strike: 1780, bid: 0.88, ask: 0.9 },
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.6, ask: 0.62 },
  { strike: 1840, bid: 0.4, ask: 0.42 },
];

type OnFail = 'unwind' | 'leave';

/** One of each bet. `second` is the strike the SECOND order is sent on: the contract the wait is about. */
const KINDS: Array<{ name: string; second: number; place: (deps: Deps, ex: FakeExchange, onFail?: OnFail) => Promise<BetRecord> }> = [
  {
    name: 'a breakout',
    second: 1800, // YES on 1840, then NO on 1800
    place: (deps, ex, onFail) => placeBreakoutBet(deps, { user: 'primary', eventTicker: 'ETHTEST', lowSymbol: ex.symbol(1800), highSymbol: ex.symbol(1840), stake: 12.4, slippageTicks: 0, onFail }),
  },
  {
    name: 'a range',
    second: 1840, // YES on 1800, then NO on 1840
    place: (deps, ex, onFail) => placeRangeBet(deps, { user: 'primary', eventTicker: 'ETHTEST', lowSymbol: ex.symbol(1800), highSymbol: ex.symbol(1840), stake: 14.2, slippageTicks: 0, onFail }),
  },
  {
    name: 'a rising parlay',
    second: 1800, // YES on 1840, then NO on 1800
    place: (deps, ex, onHedgeFail) =>
      placeConditionalBet(deps, { user: 'primary', eventTicker: 'ETHTEST', conditionSymbol: ex.symbol(1800), targetSymbol: ex.symbol(1840), stake: 10, slippageTicks: 0, onHedgeFail }),
  },
  {
    name: 'a falling parlay',
    second: 1840, // NO on 1800, then YES on 1840, both read through the mirror of the ladder
    place: (deps, ex, onHedgeFail) =>
      placeConditionalBet(deps, { user: 'primary', eventTicker: 'ETHTEST', conditionSymbol: ex.symbol(1840), targetSymbol: ex.symbol(1800), direction: 'down', stake: 10, slippageTicks: 0, onHedgeFail }),
  },
];
const BREAKOUT = KINDS[0]!;

const SOLD_BACK = 'The second order could not be completed within the price limit, so the position was sold back.';

/** Runs `then` once the bet's first order has filled: the moment the sandbox's ladder flipped. */
function afterFirstOrder(exchange: FakeExchange, then: () => void): void {
  const place = exchange.placeOrder.bind(exchange);
  exchange.placeOrder = async (req) => {
    const result = await place(req);
    if (req.clientOrderId.endsWith('-b')) then();
    return result;
  };
}

interface Scenario {
  /** GIVEN_SECOND_LEG_WAIT_MS. Left out, the Deps are the ones every caller built before the setting existed. */
  waitMs?: number;
  /** What happens to the market right after the first order fills. */
  flip?: (ex: FakeExchange) => void;
  onFail?: OnFail;
  /** Extra wiring on the exchange before the bet, for the few tests that need it. */
  prepare?: (ex: FakeExchange) => void;
}

/** Places one bet on a fresh exchange and ledger. The pauses are recorded, never really slept. */
async function run(kind: (typeof KINDS)[number], s: Scenario = {}) {
  const exchange = new FakeExchange('ETHTEST', LADDER);
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-wait-')), 'ledger.json'));
  const sleeps: number[] = [];
  let n = 0;
  const deps: Deps = {
    exchange,
    ledger,
    newId: () => `t${++n}`,
    now: () => new Date('2026-11-17T23:10:00Z'),
    waiveMarkup: false,
    ...(s.waitMs === undefined ? {} : { secondLegWaitMs: s.waitMs }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  let reads = 0;
  const readEvent = exchange.getEvent.bind(exchange);
  exchange.getEvent = async (ticker) => {
    reads++;
    return readEvent(ticker);
  };
  s.prepare?.(exchange);
  if (s.flip) afterFirstOrder(exchange, () => s.flip!(exchange));

  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await kind.place(deps, exchange, s.onFail);
  const readsForBet = reads;
  // Whatever happened, the ledger and the venue agree on every order and on the cash.
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.equal(rec.ok, true, JSON.stringify(rec));
  return { exchange, ledger, bet, sleeps, reads: readsForBet };
}

const held = (ex: FakeExchange): number => [...ex.positions.values()].filter((q) => Math.abs(q) > 1e-9).length;
const roles = (bet: BetRecord): string[] => bet.legs.map((l) => l.role);
/** The bet without the one field the wait adds, for comparing with a bet placed with the wait off. */
const withoutWait = (bet: BetRecord): BetRecord => {
  const { secondLegWait: _waited, ...rest } = bet;
  return rest;
};

// ------------------------------------------------------------------ (a) off: exactly as before

for (const kind of KINDS) {
  test(`wait off: ${kind.name} whose second contract goes post-only is sold back at once, exactly as before the setting existed`, async () => {
    const stayPostOnly = (ex: FakeExchange) => ex.setMarketState(kind.second, 'post_only');
    const unset = await run(kind, { flip: stayPostOnly }); // no setting at all
    const zero = await run(kind, { waitMs: 0, flip: stayPostOnly }); // the setting at its default

    for (const r of [unset, zero]) {
      assert.equal(r.bet.status, 'unwound');
      assert.equal(r.bet.note, SOLD_BACK);
      assert.deepEqual(
        r.bet.legs.map((l) => [l.role, l.clientOrderId, l.status]),
        [
          ['outcome', `gv-${r.bet.id}-b`, 'filled'],
          ['unwind', `gv-${r.bet.id}-ub`, 'filled'], // no second order was ever sent
        ],
      );
      assert.equal('secondLegWait' in r.bet, false);
      assert.deepEqual(r.sleeps, []);
      assert.equal(r.reads, 4); // two before the first order, one for the second, one to sell back: none added
      assert.equal(held(r.exchange), 0);
    }
    assert.deepEqual(zero.bet, unset.bet);
    assert.deepEqual(zero.exchange.sent, unset.exchange.sent);
  });
}

// ------------------------------------------------------------------ (b) on, and it opens in time

for (const kind of KINDS) {
  test(`wait on: ${kind.name} whose second contract is post-only for a moment is placed whole once it opens, and nothing is sold back`, async () => {
    const neverClosed = await run(kind, { waitMs: 5000 });
    assert.equal(neverClosed.bet.status, 'open');
    assert.deepEqual(neverClosed.sleeps, []);
    // A market that stays open: the setting changes nothing at all.
    assert.deepEqual(neverClosed.bet, (await run(kind)).bet);

    // Post-only on the second leg's own read and on the next two; open on the third re-read.
    const waited = await run(kind, { waitMs: 5000, flip: (ex) => ex.postOnlyFor(kind.second, 3) });
    assert.equal(waited.bet.status, 'open');
    assert.equal(waited.bet.payoffs!.hedged, true);
    assert.deepEqual(roles(waited.bet), ['outcome', 'hedge']);
    assert.equal(waited.bet.note, undefined);
    assert.deepEqual(waited.sleeps, [SECOND_LEG_POLL_MS, SECOND_LEG_POLL_MS, SECOND_LEG_POLL_MS]);
    assert.deepEqual(waited.bet.secondLegWait, { waitedMs: 1500, reads: 3, opened: true });
    assert.deepEqual(new Ledger(waited.ledger.path).bet(waited.bet.id)!.secondLegWait, { waitedMs: 1500, reads: 3, opened: true }); // it is in the ledger file

    // The orders are the ones a bet that never waited sends: same tags (the wait uses up no attempt), same price limits,
    // same sizes. The record differs only by saying that it waited.
    assert.equal(waited.bet.legs[1]!.clientOrderId, `gv-${waited.bet.id}-a1`);
    assert.deepEqual(waited.exchange.sent, neverClosed.exchange.sent);
    assert.deepEqual(withoutWait(waited.bet), neverClosed.bet);
  });
}

// ------------------------------------------------------------------ (c) on, and it never opens

for (const kind of KINDS) {
  test(`wait on: ${kind.name} whose second contract never opens waits for the setting and no longer, then ends as it does today`, async () => {
    const stayPostOnly = (ex: FakeExchange) => ex.setMarketState(kind.second, 'post_only');
    for (const onFail of ['unwind', 'leave'] as const) {
      const today = await run(kind, { flip: stayPostOnly, onFail });
      const waited = await run(kind, { waitMs: 2000, flip: stayPostOnly, onFail });

      assert.deepEqual(waited.sleeps, [500, 500, 500, 500]);
      assert.equal(waited.reads, today.reads + 4);
      assert.deepEqual(waited.bet.secondLegWait, { waitedMs: 2000, reads: 4, opened: false });
      assert.equal(waited.bet.status, onFail === 'unwind' ? 'unwound' : 'unhedged');
      assert.equal(roles(waited.bet).includes('hedge'), false); // nothing was sent to a contract that was not taking orders
      assert.deepEqual(waited.exchange.sent, today.exchange.sent);
      assert.deepEqual(withoutWait(waited.bet), today.bet);
    }
  });
}

// ------------------------------------------------------------------ (d) closed for good: not waited on

for (const kind of KINDS) {
  test(`wait on: ${kind.name} whose second contract has closed for good is not waited on at all`, async () => {
    const closures: Array<[string, (ex: FakeExchange) => void]> = [
      ['active/closed', (ex) => ex.setMarketState(kind.second, 'closed')],
      ['settled/closed', (ex) => ex.setContractStatus(kind.second, 'settled')],
      ['expired/closed', (ex) => ex.setContractStatus(kind.second, 'expired')],
      ['a state never seen before', (ex) => ex.setMarketState(kind.second, 'halted')],
    ];
    for (const [state, close] of closures) {
      const today = await run(kind, { flip: close });
      const waited = await run(kind, { waitMs: 5000, flip: close });
      assert.deepEqual(waited.sleeps, [], state);
      assert.equal(waited.reads, today.reads, state);
      assert.equal(waited.bet.status, 'unwound', state);
      assert.deepEqual(waited.bet, today.bet, state); // not even a note that it might have waited
      assert.deepEqual(waited.exchange.sent, today.exchange.sent, state);
    }
  });
}

// ------------------------------------------------------------------ the edges of the wait

test('wait on: a contract that goes from post-only to closed for good stops the wait there and then', async () => {
  const waited = await run(BREAKOUT, {
    waitMs: 5000,
    flip: (ex) => {
      ex.setMarketState(1800, 'closed'); // what it really is from now on ...
      ex.postOnlyFor(1800, 2); // ... after reporting post-only twice more
    },
  });
  assert.deepEqual(waited.sleeps, [500, 500]); // 4 seconds of the wait were left; they were not spent
  assert.deepEqual(waited.bet.secondLegWait, { waitedMs: 1000, reads: 2, opened: false });
  assert.equal(waited.bet.status, 'unwound');
  assert.equal(roles(waited.bet).includes('hedge'), false);
  assert.equal(held(waited.exchange), 0);
});

test('wait on: the last pause is cut to what is left, and no setting can wait longer than 15 seconds', async () => {
  const stayPostOnly = (ex: FakeExchange) => ex.setMarketState(1800, 'post_only');

  const odd = await run(BREAKOUT, { waitMs: 1200, flip: stayPostOnly });
  assert.deepEqual(odd.sleeps, [500, 500, 200]);
  assert.deepEqual(odd.bet.secondLegWait, { waitedMs: 1200, reads: 3, opened: false });

  const huge = await run(BREAKOUT, { waitMs: 10 * 60_000, flip: stayPostOnly });
  assert.equal(huge.sleeps.length, MAX_SECOND_LEG_WAIT_MS / SECOND_LEG_POLL_MS);
  assert.equal(huge.sleeps.reduce((sum, ms) => sum + ms, 0), MAX_SECOND_LEG_WAIT_MS);
  assert.deepEqual(huge.bet.secondLegWait, { waitedMs: 15_000, reads: 30, opened: false });
  assert.equal(huge.bet.status, 'unwound');

  // A setting that is not a positive number is off.
  for (const waitMs of [-500, Number.NaN]) {
    const off = await run(BREAKOUT, { waitMs, flip: stayPostOnly });
    assert.deepEqual(off.sleeps, []);
    assert.equal('secondLegWait' in off.bet, false);
  }
});

test('wait on: the wait is one allowance for the whole bet, shared by every attempt at the second order', async () => {
  const waited = await run(BREAKOUT, {
    waitMs: 2000,
    flip: (ex) => {
      ex.postOnlyFor(1800, 2); // opens after one second ...
      ex.setBook(1800, { bidSize: 0 }); // ... with nothing left to fill the second order
    },
    prepare: (ex) => {
      const place = ex.placeOrder.bind(ex);
      ex.placeOrder = async (req) => {
        const result = await place(req);
        if (req.clientOrderId.endsWith('-a1')) ex.setMarketState(1800, 'post_only'); // and then it flips back, for good
        return result;
      };
    },
  });
  // One second before the first attempt, and only the one second that was left before the second: 2 in all, not 2 each.
  assert.deepEqual(waited.sleeps, [500, 500, 500, 500]);
  assert.deepEqual(waited.bet.secondLegWait, { waitedMs: 2000, reads: 4, opened: false });
  assert.deepEqual(
    waited.bet.legs.map((l) => [l.role, l.clientOrderId, l.status]),
    [
      ['outcome', `gv-${waited.bet.id}-b`, 'filled'],
      ['hedge', `gv-${waited.bet.id}-a1`, 'unfilled'],
      ['unwind', `gv-${waited.bet.id}-ub`, 'filled'],
    ],
  );
  assert.equal(waited.bet.status, 'unwound');
  assert.equal(held(waited.exchange), 0);
});

test('wait on: the time the re-reads themselves take counts against the wait', async () => {
  // A clock that moves: each pause takes as long as it says, and each read of the event takes a second.
  let clock = Date.parse('2026-11-17T23:10:00Z');
  const exchange = new FakeExchange('ETHTEST', LADDER);
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-wait-')), 'ledger.json'));
  const sleeps: number[] = [];
  const readEvent = exchange.getEvent.bind(exchange);
  exchange.getEvent = async (ticker) => {
    clock += 1000;
    return readEvent(ticker);
  };
  afterFirstOrder(exchange, () => exchange.setMarketState(1800, 'post_only'));
  const deps: Deps = {
    exchange,
    ledger,
    newId: () => 't1',
    now: () => new Date(clock),
    waiveMarkup: false,
    secondLegWaitMs: 3000,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  };
  const bet = await BREAKOUT.place(deps, exchange);
  assert.deepEqual(sleeps, [500, 500]); // two pauses and two one-second reads are the three seconds; six pauses would be six
  assert.deepEqual(bet.secondLegWait, { waitedMs: 3000, reads: 2, opened: false });
  assert.equal(bet.status, 'unwound');
});

test('wait on: a re-read that fails is treated as not open yet, and never leaves the bet half-way', async () => {
  /** Makes the numbered reads of the event fail, counting from the first order: read 1 is the second leg's own, the wait's follow. */
  const failReads =
    (...numbers: number[]) =>
    (ex: FakeExchange) => {
      const readEvent = ex.getEvent.bind(ex);
      let read = 0;
      ex.getEvent = async (ticker) => {
        if (ex.sent.length > 0 && numbers.includes(++read)) throw new Error('Gemini did not answer');
        return readEvent(ticker);
      };
    };

  // Every re-read fails: the wait runs out and the bet is sold back, as it would have been with no wait.
  const dark = await run(BREAKOUT, { waitMs: 1000, prepare: failReads(2, 3), flip: (ex) => ex.setMarketState(1800, 'post_only') });
  assert.deepEqual(dark.sleeps, [500, 500]);
  assert.deepEqual(dark.bet.secondLegWait, { waitedMs: 1000, reads: 2, opened: false });
  assert.equal(dark.bet.status, 'unwound');
  assert.equal(dark.bet.note, SOLD_BACK);
  assert.equal(held(dark.exchange), 0);

  // One re-read fails and the next finds the market open: the bet goes in.
  const blip = await run(BREAKOUT, { waitMs: 5000, prepare: failReads(2), flip: (ex) => ex.postOnlyFor(1800, 1) });
  assert.deepEqual(blip.sleeps, [500, 500]);
  assert.deepEqual(blip.bet.secondLegWait, { waitedMs: 1000, reads: 2, opened: true });
  assert.equal(blip.bet.status, 'open');
  assert.deepEqual(roles(blip.bet), ['outcome', 'hedge']);
});

// ------------------------------------------------------------------ the decision, and the setting

test('which contracts are worth waiting for: active, post-only, and without a result; nothing else', () => {
  const contract = (over: Partial<GeminiContract> = {}): GeminiContract => ({
    id: '1-1800',
    label: '$1800 or above',
    ticker: 'HI1800',
    instrumentSymbol: 'GEMI-ETHTEST-HI1800',
    status: 'active',
    marketState: 'post_only',
    strike: { type: 'above', value: '1800' },
    ...over,
  });
  assert.equal(isTemporarilyClosed(contract()), true);
  assert.equal(isTemporarilyClosed(contract({ marketState: 'POST_ONLY' })), true);
  assert.equal(isTemporarilyClosed(contract({ marketState: 'post-only' })), true);
  assert.equal(isTemporarilyClosed(contract({ resolutionSide: null, resolvedAt: null })), true);

  assert.equal(isTemporarilyClosed(undefined), false); // the contract is gone
  assert.equal(isTemporarilyClosed(null), false);
  assert.equal(isTemporarilyClosed(contract({ marketState: 'open' })), false); // nothing to wait for
  for (const marketState of ['closed', 'settled', 'expired', 'halted', 'unknown', '', undefined]) {
    assert.equal(isTemporarilyClosed(contract({ marketState })), false, `market state ${marketState}`);
  }
  for (const status of ['settled', 'closed', 'expired', 'resolved', 'approved', 'under_review', '']) {
    assert.equal(isTemporarilyClosed(contract({ status })), false, `status ${status}`); // even while it still says post-only
  }
  assert.equal(isTemporarilyClosed(contract({ resolvedAt: '2026-11-18T00:00:07.000Z' })), false);
  assert.equal(isTemporarilyClosed(contract({ resolutionSide: 'yes' })), false);
  assert.equal(isTemporarilyClosed(contract({ resolutionSide: 'no' })), false);
});

test('the setting: GIVEN_SECOND_LEG_WAIT_MS is read with the other settings, is off unless set, and is capped at 15 seconds', () => {
  // The key is always passed, set or not, so a value in a local .env can never decide this test.
  const read = (value: string | undefined) => loadConfig({ GEMINI_BASE_URL: 'https://api.sandbox.gemini.com', GIVEN_SECOND_LEG_WAIT_MS: value }).secondLegWaitMs;
  assert.equal(read(undefined), 0);
  assert.equal(read('0'), 0);
  assert.equal(read('4000'), 4000);
  assert.equal(read('15000'), 15_000);
  assert.equal(read('15001'), 15_000);
  assert.equal(read('600000'), 15_000);
  for (const junk of ['', '  ', '-1', 'soon', 'NaN', 'Infinity']) assert.equal(read(junk), 0, `"${junk}" is not a number of milliseconds, so the wait is off`);

  assert.equal(clampSecondLegWaitMs(undefined), 0);
  assert.equal(clampSecondLegWaitMs(null), 0);
  assert.equal(clampSecondLegWaitMs(true), 0);
  assert.equal(clampSecondLegWaitMs(Number.NaN), 0);
  assert.equal(clampSecondLegWaitMs(-3), 0);
  assert.equal(clampSecondLegWaitMs(2500.9), 2500);
  assert.equal(clampSecondLegWaitMs(Number.POSITIVE_INFINITY), 0);
  assert.equal(clampSecondLegWaitMs(1e9), MAX_SECOND_LEG_WAIT_MS);
});

test('over HTTP: the setting reaches the order path through the API, and the bet in the answer says that it waited', async () => {
  const serve = async (secondLegWaitMs: number | undefined) => {
    const exchange = new FakeExchange('ETHTEST', LADDER);
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-wait-api-')), 'ledger.json'));
    const sleeps: number[] = [];
    let n = 0;
    const api = createApi({
      ledger,
      users: ['primary'],
      exchangeFor: () => exchange,
      markets: { listEvents: () => exchange.listEvents(), getEvent: (t) => exchange.getEvent(t) },
      isSandbox: true,
      feeCoef: 0,
      waiveMarkup: false,
      marketsCacheMs: 0,
      now: () => new Date('2026-11-17T23:10:00Z'),
      newId: () => `api${++n}`,
      ...(secondLegWaitMs === undefined ? {} : { secondLegWaitMs }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const server = createServer(api);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    afterFirstOrder(exchange, () => exchange.postOnlyFor(1800, 2));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/bets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product: 'breakout', user: 'primary', event: 'ETHTEST', low: exchange.symbol(1800), high: exchange.symbol(1840), stake: 12.4, slippageTicks: 0 }),
      });
      return { status: res.status, bet: ((await res.json()) as { bet: BetRecord }).bet, sleeps };
    } finally {
      api.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  const off = await serve(undefined);
  assert.equal(off.status, 201);
  assert.equal(off.bet.status, 'unwound');
  assert.equal('secondLegWait' in off.bet, false);
  assert.deepEqual(off.sleeps, []);

  const on = await serve(5000);
  assert.equal(on.status, 201);
  assert.equal(on.bet.status, 'open');
  assert.deepEqual(on.bet.secondLegWait, { waitedMs: 1000, reads: 2, opened: true });
  assert.deepEqual(on.sleeps, [500, 500]);
});
