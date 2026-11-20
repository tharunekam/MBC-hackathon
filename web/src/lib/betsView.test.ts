import { describe, expect, it } from 'vitest';
import type { Bet } from '../api/types';
import { basketSummary, calledResult, callResult, canRevealCall, checkedWords, filterEntries, finishedWords, groupBets, hasPending, ifItComesOff, kindLabel, netLabel, orderIdWords, orderLine, outcomeOf, sellOrdersWords, soldCallWords, statusWords, summarize } from './betsView';

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
    expect(outcomeOf(bet({ id: 'a', status: 'unhedged' }))).toBe('open');
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
    expect(statusWords(bet({ id: 'rg-a', product: 'range', ...settled(6, 20) }))).toBe('Finished inside');
    expect(statusWords(bet({ id: 'rg-a', product: 'range', ...settled(-4, 10, 'yes', 'no') }))).toBe('Finished outside');
    expect(statusWords(bet({ id: 'bo-a', product: 'breakout', ...settled(6, 16) }))).toBe('Finished outside');
    expect(statusWords(bet({ id: 'bo-a', product: 'breakout', ...settled(-10, 0, 'yes', 'no') }))).toBe('Finished inside');
    expect(statusWords(bet({ id: 'a', status: 'needs_review' }))).toBe('Needs review');
    expect(statusWords(bet({ id: 'a' }))).toBe('Open');
  });

  it('tags a falling parlay as one', () => {
    expect(kindLabel({ product: 'parlay', direction: 'up' })).toBe('Return Parlay');
    expect(kindLabel({ product: 'parlay', direction: 'down' })).toBe('Return Parlay · falling');
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
    for (const product of ['parlay', 'range', 'breakout'] as const) {
      const b: Bet = { ...at(142.3), product };
      expect(finishedWords(b)).toBe('Finished at $142.30');
    }
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
    expect(soldCallWords(sold())).toBe('Its call can be revealed once the market settles.');
    expect(soldCallWords(sold(called('yes', 'yes')))).toBe('The market has since settled: it reached $64,000, so the call came off.');
    expect(soldCallWords(sold(called('yes', 'no')))).toBe('The market has since settled: it did not reach $64,000, so the call did not come off.');
    expect(soldCallWords(sold(called('no', 'no')))).toBe('The market has since settled: the first level failed, so this call does not count.');
    const falling = { direction: 'down' as const, condition: { symbol: 'hi', label: '', strike: 64000 }, target: { symbol: 'lo', label: '', strike: 62500 } };
    expect(soldCallWords(sold({ id: 'dn-c', ...falling, ...called('yes', 'yes') }))).toBe('The market has since settled: it fell below $62,500, so the call came off.');
    expect(soldCallWords(sold({ id: 'dn-c', ...falling, ...called('yes', 'no') }))).toBe('The market has since settled: it did not fall below $62,500, so the call did not come off.');
    expect(soldCallWords(sold({ id: 'rg-c', product: 'range', ...called('yes', 'yes') }))).toBe('The market has since settled: it finished between $62,500 and $64,000, so the call came off.');
    expect(soldCallWords(sold({ id: 'rg-c', product: 'range', ...called('yes', 'no') }))).toBe('The market has since settled: it finished outside $62,500 to $64,000, so the call did not come off.');
    expect(soldCallWords(sold({ id: 'bo-c', product: 'breakout', ...called('yes', 'yes') }))).toBe('The market has since settled: it finished outside $62,500 to $64,000, so the call came off.');
    expect(soldCallWords(sold({ id: 'bo-c', product: 'breakout', ...called('yes', 'no') }))).toBe('The market has since settled: it finished between $62,500 and $64,000, so the call did not come off.');
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
    expect(summarize([b])).toEqual({ count: 1, open: 0, settled: 1, staked: 10, returned: 9.2, net: -0.8 });
  });

  it('is something "Check results" can still change until its market has a result', () => {
    expect(hasPending([])).toBe(false);
    expect(hasPending([bet({ id: 'a', ...settled(14, 24) }), sold(called('yes', 'no'))])).toBe(false);
    expect(hasPending([bet({ id: 'a', ...settled(14, 24) }), sold()])).toBe(true);
    expect(hasPending([bet({ id: 'a' })])).toBe(true);
    expect(hasPending([bet({ id: 'a', status: 'needs_review' })])).toBe(true);
    expect(hasPending([bet({ id: 'a', status: 'failed' }), bet({ id: 'b', status: 'unwound' })])).toBe(false);
  });
});

describe('what "Check results" found', () => {
  it('counts what settled, and says when a sold-back bet’s call now has its result', () => {
    expect(checkedWords({ settled: 1, stillOpen: 0 })).toBe('1 bet settled.');
    expect(checkedWords({ settled: 3, called: 0, stillOpen: 2 })).toBe('3 bets settled.');
    expect(checkedWords({ settled: 0, called: 1, stillOpen: 0 })).toBe('The market behind 1 bet you sold back has settled, so its call can be revealed.');
    expect(checkedWords({ settled: 2, called: 2, stillOpen: 0 })).toBe('2 bets settled. The market behind 2 bets you sold back has settled, so their calls can be revealed.');
  });

  it('says so when there was nothing new', () => {
    expect(checkedWords({ settled: 0, stillOpen: 2 })).toBe('Nothing has closed yet. Markets settle a few seconds after they expire.');
    expect(checkedWords({ settled: 0, called: 0, stillOpen: 0 })).toBe('Everything is up to date.');
  });
});

describe('an order’s id', () => {
  it('is named, so a one-character id from the test exchange is not left floating', () => {
    expect(orderIdWords('1')).toBe('Order id 1');
    expect(orderIdWords('145236781203948571')).toBe('Order id 145236…8571');
    expect(orderIdWords(undefined)).toBe('No order id');
    expect(orderIdWords('')).toBe('No order id');
  });
});

describe('the four figures', () => {
  it('count placed bets, stake what they cost, and return and net only what is in', () => {
    const t = summarize([
      bet({ id: 'a', cost: 10, ...settled(14, 24) }),
      bet({ id: 'b', cost: 20, ...settled(0, 20, 'no', 'no') }),
      bet({ id: 'c', cost: 15, ...settled(-15, 0, 'yes', 'no') }),
      bet({ id: 'd', cost: 5 }),
      bet({ id: 'e', cost: 0, status: 'failed' }),
      bet({ id: 'f', cost: 8, status: 'unwound' }),
      bet({ id: 'g', cost: 10, status: 'needs_review' }),
      bet({ id: 'h', cost: 10, status: 'needs_review', review: { reason: 'x', resolved: { payout: 12, pnl: 2, recordedAt: '', note: '' } } }),
    ]);
    expect(t).toEqual({ count: 6, open: 1, settled: 5, staked: 70, returned: 56, net: 1 });
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
    const open = groupBets([leg('a', 0, { cost: 10 }), leg('b', 1, { cost: 12 })])[0]!;
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
