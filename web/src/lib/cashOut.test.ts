import { describe, expect, it } from 'vitest';
import { mockApi } from '../api/mock';
import type { Bet } from '../api/types';
import { cashOutWords } from '../components/CashOut';
import { isPlaced, isSettled, matches, orderLine, outcomeOf, realised, stakeOf, statusWords, summarize } from './betsView';

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

/** A $10 bet sold back for $9.20. The executor's running cost is then what was lost: 80 cents. */
const cashed = bet({ id: 'c', status: 'cashed_out', cost: 0.8, cashOut: { at: '2026-11-19T11:00:00.000Z', stake: 10, proceeds: 9.2, pnl: -0.8, complete: true } });

describe('a bet that was cashed out', () => {
  it('reads as its own state, in words, and counts as finished', () => {
    expect(outcomeOf(cashed)).toBe('cashed');
    expect(statusWords(cashed)).toBe('Cashed out');
    expect(isPlaced(cashed)).toBe(true);
    expect(isSettled(cashed)).toBe(true);
    expect(matches(cashed, 'settled')).toBe(true);
    expect(matches(cashed, 'open')).toBe(false);
  });

  it('shows what it first cost as its stake, and the sale as what it paid', () => {
    expect(stakeOf(cashed)).toBe(10);
    expect(stakeOf(bet({ id: 'a' }))).toBe(10);
    expect(realised(cashed)).toEqual({ payout: 9.2, pnl: -0.8 });
  });

  it('adds up with the other bets: staked at cost, returned at the sale price', () => {
    const won = bet({ id: 'w', status: 'settled', settlement: { conditionResolved: 'yes', targetResolved: 'yes', payout: 24, pnl: 14, settledAt: '2026-11-19T14:00:00.000Z' } });
    const t = summarize([cashed, won, bet({ id: 'o' })]);
    expect(t.count).toBe(3);
    expect(t.open).toBe(1);
    expect(t.settled).toBe(2);
    expect(t.staked).toBeCloseTo(30);
    expect(t.returned).toBeCloseTo(33.2);
    expect(t.net).toBeCloseTo(13.2);
  });

  it('a bet sold in part and then settled pays the sale plus the settlement, against what it first cost', () => {
    const partThenSettled = bet({
      id: 'p',
      status: 'settled',
      cost: 2.5,
      cashOut: { at: '2026-11-19T11:00:00.000Z', stake: 10, proceeds: 7.5, pnl: -2.5, complete: false },
      settlement: { conditionResolved: 'no', targetResolved: 'no', payout: 6, pnl: 3.5, settledAt: '2026-11-19T14:00:00.000Z' },
    });
    expect(realised(partThenSettled)).toEqual({ payout: 13.5, pnl: 3.5 });
    expect(stakeOf(partThenSettled)).toBe(10);
  });

  it('describes its sell orders', () => {
    const line = orderLine(cashed, { role: 'cashout', symbol: 'GEMI-BTC-HI64000', outcome: 'yes', side: 'sell' });
    expect(line.label).toBe('Cashed out');
    expect(line.side).toBe('YES');
    expect(line.strike).toBe(64000);
  });
});

describe('the sentence under a cash-out price', () => {
  it('says how the sale compares with the cost, in dollars', () => {
    expect(cashOutWords({ proceeds: 9.2, stake: 10 })).toBe('$0.80 less than it cost.');
    expect(cashOutWords({ proceeds: 10.5, stake: 10 })).toBe('$0.50 more than it cost.');
    expect(cashOutWords({ proceeds: 10, stake: 10 })).toBe('The same as it cost.');
    expect(cashOutWords({ proceeds: null, stake: 10 })).toBe('');
  });
});

describe('the demo data', () => {
  it('quotes an open bet, sells it, and then refuses to sell it twice', async () => {
    const api = mockApi();
    const { bets } = await api.bets();
    const open = bets.find((b) => b.status === 'open');
    expect(open, 'the demo data has an open bet').toBeTruthy();
    const quote = await api.cashOutQuote(open!.id);
    expect(quote.available).toBe(true);
    expect(quote.legs).toHaveLength(2);
    expect(quote.proceeds).toBeGreaterThan(0);
    expect(quote.proceeds!).toBeLessThan(quote.stake);

    await expect(api.cashOut(open!.id, quote.proceeds! + 1)).rejects.toMatchObject({ status: 422, code: 'below_minimum' });
    const done = await api.cashOut(open!.id, quote.proceeds!);
    expect(done.bet.status).toBe('cashed_out');
    expect(done.cashOut).toMatchObject({ stake: quote.stake, proceeds: quote.proceeds, complete: true });
    expect(done.bet.legs.filter((l) => l.role === 'cashout')).toHaveLength(2);
    expect((await api.cashOutQuote(open!.id)).code).toBe('not_open');
    await expect(api.cashOut(open!.id)).rejects.toMatchObject({ status: 409, code: 'not_open' });
  }, 15_000);
});
