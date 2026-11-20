import { describe, expect, it } from 'vitest';
import type { Bet } from '../api/types';
import { basketSummary, boughtOf, calledResult, callResult, canRevealCall, checkedWords, fillWords, filterEntries, finishedWords, groupBets, hasPending, ifItComesOff, isOpen, isUnconfirmed, kindLabel, matches, netLabel, notPlacedWords, orderIdWords, orderLine, outcomeOf, partSoldWords, realised, revealedWords, reviewWords, sellOrdersWords, sharesWords, soldCallWords, stakeOf, statusWords, summarize, unconfirmedWords, unprotectedWords, usableBets } from './betsView';

const flow = { bets: 1, ordersSent: 2, ordersFilled: 2, contracts: 0, premium: 0, feesAtProductionRates: 0, feesCharged: 0 };

function bet(over: Partial<Bet> & { id: string }): Bet {
  return {
    user: 'primary',
    createdAt: '2026-11-19T10:00:00.000Z',
    eventTicker: 'BTC2611191400',
    eventTitle: 'BTC price today at 2pm',
    expiry: null,
    condition: { symbol: 'GEMI-BTC-HI62500', label: '$62,500', strike: 62500 },
    target: { symbol: 'GEMI-BTC-HI64000', label: '$64,000', strike: 64000 },
    requestedStake: 10,
    quotedPrice: 0.4,
    status: 'open',
    legs: [],
    cost: 10,
    payoffs: { stake: 10, ifConditionFails: 0, ifBothHit: 14, ifConditionOnly: -10, conditionalPrice: 0.4, hedged: true },
    scorable: true,
    flow,
    ...over,
  };
}

const settled = (pnl: number, payout: number, conditionResolved: 'yes' | 'no' = 'yes', targetResolved: 'yes' | 'no' = 'yes') => ({
  status: 'settled' as const,
  settlement: { conditionResolved, targetResolved, payout, pnl, settledAt: '2026-11-19T14:00:00.000Z' },
});

describe('the state of a bet', () => {
  it('reads open, each result, review, failed and unwound', () => {
    expect(outcomeOf(bet({ id: 'a' }))).toBe('open');
    // The first order is in and the second is not: that is not an ordinary open bet, and nothing may call it one.
    expect(outcomeOf(bet({ id: 'a', status: 'unhedged' }))).toBe('unprotected');
    expect(outcomeOf(bet({ id: 'a', status: 'placing' }))).toBe('placing');
    expect(outcomeOf(bet({ id: 'a', ...settled(14, 24) }))).toBe('won');
    expect(outcomeOf(bet({ id: 'a', ...settled(-10, 0, 'yes', 'no') }))).toBe('lost');
    expect(outcomeOf(bet({ id: 'a', ...settled(0, 10, 'no', 'no') }))).toBe('back');
    expect(outcomeOf(bet({ id: 'a', status: 'needs_review' }))).toBe('review');
    expect(outcomeOf(bet({ id: 'a', status: 'failed' }))).toBe('failed');
    expect(outcomeOf(bet({ id: 'a', status: 'unwound' }))).toBe('unwound');
  });

  it('speaks in the product’s own words', () => {
    expect(statusWords(bet({ id: 'a', ...settled(14, 24) }))).toBe('Won');
    expect(statusWords(bet({ id: 'a', ...settled(0, 10, 'no', 'no') }))).toBe('Stake back');
    // Every product says Won or Lost; where the price ended is on the line under the figure (see finishedWords).
    expect(statusWords(bet({ id: 'rg-a', product: 'range', ...settled(6, 20) }))).toBe('Won');
    expect(statusWords(bet({ id: 'rg-a', product: 'range', ...settled(-4, 10, 'yes', 'no') }))).toBe('Lost');
    expect(statusWords(bet({ id: 'bo-a', product: 'breakout', ...settled(6, 16) }))).toBe('Won');
    expect(statusWords(bet({ id: 'bo-a', product: 'breakout', ...settled(-10, 0, 'yes', 'no') }))).toBe('Lost');
    expect(statusWords(bet({ id: 'a', status: 'needs_review' }))).toBe('Being checked');
    expect(statusWords(bet({ id: 'a', status: 'failed' }))).toBe('Not placed');
    expect(statusWords(bet({ id: 'a', status: 'unwound' }))).toBe('Sold back');
    // Said by what is true, not as a promise: "protected" is a word a bet cannot back.
    expect(statusWords(bet({ id: 'a', status: 'unhedged' }))).toBe('Half placed');
    expect(statusWords(bet({ id: 'a', status: 'placing' }))).toBe('Being placed');
    expect(statusWords(bet({ id: 'a' }))).toBe('Open');
  });

  it('says plainly what a bet that never went on means, and what to do', () => {
    expect(notPlacedWords('failed')).toBe('Not placed. The first order did not go through, so nothing was bought and nothing was spent. You can place the bet again.');
    expect(notPlacedWords('unwound')).toBe('The second order could not be placed, so the first was sold back and nothing is left open.');
    // A sold-back bet cost something, and says what.
    expect(notPlacedWords('unwound', { cost: 6.5738 })).toBe('The second order could not be placed, so the first was sold back and nothing is left open. It cost you $6.57.');
    expect(notPlacedWords('open')).toBeNull();
    expect(notPlacedWords('unprotected')).toBeNull();
    expect(reviewWords(null)).toBe('This market ended without a clear yes or no. We are working out what it paid. This call is not scored.');
    expect(reviewWords(12)).toBe('This market ended without a clear yes or no. It paid $12.00. This call is not scored.');
  });

  it('tags a falling parlay as one', () => {
    expect(kindLabel({ product: 'parlay', direction: 'up' })).toBe('Stake Back up');
    expect(kindLabel({ product: 'parlay', direction: 'down' })).toBe('Stake Back down');
    expect(kindLabel({ product: 'range', direction: 'up' })).toBe('Range');
    expect(kindLabel({ product: 'breakout', direction: 'up' })).toBe('Breakout');
  });

  it('says what an open bet takes to pay, each way', () => {
    expect(ifItComesOff(bet({ id: 'a' }))).toEqual({ amount: 14, condition: 'if it reaches $64,000' });
    expect(ifItComesOff(bet({ id: 'dn-a', direction: 'down', target: { symbol: 't', label: 't', strike: 61000 } })).condition).toBe('if it falls below $61,000');
    const range = bet({ id: 'rg-a', product: 'range', payoffs: { stake: 10, ifBothHit: 6, ifConditionOnly: -4, ifInRange: 6, ifOutside: -4, conditionalPrice: 0.5, hedged: true } });
    expect(ifItComesOff(range)).toEqual({ amount: 6, condition: 'if it finishes inside' });
    const breakout = bet({ id: 'bo-a', product: 'breakout', payoffs: { stake: 10, ifBothHit: 6, ifConditionOnly: -10, ifInRange: -10, ifOutside: 6, conditionalPrice: 0.62, hedged: true } });
    expect(ifItComesOff(breakout)).toEqual({ amount: 6, condition: 'if it finishes outside' });
  });
});

