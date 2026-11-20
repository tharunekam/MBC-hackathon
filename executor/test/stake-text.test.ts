/**
 * A stake sent as text is a plain dollar amount. It used to go through Number(), so "0x10" placed a $16 bet and "+5", "2e0"
 * and "1e1" were accepted although the docs say a plain amount.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TIGHT, start } from './api-harness.ts';

const ODD = ['0x10', '0b11', '+5', '-5', '2e0', '1e1', 'Infinity', 'NaN', '', '   ', '5 5', '5,5', '--5', '$5', 'five'];

test('a stake written as anything but a plain dollar amount is refused, and nothing is sent', async () => {
  const app = await start(TIGHT);
  try {
    for (const stake of ODD) {
      const res = await app.call('POST', '/bets', app.betBody({ stake }));
      assert.equal(res.status, 400, JSON.stringify(stake));
      assert.equal(res.json.code, 'invalid_stake', JSON.stringify(stake));
    }
    assert.equal(app.exchange.sent.length, 0);
    assert.equal(app.ledger.data.bets.length, 0);
  } finally {
    await app.close();
  }
});

test('the same on a quote and on a basket leg', async () => {
  const app = await start(TIGHT);
  try {
    const sym = (strike: number) => app.exchange.symbol(strike);
    for (const stake of ['0x10', '+5', '2e0']) {
      const quote = await app.call('GET', `/quote?event=ETHTEST&condition=${sym(1800)}&target=${sym(1820)}&stake=${encodeURIComponent(stake)}`);
      assert.equal(quote.status, 400, stake);
      assert.equal(quote.json.code, 'invalid_stake');
      const basket = await app.call('POST', '/baskets', {
        user: 'primary',
        legs: [
          { event: 'ETHTEST', condition: sym(1800), target: sym(1820), stake },
          { event: 'ETHTEST', condition: sym(1800), target: sym(1820), stake: 5 },
        ],
      });
      assert.equal(basket.status, 400, stake);
      assert.equal(basket.json.code, 'invalid_stake');
      assert.match(basket.json.error, /^Leg 1: /);
    }
    assert.equal(app.exchange.sent.length, 0);
  } finally {
    await app.close();
  }
});

test('a plain amount is still taken, as text or as a number', async () => {
  const app = await start(TIGHT);
  try {
    for (const stake of ['10', '10.5', ' 10 ', '10.25', 10, 10.75]) {
      const res = await app.call('POST', '/bets', app.betBody({ stake }));
      assert.equal(res.status, 201, JSON.stringify(stake));
    }
    const sym = (strike: number) => app.exchange.symbol(strike);
    const quote = await app.call('GET', `/quote?event=ETHTEST&condition=${sym(1800)}&target=${sym(1820)}&stake=12.5`);
    assert.equal(quote.status, 200);
    assert.equal(quote.json.stake.requested, 12.5);
  } finally {
    await app.close();
  }
});
