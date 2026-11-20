import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it } from 'vitest';
import type { Bet, LegRecord, PlaceBasketResponse } from '../api/types';
import BasketResult, { type CallProgress } from './BasketResult';

const order = (over: Partial<LegRecord>): LegRecord => ({
  clientOrderId: 'gv-x',
  role: 'outcome',
  symbol: 'GEMI-BTC-HI64000',
  side: 'buy',
  outcome: 'yes',
  limitPrice: 0.5,
  quantityRequested: 20,
  quantityFilled: 20,
  avgPrice: 0.38,
  fee: 0,
  status: 'filled',
  sentAt: '2026-11-20T10:00:00.000Z',
  ...over,
});

const flow = { bets: 1, ordersSent: 2, ordersFilled: 2, contracts: 0, premium: 0, feesAtProductionRates: 0, feesCharged: 0 };

const leg = (index: number, over: Partial<Bet> = {}): Bet => ({
  id: `bk-${index}`,
  user: 'primary',
  createdAt: '2026-11-20T10:00:00.000Z',
  eventTicker: 'BTC2611201400',
  eventTitle: 'BTC price today at 2pm',
  expiry: null,
  basket: { id: 'k', name: 'Mixed', index, size: 4 },
  condition: { symbol: 'GEMI-BTC-HI62500', label: '$62,500', strike: 62500 },
  target: { symbol: 'GEMI-BTC-HI64000', label: '$64,000', strike: 64000 },
  requestedStake: 10,
  quotedPrice: 0.45,
  status: 'open',
  legs: [order({}), order({ role: 'hedge', outcome: 'no', avgPrice: 0.17 })],
  cost: 10,
  payoffs: { stake: 10, ifConditionFails: 0, ifBothHit: 14, ifConditionOnly: -10, conditionalPrice: 0.45, hedged: true },
  scorable: true,
  flow,
  ...over,
});

const calls: CallProgress = { total: 0, done: 0, failed: 0, late: 0, failedIds: [] };

function show(result: PlaceBasketResponse, over: Partial<CallProgress> = {}): string {
  const html = renderToStaticMarkup(
    createElement(
      StaticRouter,
      { location: '/basket' },
      createElement(BasketResult, { result, legs: [], events: [], calls: { ...calls, ...over }, headingRef: createRef<HTMLHeadingElement>(), onAgain: () => {}, onRest: () => {}, onRetryCalls: () => {} }),
    ),
  );
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}

describe('a basket whose leg ended with only its first order in place', () => {
  const held = leg(1, { status: 'unhedged', cost: 7.6, legs: [order({})], payoffs: { stake: 7.6, ifConditionFails: -7.6, ifBothHit: 12.4, ifConditionOnly: -7.6, conditionalPrice: 0.38, hedged: false } });
  const result: PlaceBasketResponse = { basket: { id: 'k', name: 'Mixed', size: 4, failed: { index: 1, code: 'unhedged', message: 'dev text: the hedge leg could not be completed' } }, bets: [leg(0), held] };
  const said = show(result);

  it('says the leg is only half placed, with what it cost, and prints nothing the server said', () => {
    expect(said).toContain('Half placed');
    expect(said).toContain('Only the first order went through, so the stake does not come back if the first level fails. You can sell it back in My bets.');
    expect(said).not.toMatch(/protected|\bfilled\b/);
    expect(said).not.toMatch(/dev text|hedge leg/);
    // Its $7.60 is real money in the account: it is in what was staked, and the count says two legs.
    expect(said).toContain('Staked, 2 of 4 legs');
    expect(said).toContain('$17.60');
  });

  it('does not offer to place the leg again, because it is already on the books', () => {
    // Two legs are left after it, so the rest can be placed; it starts at leg 3.
    expect(said).toContain('Place the rest again');
    const lastButOne: PlaceBasketResponse = { ...result, basket: { ...result.basket, size: 3 } };
    expect(show(lastButOne)).not.toContain('Place the rest again');
  });
});

describe('a basket whose leg was sold back', () => {
  it('says so in the plain words of a single bet, and offers the leg again', () => {
    const unwound = leg(1, { status: 'unwound', cost: 0.84, legs: [order({}), order({ role: 'unwind', side: 'sell', avgPrice: 0.34 })] });
    const said = show({ basket: { id: 'k', name: 'Mixed', size: 4, failed: { index: 1, code: 'unwound', message: 'x' } }, bets: [leg(0), unwound] });
    expect(said).toContain('The second order could not be placed, so the first one was sold back.');
    expect(said).toContain('Place the rest again');
    expect(said).toContain('Not completed');
  });
});

describe('calls that could not be sealed', () => {
  const whole: PlaceBasketResponse = { basket: { id: 'k', name: null, size: 2, failed: null }, bets: [leg(0), leg(1)] };

  it('counts a call refused because its market had closed apart, with no second try', () => {
    const said = show(whole, { total: 2, done: 1, late: 1 });
    expect(said).toContain('One call could not be sealed, because its market had closed.');
    expect(said).toContain('Calls recorded 1 of 2');
    expect(said).not.toContain('Try again');
  });

  it('keeps a call that failed for another reason retryable', () => {
    const said = show(whole, { total: 2, done: 1, failed: 1, failedIds: ['bk-1'] });
    expect(said).toContain('One call could not be recorded.');
    expect(said).toContain('Try again');
  });
});

describe('a basket whose leg has an order nobody could confirm', () => {
  const unknown = order({ status: 'unknown', quantityFilled: 0, avgPrice: null });
  const held = leg(1, { status: 'unhedged', cost: 7.6, legs: [order({}), unknown], note: 'Gemini did not confirm one of this bet\'s orders, so the bet may be partly or fully in place. Nothing more was sent. Check your Gemini account.' });
  const result: PlaceBasketResponse = { basket: { id: 'k', name: 'Mixed', size: 4, failed: { index: 1, code: 'unhedged', message: 'dev text' } }, bets: [leg(0), held] };
  const said = show(result);

  it('says the leg is not confirmed, in the one plain sentence, and never offers a sell-back for it', () => {
    expect(said).toContain('Not confirmed');
    expect(said).toContain('Leg 2 is not confirmed.');
    expect(said).toContain('Gemini did not confirm one of this bet’s orders, so it may be partly or fully in place. Check your Gemini account.');
    expect(said).not.toMatch(/sell it back|Half placed|dev text/);
  });

  it('counts its money in what was staked, because it may well be in the account', () => {
    expect(said).toContain('Staked, 2 of 4 legs');
    expect(said).toContain('$17.60');
  });
});

describe('a basket leg refused because the price moved', () => {
  const result: PlaceBasketResponse = { basket: { id: 'k', name: null, size: 3, failed: { index: 1, code: 'price_above_limit', message: 'Leg 2: The live price is 0.49 per $1, above your limit of 0.46.' } }, bets: [leg(0)] };

  it('says the price moved and that nothing after it was placed, without a bet to place again and without the server’s words', () => {
    const said = show(result);
    expect(said).toContain('Leg 2 could not be completed. The price moved while you were deciding.');
    expect(said).not.toMatch(/live price|limit|place the (bet|basket) again/);
  });
});