describe('where the ladder finished', () => {
  const at = (finishedAt?: number) => bet({ id: 'a', status: 'settled', settlement: { conditionResolved: 'yes', targetResolved: 'yes', payout: 24, pnl: 14, settledAt: '2026-11-19T14:00:00.000Z', ...(finishedAt === undefined ? {} : { finishedAt }) } });

  it('is said in dollars and cents when the exchange reported it, whatever the product', () => {
    expect(finishedWords(at(63696.06))).toBe('Finished at $63,696.06');
    expect(finishedWords(at(63700))).toBe('Finished at $63,700');
    expect(finishedWords(at(0.9512))).toBe('Finished at $0.9512');
    // A range or a breakout also says which side of its two levels that is, because its chip says only Won or Lost.
    expect(finishedWords({ ...at(142.3), product: 'parlay' })).toBe('Finished at $142.30');
    expect(finishedWords({ ...at(142.3), product: 'range' })).toBe('Finished at $142.30, inside the range');
    expect(finishedWords({ ...at(142.3), product: 'breakout' })).toBe('Finished at $142.30, outside the range');
    const lostRange = bet({ id: 'rg-a', product: 'range', status: 'settled', settlement: { conditionResolved: 'yes', targetResolved: 'no', payout: 0, pnl: -10, settledAt: '', finishedAt: 64100 } });
    expect(finishedWords(lostRange)).toBe('Finished at $64,100, outside the range');
    // No price reported: the side still says where it ended.
    expect(finishedWords({ ...lostRange, settlement: { ...lostRange.settlement!, finishedAt: undefined } })).toBe('Finished outside the range');
  });

  it('says nothing when it was not reported, for an open bet, and for one sold back before it settled', () => {
    expect(finishedWords(at())).toBeNull();
    expect(finishedWords(at(Number.NaN))).toBeNull();
    expect(finishedWords(bet({ id: 'a' }))).toBeNull();
    expect(finishedWords(bet({ id: 'c', status: 'cashed_out', cashOut: { at: '', stake: 10, proceeds: 9.2, pnl: -0.8, complete: true } }))).toBeNull();
  });
});

