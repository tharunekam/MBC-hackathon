import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it } from 'vitest';
import type { Bet, LegRecord } from '../api/types';
import type { SealProblem } from '../lib/friendly';
import Receipt from './Receipt';

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
  orderId: '1234567890',
  sentAt: '2026-11-20T10:00:00.000Z',
  ...over,
});

const flow = { bets: 1, ordersSent: 2, ordersFilled: 2, contracts: 0, premium: 0, feesAtProductionRates: 0, feesCharged: 0 };

function bet(over: Partial<Bet>): Bet {
  return {
    id: 'bet-1',
    user: 'primary',
    createdAt: '2026-11-20T10:00:00.000Z',
    eventTicker: 'BTC2611201400',
    eventTitle: 'BTC price today at 2pm',
    expiry: null,
    condition: { symbol: 'GEMI-BTC-HI62500', label: '$62,500', strike: 62500 },
    target: { symbol: 'GEMI-BTC-HI64000', label: '$64,000', strike: 64000 },
    requestedStake: 10,
    quotedPrice: 0.45,
    status: 'open',
    legs: [order({}), order({ role: 'hedge', symbol: 'GEMI-BTC-HI62500', outcome: 'no', avgPrice: 0.17, orderId: '9876543210' })],
    cost: 10,
    payoffs: { stake: 10, ifConditionFails: 0, ifBothHit: 14, ifConditionOnly: -10, conditionalPrice: 0.45, hedged: true },
    scorable: true,
    flow,
    ...over,
  };
}

function show(b: Bet, over: { call?: never; callError?: SealProblem | null; onRetryCall?: () => void } = {}): string {
  return renderToStaticMarkup(createElement(StaticRouter, { location: '/parlay' }, createElement(Receipt, { bet: b, call: null, callError: over.callError ?? null, onAgain: () => {}, onRetryCall: over.onRetryCall })));
}

/** The words a person reads, without the tags. */
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('the receipt of a bet that is fully in place', () => {
  const html = show(bet({}));
  const said = text(html);

  it('is the normal receipt: placed, what was paid, both orders filled, the call being recorded, and what each result pays', () => {
    expect(said).toContain('Bet placed');
    expect(said).toContain('You paid $10.00');
    expect(said).toContain('Order 1 went through');
    expect(said).toContain('Order 2 went through');
    expect(said).toContain('Recording your call on Solana');
    for (const kind of ['Win', 'Stake back', 'Lose']) expect(said).toContain(kind);
    // A returned stake is named once, by its row, and nets nothing: it is not also the word on the right.
    expect((said.match(/Stake back/g) ?? []).length).toBe(1);
    expect(said).toMatch(/Stake back.*\$0\.00/);
    expect(said).toContain('See my bets');
    expect(said).toContain('Make another');
  });

  it('keeps both orders filled even when the exchange filled one of them in part and the bet was matched to it', () => {
    const partial = bet({ legs: [order({ quantityRequested: 25, quantityFilled: 20, status: 'partial' }), order({ role: 'hedge', outcome: 'no', avgPrice: 0.17 })] });
    expect(text(show(partial))).toContain('Order 1 went through');
  });
});

