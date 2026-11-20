/**
 * What the REAL exchange client says when an order did not go through, and what the bet does with it, against the local
 * Gemini stand-in: a refusal (a 4xx answer) and an unreachable socket mean "no order exists"; a 5xx answer, a socket that
 * closes unanswered and an order that was accepted but whose record never turns up mean "nobody knows", and the bet must
 * not guess.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { placeConditionalBet, recoverBets, UNKNOWN_NOTE } from '../src/bets.ts';
import type { Config } from '../src/config.ts';
import { GeminiExchange, OrderNotSent, OrderUnconfirmed } from '../src/exchange.ts';
import { GeminiRefused, GeminiWs } from '../src/gemini/ws.ts';
import { Ledger } from '../src/ledger.ts';
import { FakeExchange } from './fake.ts';
import { startFakeGemini } from './fake-gemini.ts';

const KEY = 'order-errors-key';
const SECRET = 'test-secret-not-a-real-one';
const creds = { user: 'primary', apiKey: KEY, apiSecret: SECRET };
const SYM_LOW = 'GEMI-WIREE-HI100';
const SYM_HIGH = 'GEMI-WIREE-HI110';
const order = (tag: string, symbol = SYM_LOW) => ({ symbol, side: 'buy' as const, outcome: 'yes' as const, limitPrice: 0.82, quantity: 2, tif: 'IOC' as const, clientOrderId: tag });

let gem: Awaited<ReturnType<typeof startFakeGemini>>;
let exchange: GeminiExchange;
const config = (): Config => ({ baseUrl: gem.baseUrl, wsUrl: gem.wsUrl }) as Config;

before(async () => {
  const fake = new FakeExchange('WIREE', [
    { strike: 100, bid: 0.8, ask: 0.82 },
    { strike: 110, bid: 0.4, ask: 0.42 },
  ]);
  gem = await startFakeGemini({
    apiKey: KEY,
    apiSecret: SECRET,
    events: [await fake.getEvent('WIREE')],
    books: new Map([
      [SYM_LOW, { bid: 0.8, bidSize: 500, ask: 0.82, askSize: 500 }],
      [SYM_HIGH, { bid: 0.4, bidSize: 500, ask: 0.42, askSize: 500 }],
    ]),
    cash: 1000,
  });
  exchange = new GeminiExchange(config(), creds);
});
after(async () => {
  exchange.close();
  await gem.close();
});

describe('what placeOrder throws', () => {
  it('a refusal from Gemini is "not sent", with Gemini\'s reason intact', async () => {
    gem.state.rejectNext = 'market is closed';
    await assert.rejects(exchange.placeOrder(order('wire-e-rej')), (err: unknown) => err instanceof OrderNotSent && /Gemini rejected the request.*market is closed/.test(err.message));
    assert.equal(gem.orders.filter((o) => o.clientOrderId === 'wire-e-rej').length, 0);
  });

  it('a session that cannot be opened is "not sent": nothing left this side', async () => {
    const unreachable = new GeminiExchange({ baseUrl: gem.baseUrl, wsUrl: 'ws://127.0.0.1:1' } as Config, creds);
    try {
      await assert.rejects(unreachable.placeOrder(order('wire-e-down')), (err: unknown) => err instanceof OrderNotSent);
    } finally {
      unreachable.close();
    }
  });

  it('an order that has just been placed is found by its tag among the newest orders only', async () => {
    gem.seedHistory(120); // an account with a long history: reading all of it takes three pages
    const done = await exchange.placeOrder(order('wire-e-recent'));
    assert.equal(done.filledQuantity, 2);
    const historyReads = () => gem.state.requests.filter((r) => r.endsWith('/orders/history')).length;
    const before = historyReads();
    const found = await exchange.findOrder('wire-e-recent', { recent: true });
    assert.equal(found?.filledQuantity, 2);
    assert.equal(await exchange.findOrder('wire-e-nothing', { recent: true }), null);
    assert.equal(historyReads() - before, 2, 'one small page each, never the whole history');
    assert.equal((await exchange.findOrder('wire-e-recent'))?.filledQuantity, 2);
    assert.ok(historyReads() - before >= 5, 'without the hint it reads every page');
  });

  it('an order Gemini accepted but whose record never appears is "unconfirmed", and the bet holds still rather than send anything else', async () => {
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-wire-errors-')), 'ledger.json'));
    const deps = { exchange, ledger, newId: () => 'e1', now: () => new Date('2026-11-17T23:10:00Z'), waiveMarkup: false, lookupWaitsMs: [0, 0, 0] };
    let thrown: unknown;
    const real = exchange.placeOrder.bind(exchange);
    exchange.placeOrder = async (req) => {
      try {
        return await real(req);
      } catch (err) {
        thrown = err;
        throw err;
      }
    };
    gem.state.hideOrders = true; // accepted, filled, and invisible to every look-up
    const bet = await placeConditionalBet(deps, { user: 'primary', eventTicker: 'WIREE', conditionSymbol: SYM_LOW, targetSymbol: SYM_HIGH, stake: 10, slippageTicks: 0 });
    gem.state.hideOrders = false;
    exchange.placeOrder = real;
    assert.ok(thrown instanceof OrderUnconfirmed, 'the client says "accepted, not confirmed", not "not sent"');

    assert.equal(bet.status, 'unhedged', 'not "failed": the account holds the first order');
    assert.equal(bet.note, UNKNOWN_NOTE);
    assert.equal(bet.legs.length, 1, 'no second order was sent');
    assert.equal(bet.legs[0]!.status, 'unknown');
    assert.match(bet.legs[0]!.note ?? '', /accepted by Gemini .* but its record did not appear/);
    assert.equal(gem.orders.filter((o) => o.clientOrderId === 'gv-e1-b').length, 1);

    // Once the order list shows it, the order is found by its tag and recorded; it is still the only one.
    assert.equal(await recoverBets(deps), 1);
    assert.equal(bet.legs[0]!.status, 'filled');
    assert.ok(bet.legs[0]!.quantityFilled > 0);
    assert.equal(gem.orders.filter((o) => o.clientOrderId === 'gv-e1-b').length, 1, 'never sent twice');
  });
});

describe('an answer that is not a clear refusal is a lost answer', () => {
  const orderReads = () => gem.state.requests.filter((r) => r.includes('/orders/')).length;
  const betOn = (id: string) => {
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-wire-status-')), 'ledger.json'));
    const deps = { exchange, ledger, newId: () => id, now: () => new Date('2026-11-17T23:10:00Z'), waiveMarkup: false, lookupWaitsMs: [0, 0, 0] };
    return placeConditionalBet(deps, { user: 'primary', eventTicker: 'WIREE', conditionSymbol: SYM_LOW, targetSymbol: SYM_HIGH, stake: 10, slippageTicks: 0 });
  };
  const tagged = (tag: string) => gem.orders.filter((o) => o.clientOrderId === tag).length;

  for (const status of [400, 429, 499]) {
    it(`a ${status} answer is a refusal: "not sent", and the order is not looked for`, async () => {
      gem.state.failStatusNext = { status, ran: false };
      const before = orderReads();
      await assert.rejects(exchange.placeOrder(order(`wire-s-${status}`)), (err: unknown) => err instanceof OrderNotSent && /Gemini rejected the request/.test(err.message));
      assert.equal(orderReads(), before, 'a refusal is final: nothing was asked of the order list');
      assert.equal(tagged(`wire-s-${status}`), 0);
    });
  }

  for (const status of [300, 399, 500, 502, 503, 504, 600]) {
    it(`a ${status} answer is NOT a refusal: the error is plain, so the order gets looked up`, async () => {
      gem.state.failStatusNext = { status, ran: true };
      await assert.rejects(
        exchange.placeOrder(order(`wire-s-${status}`)),
        (err: unknown) => err instanceof Error && !(err instanceof OrderNotSent) && !(err instanceof OrderUnconfirmed) && !(err instanceof GeminiRefused) && err.message.includes(`status ${status}`),
      );
      assert.equal(tagged(`wire-s-${status}`), 1, 'the order did run; only the answer was bad');
    });
  }

  it('a bet whose first order was answered 500 after it filled is open, not failed; the order was sent once', async () => {
    gem.state.failStatusNext = { status: 500, ran: true };
    const bet = await betOn('s1');
    assert.equal(bet.status, 'open');
    assert.deepEqual(bet.legs.map((l) => l.status), ['filled', 'filled']);
    assert.match(bet.legs[0]!.note ?? '', /status 500.*found on the exchange by its tag/);
    assert.equal(tagged('gv-s1-b'), 1);
    assert.equal(tagged('gv-s1-a1'), 1, 'the hedge is sent once as well');
  });

  it('a bet whose hedge was answered 503 after it filled is not hedged a second time', async () => {
    const real = exchange.placeOrder.bind(exchange);
    exchange.placeOrder = async (req) => {
      if (req.clientOrderId === 'gv-s2-a1') gem.state.failStatusNext = { status: 503, ran: true };
      return real(req);
    };
    try {
      const bet = await betOn('s2');
      assert.equal(bet.status, 'open');
      assert.equal(tagged('gv-s2-a1'), 1);
      assert.equal(tagged('gv-s2-a2'), 0, 'no second hedge: the first one is on the account');
    } finally {
      exchange.placeOrder = real;
    }
  });

  it('a bet whose first order was answered 502 and never ran fails after the exchange has twice said it has no such order', async () => {
    gem.state.failStatusNext = { status: 502, ran: false };
    const before = orderReads();
    const bet = await betOn('s3');
    assert.equal(bet.status, 'failed');
    assert.equal(bet.legs[0]!.status, 'error');
    assert.equal(tagged('gv-s3-b'), 0);
    assert.ok(orderReads() > before, 'the exchange was asked about the order');
  });

  it('a socket that closes before any answer is a lost answer, not "not sent": the filled order is found by its tag', async () => {
    gem.state.dropBeforeAck = true;
    await assert.rejects(exchange.placeOrder(order('wire-s-drop')), (err: unknown) => err instanceof Error && !(err instanceof OrderNotSent) && !(err instanceof OrderUnconfirmed));
    gem.state.dropBeforeAck = true;
    const bet = await betOn('s4');
    assert.equal(bet.status, 'open');
    assert.match(bet.legs[0]!.note ?? '', /closed before a reply arrived.*found on the exchange by its tag/);
    assert.equal(tagged('gv-s4-b'), 1);
  });

  it('a request on a socket that is not open is refused at once: nothing left this side', async () => {
    const ws = new GeminiWs(creds, 'ws://127.0.0.1:1'); // never connected
    const send = (ws as unknown as { send(method: string, params: unknown): Promise<unknown> }).send.bind(ws);
    await assert.rejects(send('order.place', {}), (err: unknown) => err instanceof GeminiRefused && /not open/.test(err.message));
  });
});