describe('a bet that was sold back, and its call', () => {
  const sold = (over: Partial<Bet> = {}) => bet({ id: 'c', status: 'cashed_out', cost: 0.8, scorable: false, cashOut: { at: '2026-11-19T11:00:00.000Z', stake: 10, proceeds: 9.2, pnl: -0.8, complete: true }, ...over });
  const called = (conditionResolved: 'yes' | 'no', targetResolved: 'yes' | 'no', finishedAt?: number) => ({ called: { conditionResolved, targetResolved, at: '2026-11-19T14:00:05.000Z', ...(finishedAt === undefined ? {} : { finishedAt }) }, scorable: true });

  it('has no result until the market does, and then reads won, lost or refunded like any other', () => {
    expect(calledResult(sold())).toBeNull();
    expect(calledResult(sold(called('yes', 'yes')))).toBe('won');
    expect(calledResult(sold(called('yes', 'no')))).toBe('lost');
    expect(calledResult(sold(called('no', 'no')))).toBe('refunded');
    // Only a sold-back bet has a call that outlives it: an open bet's result comes from its settlement.
    expect(calledResult(bet({ id: 'a', ...called('yes', 'yes') }))).toBeNull();
  });

  it('can be revealed once its call came off or did not, exactly as a held bet can', () => {
    expect(canRevealCall(sold())).toBe(false);
    expect(canRevealCall(sold(called('yes', 'yes')))).toBe(true);
    expect(canRevealCall(sold(called('yes', 'no')))).toBe(true);
    expect(canRevealCall(sold(called('no', 'no')))).toBe(false);
    expect(canRevealCall(bet({ id: 'a' }))).toBe(false);
    expect(canRevealCall(bet({ id: 'a', ...settled(14, 24) }))).toBe(true);
    expect(canRevealCall(bet({ id: 'a', ...settled(-10, 0, 'yes', 'no') }))).toBe(true);
    expect(canRevealCall(bet({ id: 'a', ...settled(0, 10, 'no', 'no') }))).toBe(false);
    expect(canRevealCall(bet({ id: 'a', status: 'needs_review' }))).toBe(false);
    expect(callResult(bet({ id: 'a', ...settled(0, 10, 'no', 'no') }))).toBe('refunded');
    expect(callResult(sold(called('yes', 'no')))).toBe('lost');
  });

  it('says what became of the call in the bet’s own words', () => {
    expect(soldCallWords(sold())).toBe('Waiting for the market to close. After that its call can be revealed.');
    expect(soldCallWords(sold(called('yes', 'yes')))).toBe('The market has closed: it reached $64,000, so your call won.');
    expect(soldCallWords(sold(called('yes', 'no')))).toBe('The market has closed: it did not reach $64,000, so your call lost.');
    expect(soldCallWords(sold(called('no', 'no')))).toBe('The market has closed and the first level failed, so this call does not count.');
    const falling = { direction: 'down' as const, condition: { symbol: 'hi', label: '', strike: 64000 }, target: { symbol: 'lo', label: '', strike: 62500 } };
    expect(soldCallWords(sold({ id: 'dn-c', ...falling, ...called('yes', 'yes') }))).toBe('The market has closed: it fell below $62,500, so your call won.');
    expect(soldCallWords(sold({ id: 'dn-c', ...falling, ...called('yes', 'no') }))).toBe('The market has closed: it did not fall below $62,500, so your call lost.');
    expect(soldCallWords(sold({ id: 'rg-c', product: 'range', ...called('yes', 'yes') }))).toBe('The market has closed: it finished between $62,500 and $64,000, so your call won.');
    expect(soldCallWords(sold({ id: 'rg-c', product: 'range', ...called('yes', 'no') }))).toBe('The market has closed: it finished outside $62,500 to $64,000, so your call lost.');
    expect(soldCallWords(sold({ id: 'bo-c', product: 'breakout', ...called('yes', 'yes') }))).toBe('The market has closed: it finished outside $62,500 to $64,000, so your call won.');
    expect(soldCallWords(sold({ id: 'bo-c', product: 'breakout', ...called('yes', 'no') }))).toBe('The market has closed: it finished between $62,500 and $64,000, so your call lost.');
  });

  it('says how many sell orders it took, from the orders it carries', () => {
    const order = (role: 'outcome' | 'hedge' | 'cashout', n: number) => ({ clientOrderId: `o${n}`, role, symbol: 's', side: role === 'cashout' ? ('sell' as const) : ('buy' as const), outcome: 'yes' as const, limitPrice: 0.5, quantityRequested: 1, quantityFilled: 1, avgPrice: 0.5, fee: 0, status: 'filled' as const, sentAt: '' });
    const bought = [order('outcome', 1), order('hedge', 2)];
    expect(sellOrdersWords(sold({ legs: [...bought, order('cashout', 3), order('cashout', 4)] }))).toBe('as two sell orders');
    expect(sellOrdersWords(sold({ legs: [...bought, order('cashout', 3)] }))).toBe('as one sell order');
    // Sold in two goes: four sell orders in all.
    expect(sellOrdersWords(sold({ legs: [...bought, order('cashout', 3), order('cashout', 4), order('cashout', 5), order('cashout', 6)] }))).toBe('as 4 sell orders');
    expect(sellOrdersWords(sold({ legs: bought }))).toBe('');
  });

  it('shows where the ladder finished once the market has said, the same way a settled bet does', () => {
    expect(finishedWords(sold())).toBeNull();
    expect(finishedWords(sold(called('yes', 'yes')))).toBeNull();
    expect(finishedWords(sold(called('yes', 'yes', 64120.5)))).toBe('Finished at $64,120.50');
  });

  it('stays cashed out, and stays out of the figures a second time, once its call has a result', () => {
    const b = sold(called('yes', 'yes', 64120.5));
    expect(outcomeOf(b)).toBe('cashed');
    expect(statusWords(b)).toBe('Cashed out');
    const t = summarize([b]);
    expect(t).toMatchObject({ count: 1, notPlaced: 0, open: 0, settled: 1, staked: 10, returned: 9.2 });
    expect(t.net).toBeCloseTo(-0.8, 10);
  });

  it('is something "Check results" can still change until its market has a result', () => {
    expect(hasPending([])).toBe(false);
    expect(hasPending([bet({ id: 'a', ...settled(14, 24) }), sold(called('yes', 'no'))])).toBe(false);
    expect(hasPending([bet({ id: 'a', ...settled(14, 24) }), sold()])).toBe(true);
    expect(hasPending([bet({ id: 'a' })])).toBe(true);
    expect(hasPending([bet({ id: 'a', status: 'needs_review' })])).toBe(true);
    expect(hasPending([bet({ id: 'a', status: 'failed' }), bet({ id: 'b', status: 'unwound' })])).toBe(false);
    // A bet with only its first order in place can still change: it can be sold back, and it settles.
    expect(hasPending([bet({ id: 'a', status: 'unhedged' })])).toBe(true);
  });
});

