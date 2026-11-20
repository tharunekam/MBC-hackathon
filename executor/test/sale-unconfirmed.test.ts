/**
 * A cash-out whose sell order has no confirmed result. The first sell may well have gone through, so the answer must not
 * say "nothing was sold": it is 409 "sale_unconfirmed", the bet is held as unhedged with its unknown note, and nothing more
 * is sent. "nothing_sold" (422) stays for a sale the exchange has twice said it never received.
 * Everything here goes through the HTTP handler, as the app does.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNKNOWN_NOTE, holdings, recoverBets } from '../src/bets.ts';
import { SALE_UNCONFIRMED_MESSAGE } from '../src/cashout.ts';
import { cannotBeAsked, start } from './api-harness.ts';

const LADDER = [
  { strike: 1780, bid: 0.88, ask: 0.9 },
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.6, ask: 0.62 },
  { strike: 1840, bid: 0.4, ask: 0.42 },
];

const WORDS = 'Gemini did not confirm whether the sale went through. Check My bets and your Gemini account before trying again.';

async function openBet() {
  const app = await start(LADDER, { waiveMarkup: true, orderLookupWaitsMs: [0, 0, 0] });
  const placed = await app.call('POST', '/bets', app.betBody({ condition: app.exchange.symbol(1800), target: app.exchange.symbol(1820) }));
  assert.equal(placed.status, 201);
  assert.equal(placed.json.bet.status, 'open');
  return { app, id: placed.json.bet.id as string, tags: () => app.exchange.sent.map((o) => o.clientOrderId) };
}

test('the first sell fills and its answer is lost: 409 sale_unconfirmed, never "nothing sold"; the bet is held and nothing more is sent', async () => {
  const { app, id, tags } = await openBet();
  try {
    app.exchange.failAfterSend = `gv-${id}-cb1`; // the sale goes through at the exchange; the answer never arrives
    const restore = cannotBeAsked(app.exchange);
    const res = await app.call('POST', '/cashout', { bet: id });

    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'sale_unconfirmed');
    assert.equal(res.json.error, WORDS);
    assert.equal(SALE_UNCONFIRMED_MESSAGE, WORDS);
    assert.notEqual(res.json.code, 'nothing_sold', 'the sale may have gone through');
    assert.doesNotMatch(res.json.error, /unchanged|price moved|nothing was sold/i);

    const bet = app.ledger.bet(id)!;
    assert.equal(bet.status, 'unhedged');
    assert.equal(bet.note, UNKNOWN_NOTE);
    assert.deepEqual(bet.legs.filter((l) => l.role === 'cashout').map((l) => `${l.clientOrderId}:${l.status}`), [`gv-${id}-cb1:unknown`]);
    assert.deepEqual(tags(), [`gv-${id}-b`, `gv-${id}-a1`, `gv-${id}-cb1`], 'the second sell is not sent, and the first is not sent again');
    assert.equal(app.exchange.positions.get(`${app.exchange.symbol(1820)}|yes`) ?? 0, 0, 'at the exchange the outcome really was sold');

    // The next try is refused for the same reason, in the usual shape, and sends nothing.
    const again = await app.call('POST', '/cashout', { bet: id });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'not_open');
    assert.equal(app.exchange.sent.length, 3);

    // Once the exchange can be asked, recovery finds the sale and the ledger agrees with the account again.
    restore();
    assert.equal(await recoverBets({ exchange: app.exchange, ledger: app.ledger, waiveMarkup: true }), 1);
    const sold = bet.legs.find((l) => l.clientOrderId === `gv-${id}-cb1`)!;
    assert.equal(sold.status, 'filled');
    assert.equal(holdings(bet).outcome.quantity, 0);
    assert.equal(app.exchange.sent.length, 3, 'recovery looks the order up; it never sends it again');
  } finally {
    await app.close();
  }
});

test('the first sell was never received (the exchange says so twice): 422 nothing_sold, and the bet is exactly as it was', async () => {
  const { app, id, tags } = await openBet();
  try {
    app.exchange.failBeforeSend = `gv-${id}-cb1`; // the order never left, and the exchange can say so
    const res = await app.call('POST', '/cashout', { bet: id });
    assert.equal(res.status, 422);
    assert.equal(res.json.code, 'nothing_sold');
    assert.match(res.json.error, /The bet is unchanged/);
    const bet = app.ledger.bet(id)!;
    assert.equal(bet.status, 'open');
    assert.equal(bet.note, undefined);
    assert.equal(bet.cashOut, undefined, 'no cash-out is recorded');
    assert.deepEqual(tags(), [`gv-${id}-b`, `gv-${id}-a1`]);
  } finally {
    await app.close();
  }
});

test('the first sell filled nothing at all (the price moved): 422 nothing_sold, the bet is unchanged', async () => {
  const { app, id } = await openBet();
  try {
    // The order is sent at the bid it was quoted, and finds nobody there.
    const real = app.exchange.placeOrder.bind(app.exchange);
    app.exchange.placeOrder = async (req) => {
      if (req.clientOrderId === `gv-${id}-cb1`) app.exchange.setBook(1820, { bid: 0.3 });
      return real(req);
    };
    const res = await app.call('POST', '/cashout', { bet: id });
    assert.equal(res.status, 422);
    assert.equal(res.json.code, 'nothing_sold');
    assert.equal(app.ledger.bet(id)!.status, 'open');
  } finally {
    await app.close();
  }
});

test('the first sell filled and the SECOND has no confirmed result: 200, the bet is held as unhedged with its unknown note, and the second sell is not sent again', async () => {
  const { app, id, tags } = await openBet();
  try {
    app.exchange.failAfterSend = `gv-${id}-ca1`;
    const restore = cannotBeAsked(app.exchange);
    const res = await app.call('POST', '/cashout', { bet: id });

    assert.equal(res.status, 200, 'the first half was sold; the answer says what is held');
    assert.equal(res.json.bet.status, 'unhedged');
    assert.equal(res.json.bet.note, UNKNOWN_NOTE, 'not "the first half was sold": one order has no result yet');
    assert.deepEqual(res.json.bet.legs.filter((l: { role: string }) => l.role === 'cashout').map((l: { status: string }) => l.status), ['filled', 'unknown']);
    assert.equal(res.json.cashOut.complete, false);
    assert.deepEqual(tags(), [`gv-${id}-b`, `gv-${id}-a1`, `gv-${id}-cb1`, `gv-${id}-ca1`]);

    const again = await app.call('POST', '/cashout', { bet: id });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'not_open');
    assert.equal(app.exchange.sent.length, 4);

    // The second sale did go through: once it can be found the bet is whole again as a sold bet.
    restore();
    assert.equal(await recoverBets({ exchange: app.exchange, ledger: app.ledger, waiveMarkup: true }), 1);
    const bet = app.ledger.bet(id)!;
    assert.equal(bet.status, 'cashed_out');
    assert.equal(bet.note, undefined);
    assert.equal(app.exchange.sent.length, 4);
  } finally {
    await app.close();
  }
});
