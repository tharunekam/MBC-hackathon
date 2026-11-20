import { describe, expect, it } from 'vitest';
import type { Bet } from '../api/types';
import { basketSummary, filterEntries, groupBets, ifItComesOff, kindLabel, orderLine, outcomeOf, statusWords, summarize } from './betsView';

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
    expect(statusWords(bet({ id: 'a', status: 'needs_review' }))).toBe('Needs review');
    expect(statusWords(bet({ id: 'a' }))).toBe('Open');
  });

  it('tags a falling parlay as one', () => {
    expect(kindLabel({ product: 'parlay', direction: 'up' })).toBe('Return Parlay');
    expect(kindLabel({ product: 'parlay', direction: 'down' })).toBe('Return Parlay · falling');
    expect(kindLabel({ product: 'range', direction: 'up' })).toBe('Range');
  });

  it('says what an open bet takes to pay, each way', () => {
    expect(ifItComesOff(bet({ id: 'a' }))).toEqual({ amount: 14, condition: 'if it reaches $64,000' });
    expect(ifItComesOff(bet({ id: 'dn-a', direction: 'down', target: { symbol: 't', label: 't', strike: 61000 } })).condition).toBe('if it falls below $61,000');
    const range = bet({ id: 'rg-a', product: 'range', payoffs: { stake: 10, ifBothHit: 6, ifConditionOnly: -4, ifInRange: 6, ifOutside: -4, conditionalPrice: 0.5, hedged: true } });
    expect(ifItComesOff(range)).toEqual({ amount: 6, condition: 'if it finishes inside' });
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