describe('what "Check results" found', () => {
  it('counts what settled, and says when a sold-back bet’s call now has its result', () => {
    expect(checkedWords({ settled: 1, stillOpen: 0 })).toBe('1 bet finished.');
    expect(checkedWords({ settled: 3, called: 0, stillOpen: 2 })).toBe('3 bets finished.');
    expect(checkedWords({ settled: 0, called: 1, stillOpen: 0 })).toBe('The market behind 1 bet you sold back has closed, so its call can be revealed.');
    expect(checkedWords({ settled: 2, called: 2, stillOpen: 0 })).toBe('2 bets finished. The market behind 2 bets you sold back has closed, so their calls can be revealed.');
  });

  it('says so when there was nothing new', () => {
    expect(checkedWords({ settled: 0, stillOpen: 2 })).toBe('Nothing has closed yet. Results arrive a few seconds after a market closes.');
    expect(checkedWords({ settled: 0, called: 0, stillOpen: 0 })).toBe('Everything is up to date.');
  });
});

describe('an order’s id', () => {
  it('is named "Exchange ID", so it is not mistaken for "Order 1" and "Order 2", and a one-character id is not left floating', () => {
    expect(orderIdWords('1')).toBe('Exchange ID 1');
    expect(orderIdWords('145236781203948571')).toBe('Exchange ID 145236…8571');
    expect(orderIdWords(undefined)).toBe('No exchange ID yet');
    expect(orderIdWords('')).toBe('No exchange ID yet');
  });
});

describe('what an order did', () => {
  it('reads in shares, always to two decimals, with the level and the price each', () => {
    expect(sharesWords(10.2)).toBe('10.20');
    expect(sharesWords(Number.NaN)).toBe('–');
    const filled = { quantityFilled: 15.83, avgPrice: 0.38, status: 'filled' as const };
    expect(fillWords(filled, { side: 'YES', strike: 63500 })).toBe('15.83 YES shares on $63,500 at 38¢ each');
    expect(fillWords({ ...filled, quantityFilled: 10.2, avgPrice: 0.39 }, { side: 'NO', strike: 63000 })).toBe('10.20 NO shares on $63,000 at 39¢ each');
    expect(fillWords({ ...filled, avgPrice: null, status: 'partial' }, { side: 'YES', strike: null })).toBe('15.83 YES shares at –, partly completed');
  });
});

describe('the stake of a bet', () => {
  it('is what the person entered, not what the orders cost', () => {
    expect(stakeOf(bet({ id: 'a', requestedStake: 10, cost: 9.9952 }))).toBe(10);
    expect(stakeOf(bet({ id: 'a', requestedStake: 10, cost: 10.0001 }))).toBe(10);
  });

  it('is what the orders cost when the market could only fill a smaller bet', () => {
    const reduced = { requested: 10, reducedTo: 0.9, outcomeAvailable: 2, conditionAvailable: 2, reason: 'x' };
    expect(stakeOf(bet({ id: 'a', requestedStake: 10, cost: 0.9, stakeReduced: reduced }))).toBe(0.9);
  });

  it('keeps what a bet cost before it was sold when no entered stake is on record', () => {
    expect(stakeOf(bet({ id: 'a', requestedStake: 0, cost: 0.8, cashOut: { at: '', stake: 10, proceeds: 9.2, pnl: -0.8, complete: true } }))).toBe(10);
  });
});