describe('the receipt of a bet that did not go through', () => {
  it('a bet that failed says nothing was bought and nothing was spent, and never "Bet placed" or a filled order', () => {
    const said = text(show(bet({ status: 'failed', cost: 0, legs: [order({ status: 'unfilled', quantityFilled: 0, avgPrice: null })], payoffs: undefined })));
    expect(said).toContain('Not placed');
    expect(said).toContain('Nothing was bought and nothing was spent.');
    expect(said).toContain('Try again');
    expect(said).not.toMatch(/Bet placed|Order \d went through|You paid|Recording|Recorded|Stake back/);
  });

  it('a bet that was sold back says the second order could not be placed and what it cost', () => {
    const b = bet({ status: 'unwound', cost: 6.5738, payoffs: { stake: 0, ifBothHit: 0, ifConditionOnly: 0, conditionalPrice: null, hedged: false }, legs: [order({}), order({ role: 'unwind', side: 'sell', avgPrice: 0.34 })] });
    const said = text(show(b));
    expect(said).toContain('Not placed');
    expect(said).toContain('The second order could not be placed, so the first one was sold back.');
    expect(said).toContain('It cost you $6.57');
    expect(said).toContain('Try again');
    expect(said).toContain('See my bets');
    expect(said).not.toMatch(/Bet placed|Order \d went through|You paid|Recording|Recorded|Stake back/);
  });

  it('a bet with only its first order in says the stake is not protected, why, and offers to sell it back; no call is being sealed', () => {
    const b = bet({ status: 'unhedged', cost: 7.6, payoffs: { stake: 7.6, ifConditionFails: -7.6, ifBothHit: 12.4, ifConditionOnly: -7.6, conditionalPrice: 0.38, hedged: false }, legs: [order({ quantityFilled: 20 })] });
    const html = show(b);
    const said = text(html);
    expect(said).toContain('Half placed');
    expect(said).toContain('Only the first order went through, so your stake does not come back if the first level fails.');
    expect(said).not.toMatch(/protect/i);
    expect(said).toContain('You paid $7.60');
    // The first order filled and the second did not, and each says so.
    expect(said).toContain('Order 1 went through');
    expect(said).toContain('Order 2 did not go through');
    expect(said).not.toContain('Order 2 went through');
    expect(said).toContain('but nothing went through');
    expect(said).toContain('Sell it back in My bets');
    // It is not a placed bet: no "Bet placed", no results table that says "Stake back", no call being recorded.
    expect(said).not.toMatch(/Bet placed|Recording|Recorded|Make another bet/);
    expect(html).not.toContain('data-kind="back"');
    expect(html).toContain('href="/bets"');
  });

  it('a Range with only its first order in does not talk about a stake coming back', () => {
    const b = bet({ id: 'rg-1', product: 'range', status: 'unhedged', legs: [order({})] });
    const said = text(show(b));
    expect(said).toContain('Only the first order went through, so only part of this bet is in place.');
    expect(said).not.toContain('pays your stake back');
  });

  it('a bet that is still being placed, or in a state a new bet should not have, is not told as placed', () => {
    for (const status of ['placing', 'settled', 'needs_review', 'cashed_out'] as const) {
      const said = text(show(bet({ status })));
      expect(said).toContain('We could not confirm how this bet ended.');
      expect(said).toContain('See my bets');
      expect(said).not.toMatch(/Bet placed|Order \d went through/);
    }
  });

  it('shows no reduced-stake note for a bet that is not placed', () => {
    const said = text(show(bet({ status: 'unhedged', stakeReduced: { requested: 10, reducedTo: 4, outcomeAvailable: 3, conditionAvailable: 3, reason: 'x' } })));
    expect(said).not.toContain('could cover only part');
    expect(text(show(bet({ stakeReduced: { requested: 10, reducedTo: 4, outcomeAvailable: 3, conditionAvailable: 3, reason: 'x' } })))).toContain('could cover only part');
  });
});

describe('the step that seals the call', () => {
  const retry = () => {};

  it('offers a second try when sealing failed for a reason that may pass', () => {
    const html = show(bet({}), { callError: { text: 'We could not seal this call yet, but your bet is placed.', final: false }, onRetryCall: retry });
    const said = text(html);
    expect(said).toContain('Could not record the call');
    expect(said).toContain('We could not seal this call yet, but your bet is placed.');
    expect(said).toContain('Try again');
  });

  it('says the market has closed, and offers no second try, when the chain service refuses the call for good', () => {
    const html = show(bet({}), { callError: { text: 'This market has closed, so the call can no longer be sealed. Your bet is placed.', final: true }, onRetryCall: retry });
    const said = text(html);
    expect(said).toContain('This market has closed, so the call can no longer be sealed.');
    expect(said).not.toContain('Try again');
  });
});
