/**
 * The sentence that explains a ladder whose prices are out of order. A falling bet is assessed on the mirror of the ladder, and
 * the sentence used to be written from the mirror: it named the wrong side of the book and prices the person never sees.
 * It must read the same for a rising and a falling bet on the same market: the real higher strike, the real side, the real prices.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkedPairs } from '../src/pairs.ts';
import { FakeExchange } from './fake.ts';

const sentenceFor = async (strikes: ConstructorParameters<typeof FakeExchange>[1], direction: 'up' | 'down') => {
  const event = await new FakeExchange('ETHTEST', strikes).getEvent('ETHTEST');
  const offers = linkedPairs(event, { direction }).map((p) => p.offer.reasons.find((r) => r.code === 'ladder_out_of_order')?.message);
  assert.ok(offers.length > 0);
  assert.ok(offers.every((m) => m === offers[0]), 'the same sentence on every pair of the market');
  return offers[0];
};

test('an ask that is higher on the higher strike reads the same for a falling bet as for a rising one', async () => {
  const strikes = [
    { strike: 1800, bid: 0.8, ask: 0.82 },
    { strike: 1820, bid: 0.5, ask: 0.52 },
    { strike: 1840, bid: 0.3, ask: 0.55 }, // "or above" 1840 cannot cost more to buy than "or above" 1820
  ];
  const expected = 'This market\'s prices are out of order: "$1840 or above" has a higher ask (0.55) than "$1820 or above" (0.52), which cannot be right.';
  assert.equal(await sentenceFor(strikes, 'up'), expected);
  assert.equal(await sentenceFor(strikes, 'down'), expected);
});

test('a bid that is higher on the higher strike reads the same for a falling bet as for a rising one', async () => {
  const strikes = [
    { strike: 1820, bid: 0.5, ask: 0.6 },
    { strike: 1840, bid: 0.55, ask: 0.58 },
  ];
  const expected = 'This market\'s prices are out of order: "$1840 or above" has a higher bid (0.55) than "$1820 or above" (0.5), which cannot be right.';
  assert.equal(await sentenceFor(strikes, 'up'), expected);
  assert.equal(await sentenceFor(strikes, 'down'), expected);
});