describe('the four figures', () => {
  it('count placed bets, stake what they cost, and return and net only what is in', () => {
    const t = summarize([
      bet({ id: 'a', cost: 10, requestedStake: 10, ...settled(14, 24) }),
      bet({ id: 'b', cost: 20, requestedStake: 20, ...settled(0, 20, 'no', 'no') }),
      bet({ id: 'c', cost: 15, requestedStake: 15, ...settled(-15, 0, 'yes', 'no') }),
      bet({ id: 'd', cost: 5, requestedStake: 5 }),
      bet({ id: 'e', cost: 0, status: 'failed' }),
      bet({ id: 'f', cost: 8, status: 'unwound' }),
      bet({ id: 'g', cost: 10, requestedStake: 10, status: 'needs_review' }),
      bet({ id: 'h', cost: 10, requestedStake: 10, status: 'needs_review', review: { reason: 'x', resolved: { payout: 12, pnl: 2, recordedAt: '', note: '' } } }),
    ]);
    // Every bet is in the count, so it agrees with the filter's "All". The one that bought nothing is left out of the money. The
    // one that was sold straight back (no orders on record here, so it bought what it cost) lost its $8: that is in all three.
    expect(t).toEqual({ count: 8, notPlaced: 1, open: 1, settled: 6, staked: 78, returned: 56, net: -7 });
  });
});

describe('baskets', () => {
  const leg = (id: string, index: number, over: Partial<Bet> = {}) => bet({ id, basket: { id: 'bk1', name: 'Majors', index, size: 3 }, ...over });

  it('gathers a basket’s legs into one entry, in leg order, where its first leg appears', () => {
    const list = [bet({ id: 'new' }), leg('l2', 2), leg('l0', 0), bet({ id: 'mid' }), leg('l1', 1), bet({ id: 'old' })];
    const g = groupBets(list);
    expect(g.map((e) => (e.type === 'single' ? e.bet.id : `basket:${e.legs.map((b) => b.id).join(',')}`))).toEqual(['new', 'basket:l0,l1,l2', 'mid', 'old']);
  });

  it('keeps two baskets apart and falls back to no name', () => {
    const g = groupBets([bet({ id: 'x', basket: { id: 'b1', index: 0, size: 2 } }), bet({ id: 'y', basket: { id: 'b2', index: 0, size: 2 } })]);
    expect(g).toHaveLength(2);
    expect(g[0]!.type === 'basket' && g[0]!.name).toBeNull();
  });

  it('sums the basket: legs, stake, how many settled, and net only once a leg is in', () => {
    const open = groupBets([leg('a', 0, { cost: 10, requestedStake: 10 }), leg('b', 1, { cost: 12, requestedStake: 12 })])[0]!;
    if (open.type !== 'basket') throw new Error('not a basket');
    expect(basketSummary(open)).toMatchObject({ legs: 2, size: 3, stake: 22, settled: 0, net: null });
    const part = groupBets([leg('a', 0, { cost: 10, ...settled(-10, 0, 'yes', 'no') }), leg('b', 1, { cost: 12, createdAt: '2026-11-19T09:59:00.000Z' })])[0]!;
    if (part.type !== 'basket') throw new Error('not a basket');
    expect(basketSummary(part)).toMatchObject({ settled: 1, net: -10, placedAt: '2026-11-19T09:59:00.000Z' });
  });

  it('calls the net a running figure until every leg is in, and the result after', () => {
    const summary = (legs: Bet[]) => {
      const e = groupBets(legs)[0]!;
      if (e.type !== 'basket') throw new Error('not a basket');
      return basketSummary(e);
    };
    const part = summary([leg('a', 0, settled(-10, 0, 'yes', 'no')), leg('b', 1)]);
    expect(part.done).toBe(false);
    expect(netLabel(part)).toBe('Net so far');
    const sold = leg('c', 2, { status: 'cashed_out', cost: 0.8, cashOut: { at: '', stake: 10, proceeds: 9.2, pnl: -0.8, complete: true } });
    const all = summary([leg('a', 0, settled(-10, 0, 'yes', 'no')), leg('b', 1, settled(14, 24)), sold]);
    expect(all).toMatchObject({ settled: 3, done: true });
    expect(all.net).toBeCloseTo(3.2, 10);
    expect(netLabel(all)).toBe('Net result');
    // A leg that never went on does not hold the basket open; a leg still being checked by hand does.
    expect(summary([leg('a', 0, settled(14, 24)), leg('b', 1, { status: 'failed' })]).done).toBe(true);
    expect(summary([leg('a', 0, settled(14, 24)), leg('b', 1, { status: 'needs_review' })]).done).toBe(false);
    expect(summary([leg('a', 0)]).done).toBe(false);
  });

  it('a filter keeps the basket whole as one entry but shows only the legs that match', () => {
    const g = groupBets([leg('a', 0, settled(14, 24)), leg('b', 1), bet({ id: 'c' })]);
    const settledOnly = filterEntries(g, 'settled');
    expect(settledOnly).toHaveLength(1);
    expect(settledOnly[0]!.type === 'basket' && settledOnly[0]!.legs.map((b) => b.id)).toEqual(['a']);
    expect(filterEntries(g, 'open')).toHaveLength(2);
    expect(filterEntries(g, 'all')).toHaveLength(2);
  });
});

describe('the orders, in each product’s words', () => {
  const yesNo = (role: 'outcome' | 'hedge', symbol: string, outcome: 'yes' | 'no') => ({ role, symbol, outcome, side: 'buy' as const });

  it('a range is a YES on its lower strike and a NO on its higher', () => {
    const r = bet({ id: 'rg-a', product: 'range' });
    expect(orderLine(r, yesNo('outcome', r.condition.symbol, 'yes'))).toEqual({ label: 'Order 1', bets: 'Bets that it finishes at or above $62,500', side: 'YES', strike: 62500 });
    expect(orderLine(r, yesNo('hedge', r.target.symbol, 'no'))).toEqual({ label: 'Order 2', bets: 'Bets that it finishes below $64,000', side: 'NO', strike: 64000 });
  });

  it('a breakout is a YES on its higher strike and a NO on its lower: the range, turned inside out', () => {
    const b = bet({ id: 'bo-a', product: 'breakout' });
    expect(orderLine(b, yesNo('outcome', b.target.symbol, 'yes'))).toEqual({ label: 'Order 1', bets: 'Bets that it finishes at or above $64,000', side: 'YES', strike: 64000 });
    expect(orderLine(b, yesNo('hedge', b.condition.symbol, 'no'))).toEqual({ label: 'Order 2', bets: 'Bets that it finishes below $62,500', side: 'NO', strike: 62500 });
  });

  it('a falling parlay is a NO on its lower strike and a YES on its higher', () => {
    const d = bet({ id: 'dn-a', direction: 'down', condition: { symbol: 'hi', label: '', strike: 64000 }, target: { symbol: 'lo', label: '', strike: 62500 } });
    expect(orderLine(d, yesNo('outcome', 'lo', 'no'))).toMatchObject({ bets: 'Bets that it falls below $62,500', side: 'NO', strike: 62500 });
    expect(orderLine(d, yesNo('hedge', 'hi', 'yes'))).toMatchObject({ bets: 'Bets that it reaches $64,000', side: 'YES', strike: 64000 });
  });

  it('a rising parlay buys YES on its target and NO on its condition', () => {
    const u = bet({ id: 'a' });
    expect(orderLine(u, yesNo('outcome', u.target.symbol, 'yes'))).toMatchObject({ label: 'Order 1', bets: 'Bets that it reaches $64,000', side: 'YES' });
    expect(orderLine(u, yesNo('hedge', u.condition.symbol, 'no'))).toMatchObject({ label: 'Order 2', bets: 'Bets that it falls below $62,500', side: 'NO' });
  });
});

describe('what a bet made or lost', () => {
  it('is worked out against the stake the person sees, so a $10 bet that lost reads −$10.00 and not −$9.99', () => {
    const lost = bet({ id: 'a', requestedStake: 10, cost: 9.99, status: 'settled', settlement: { conditionResolved: 'yes', targetResolved: 'no', payout: 0, pnl: -9.99, settledAt: '' } });
    expect(realised(lost)).toEqual({ payout: 0, pnl: -10 });
    const won = bet({ id: 'b', requestedStake: 10, cost: 9.99, status: 'settled', settlement: { conditionResolved: 'yes', targetResolved: 'yes', payout: 15.83, pnl: 5.84, settledAt: '' } });
    expect(realised(won)!.pnl).toBeCloseTo(5.83, 10);
  });

  it('keeps the true cost when the market could only fill a smaller bet', () => {
    const reduced = { requested: 10, reducedTo: 0.9, outcomeAvailable: 2, conditionAvailable: 2, reason: 'x' };
    const lost = bet({ id: 'a', requestedStake: 10, cost: 0.9, stakeReduced: reduced, status: 'settled', settlement: { conditionResolved: 'yes', targetResolved: 'no', payout: 0, pnl: -0.9, settledAt: '' } });
    expect(realised(lost)).toEqual({ payout: 0, pnl: -0.9 });
  });
});

// ------------------------------------------------------------------ BS-05 and BS-06

const order = (over: Partial<Bet['legs'][number]>): Bet['legs'][number] => ({
  clientOrderId: 'gv-x',
  role: 'outcome',
  symbol: 'GEMI-BTC-HI64000',
  side: 'buy',
  outcome: 'yes',
  limitPrice: 0.5,
  quantityRequested: 200,
  quantityFilled: 200,
  avgPrice: 0.5,
  fee: 0,
  status: 'filled',
  sentAt: '2026-11-19T10:00:00.000Z',
  ...over,
});

describe('a bet whose second order could not be placed, and was sold back', () => {
  // Bought 200 shares at 50¢ ($100), sold them back at 46.72¢ ($93.44): the loss is $6.56, which is the executor's `cost`.
  const unwound = (id = 'u1') => bet({ id, status: 'unwound', requestedStake: 100, cost: 6.56, payoffs: { stake: 0, ifBothHit: 0, ifConditionOnly: 0, conditionalPrice: null, hedged: false }, legs: [order({}), order({ role: 'unwind', side: 'sell', avgPrice: 0.4672, clientOrderId: 'gv-x-ub' })] });

  it('is a finished bet with a real loss, not one that never happened', () => {
    const b = unwound();
    expect(outcomeOf(b)).toBe('unwound');
    expect(isOpen(b)).toBe(false);
    expect(matches(b, 'settled')).toBe(true);
    expect(matches(b, 'open')).toBe(false);
  });

  it('stakes what its first order bought, returns what it was sold for, and nets the loss', () => {
    const b = unwound();
    expect(boughtOf(b)).toBeCloseTo(100, 8);
    expect(stakeOf(b)).toBeCloseTo(100, 8);
    const r = realised(b)!;
    expect(r.pnl).toBeCloseTo(-6.56, 8);
    expect(r.payout).toBeCloseTo(93.44, 8);
  });

  it('is counted in staked, returned and net, and as finished', () => {
    const t = summarize([unwound(), bet({ id: 'w', cost: 10, requestedStake: 10, ...settled(14, 24) })]);
    expect(t.count).toBe(2);
    expect(t.notPlaced).toBe(0);
    expect(t.settled).toBe(2);
    expect(t.staked).toBeCloseTo(110, 8);
    expect(t.returned).toBeCloseTo(117.44, 8);
    // The account is $6.56 down on the unwound bet and $14 up on the winner: the net is what the account shows.
    expect(t.net).toBeCloseTo(14 - 6.56, 8);
  });

  it('adds into a basket’s stake and net like any other leg', () => {
    const e = groupBets([bet({ id: 'a', basket: { id: 'k', index: 0, size: 2 }, cost: 10, requestedStake: 10, ...settled(14, 24) }), { ...unwound('b'), basket: { id: 'k', index: 1, size: 2 } }])[0]!;
    if (e.type !== 'basket') throw new Error('not a basket');
    const s = basketSummary(e);
    expect(s.stake).toBeCloseTo(110, 8);
    expect(s.net).toBeCloseTo(7.44, 8);
    expect(s.done).toBe(true);
  });

  it('a bet that bought nothing is still left out of the money', () => {
    const t = summarize([bet({ id: 'f', cost: 0, status: 'failed', legs: [] })]);
    expect(t).toMatchObject({ count: 1, notPlaced: 1, staked: 0, returned: 0, net: 0 });
  });

  it('never reports less bought than it cost, whatever its orders say', () => {
    expect(boughtOf({ cost: 8, legs: [] })).toBe(8);
    expect(boughtOf({ cost: 8 })).toBe(8);
    expect(boughtOf({ cost: 8, legs: [order({ quantityFilled: 1, avgPrice: 0.5 })] })).toBe(8);
  });
});

describe('a bet with only its first order in place', () => {
  const half = (over: Partial<Bet> = {}) => bet({ id: 'h', status: 'unhedged', ...over });

  it('is open to the list and the filter, and says what is missing', () => {
    expect(isOpen(half())).toBe(true);
    expect(matches(half(), 'open')).toBe(true);
    expect(matches(half(), 'settled')).toBe(false);
    expect(summarize([half()]).open).toBe(1);
    expect(unprotectedWords(half())).toBe('Only the first order went through, so your stake does not come back if the first level fails. You can sell it back.');
    // A Range and a Breakout have no stake back to lose: they say only that half of the bet is in.
    expect(unprotectedWords(half({ product: 'range' }))).toBe('Only the first order went through, so this bet is only half placed. You can sell it back.');
    expect(unprotectedWords(half({ product: 'breakout' }))).toBe('Only the first order went through, so this bet is only half placed. You can sell it back.');
  });

  it('never reads as an ordinary open bet or promises a win', () => {
    const said = `${statusWords(half())} ${unprotectedWords(half())}`;
    expect(said).not.toMatch(/\bOpen\b|Wins|guarantee/);
  });

  it('says so differently when part of it has been sold', () => {
    const partly = half({ cashOut: { at: '', stake: 10, proceeds: 4.2, pnl: -0.8, complete: false } });
    expect(unprotectedWords(partly)).toBe('Part of this bet was sold for $4.20 so far. You can sell the rest.');
  });

  it('an open bet that has been partly sold says what was sold and that the rest is open', () => {
    const partly = bet({ id: 'p', cashOut: { at: '', stake: 10, proceeds: 4.2, pnl: -0.8, complete: false } });
    expect(partSoldWords(partly)).toBe('Part of this bet was sold for $4.20 so far. The rest is still open.');
    expect(partSoldWords(bet({ id: 'p' }))).toBeNull();
    expect(partSoldWords(bet({ id: 'p', status: 'cashed_out', cashOut: { at: '', stake: 10, proceeds: 9.2, pnl: -0.8, complete: true } }))).toBeNull();
  });
});

// ------------------------------------------------------------------ an order nobody could confirm

describe('a bet with an order that has no confirmed result', () => {
  const unknownLeg = order({ status: 'unknown', quantityFilled: 0, avgPrice: null, note: 'socket closed; the exchange could not confirm what became of the order.' });
  const unknownNote = 'Gemini did not confirm one of this bet’s orders, so the bet may be partly or fully in place. Nothing more was sent. Check your Gemini account.';
  const held = (over: Partial<Bet> = {}) => bet({ id: 'u', status: 'unhedged', legs: [unknownLeg], note: unknownNote, ...over });

  it('is told apart from a bet that is only half placed, by the leg or by the executor’s note', () => {
    expect(isUnconfirmed(held())).toBe(true);
    expect(isUnconfirmed(held({ note: undefined }))).toBe(true); // the leg alone
    expect(isUnconfirmed(held({ legs: [order({})] }))).toBe(true); // the note alone
    expect(isUnconfirmed(bet({ id: 'a', status: 'unhedged', legs: [order({})] }))).toBe(false);
    expect(isUnconfirmed(bet({ id: 'a', legs: [] }))).toBe(false);
    expect(outcomeOf(held())).toBe('unconfirmed');
    expect(outcomeOf(bet({ id: 'a', status: 'unhedged', legs: [order({})] }))).toBe('unprotected');
  });

  it('a bet that was looked up again and found open no longer says it is not confirmed', () => {
    // The executor clears the note and the leg's status once it has read the order by its tag.
    expect(outcomeOf(held({ status: 'open', legs: [order({})], note: undefined }))).toBe('open');
  });

  it('reads "Not confirmed" on its chip, and is still an open, pending, placed bet', () => {
    expect(statusWords(held())).toBe('Not confirmed');
    expect(isOpen(held())).toBe(true);
    expect(matches(held(), 'open')).toBe(true);
    expect(matches(held(), 'settled')).toBe(false);
    expect(hasPending([held()])).toBe(true);
    expect(summarize([held()]).staked).toBe(10); // the money may well be in: it is not left out of the stake
  });

  it('says one plain thing, and never "sell it back" or "protected"', () => {
    expect(unconfirmedWords()).toBe('Gemini did not confirm one of this bet’s orders, so it may be partly or fully in place. Check your Gemini account.');
    expect(unconfirmedWords()).not.toMatch(/sell|protected|guarantee/i);
  });

  it('an order line says "Not confirmed" and not "0.00 YES shares ... at –, unknown"', () => {
    expect(fillWords(unknownLeg, { side: 'YES', strike: 1820 })).toBe('Not confirmed');
    expect(fillWords({ quantityFilled: 0, avgPrice: null, status: 'unfilled' }, { side: 'YES', strike: 1820 })).toBe('0.00 YES shares on $1,820 at –, did not go through');
  });
});

describe('the line under a revealed call', () => {
  it('says when it was revealed and its edge, once, and not the result again', () => {
    const said = revealedWords('2026-11-20T06:32:00.000Z', 0.18);
    expect(said).toMatch(/^Revealed on Solana, Nov 20, .+ · Edge \+0\.18 per \$1$/);
    expect(said).not.toMatch(/won|lost|finished|your call/i);
  });

  it('is one fragment without an edge or a time', () => {
    expect(revealedWords('2026-11-20T06:32:00.000Z', null)).not.toMatch(/Edge/);
    expect(revealedWords(null, 0.18)).toBe('Revealed on Solana · Edge +0.18 per $1');
    expect(revealedWords(undefined, undefined)).toBe('Revealed on Solana');
    expect(revealedWords('2026-11-20T06:32:00.000Z', Number.NaN)).not.toMatch(/NaN|Edge/);
  });
});

describe('a list with a bet that cannot be drawn', () => {
  it('leaves that record out and keeps the others, so one bad row cannot take the page down', () => {
    const good = bet({ id: 'good' });
    const noLegs = { ...bet({ id: 'nolegs' }), legs: undefined };
    const noCondition = { ...bet({ id: 'nocond' }), condition: undefined };
    const nullTarget = { ...bet({ id: 'nulltarget' }), target: null };
    const noId = { ...bet({ id: 'x' }), id: undefined };
    const out = usableBets([good, noLegs, noCondition, nullTarget, noId, null, 7, 'x']);
    expect(out.map((b) => b.id)).toEqual(['good', 'nolegs']);
    // A bet with no list of orders is a bet with no orders: it is drawn, with nothing to show under it.
    expect(out[1]!.legs).toEqual([]);
  });

  it('skips a hole in the list of orders and survives anything that is not a list', () => {
    const out = usableBets([{ ...bet({ id: 'a' }), legs: [null, order({})] }]);
    expect(out[0]!.legs).toHaveLength(1);
    expect(usableBets(undefined)).toEqual([]);
    expect(usableBets({ bets: [] })).toEqual([]);
  });
});
