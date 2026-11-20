import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { mockApi } from '../api/mock';
import type { Bet } from '../api/types';
import { cashOutProblem, cashOutRefusal, cashOutWords, sellingMeans } from '../components/CashOut';
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

describe('what a cash-out that did not go through says', () => {
  const refused = (status: number, code: string, error: string) => new ApiError(status, { error, code }, 'fallback');

  it('never shows the server\'s own words for a refusal it knows', () => {
    const raw = 'Selling now would bring in $9.36, below the $9.40 you asked for. Nothing was sold.';
    expect(cashOutProblem(refused(422, 'below_minimum', raw), 'selling')).toBe('The price moved, so nothing was sold. Check the price again.');
    expect(cashOutProblem(refused(422, 'nothing_sold', 'The sell order failed (HTTP 500). The bet is unchanged.'), 'selling')).toBe('The price moved before the order arrived, so nothing was sold. Your bet is unchanged.');
    expect(cashOutProblem(refused(409, 'not_open', 'This bet is "settled", so there is nothing to sell.'), 'selling')).toBe('This bet is no longer open, so there is nothing to sell.');
  });

  it('says a sale was refused, never that a bet was', () => {
    // The same codes on a bet being placed say "Nothing was bought", which is not what happened here.
    for (const code of ['market_closed', 'insufficient_depth', 'no_bid', 'position_netted']) {
      const words = cashOutProblem(refused(422, code, 'raw'), 'selling');
      expect(words).not.toMatch(/bought|raw/);
      expect(words).toMatch(/cannot be sold|to sell the whole bet/);
    }
  });

  it('a server that does not know cash-out says so in plain words', () => {
    const words = cashOutProblem(refused(404, 'not_found', 'No such endpoint: /cashout. Try /health, /markets, /quote, /bets, /baskets, /settle, /flow or /reconcile.'), 'pricing');
    expect(words).toBe('Cash out is not available on this server right now. Your bet is unchanged.');
  });

  it('with no answer, says nothing was sold only when nothing could have been', () => {
    const lost = new ApiError(0, null, 'Cannot reach the server. Check your connection and try again.');
    expect(cashOutProblem(lost, 'pricing')).toMatch(/Nothing was sold/);
    // A sale that got no answer may have gone through.
    expect(cashOutProblem(lost, 'selling')).not.toMatch(/Nothing was sold|unchanged/);
    expect(cashOutProblem(lost, 'selling')).toMatch(/could not confirm the sale/);
    expect(cashOutProblem(refused(502, 'bad_gateway', 'Bad gateway'), 'selling')).toMatch(/could not confirm the sale/);
  });

  it('a paused server and a bet that is not there are named', () => {
    expect(cashOutProblem(refused(503, 'paused', 'Betting is paused for a moment. Try again soon.'), 'selling')).toBe('Selling is paused for a moment. Nothing was sold. Try again soon.');
    expect(cashOutProblem(refused(404, 'unknown_bet', 'No bet "x".'), 'pricing')).toBe('We could not find this bet. Reload the page and try again.');
  });

  it('a quote that cannot be sold reads by its code, with a plain line for one it does not know', () => {
    expect(cashOutRefusal({ code: 'no_bid' })).toBe('We could not find a buyer for this bet just now, so it cannot be sold. Try again in a moment.');
    expect(cashOutRefusal({ code: null })).toBe('This bet cannot be sold right now.');
  });
});

describe('the sentence that says what selling means', () => {
  const two = { legs: [{ quantity: 12 }, { quantity: 30 }] } as Parameters<typeof sellingMeans>[1];

  it('a parlay gives up its win and its refund', () => {
    expect(sellingMeans({}, two)).toBe('Selling sends two sell orders at the prices on offer now: you give up both the win and the stake coming back, and the call you made can still be revealed once the market settles.');
    expect(sellingMeans({ product: 'parlay', direction: 'down' }, two)).toMatch(/both the win and the stake coming back/);
  });

  it('a range or a breakout has no refund to give up', () => {
    for (const product of ['range', 'breakout'] as const) {
      const words = sellingMeans({ product }, two);
      expect(words).toMatch(/two sell orders/);
      expect(words).toMatch(/you give up what the bet could still pay/);
      expect(words).not.toMatch(/stake coming back/);
    }
  });

  it('a bet holding one order says one, and promises no refund it does not have', () => {
    const one = { legs: [{ quantity: 12 }, { quantity: 0 }] } as Parameters<typeof sellingMeans>[1];
    const words = sellingMeans({ product: 'parlay' }, one);
    expect(words).toMatch(/one sell order at the price on offer now/);
    expect(words).not.toMatch(/stake coming back/);
  });

  it('never promises anything', () => {
    expect(sellingMeans({}, two)).not.toMatch(/guarantee|risk-free/i);
  });
});

describe('the demo data', () => {
  // The demo's prices drift with the clock so the page moves while you watch. A test that reads the market and then asks
  // for a quote could land either side of a tick and compare two different prices (it failed about one run in four), so the
  // clock is held still here. Only `Date.now` is held: the demo's own short waits still run.
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 19, 16, 20, 0));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('places a breakout as the executor records one, and can sell it back from its two orders like any other bet', async () => {
    const api = mockApi();
    const { events } = await api.markets();
    const ev = events[0]!;
    // A band the demo's own rule offers a breakout on. Which bands pass depends on where the demo's prices are, so the test
    // asks rather than assumes: the widest bands first, since a breakout on a wide band is the cheaper, likelier-offered one.
    const rungs = [...ev.rungs].filter((r) => r.bid !== null && r.ask !== null).sort((a, b) => a.strike - b.strike);
    const mid = (r: { bid: number | null; ask: number | null }) => (r.bid! + r.ask!) / 2;
    const bands = rungs.flatMap((lo, i) => rungs.slice(i + 1).map((hi) => ({ low: lo, high: hi }))).sort((a, b) => b.high.strike - b.low.strike - (a.high.strike - a.low.strike));
    let found: { low: (typeof rungs)[number]; high: (typeof rungs)[number]; q: Awaited<ReturnType<typeof api.quoteBreakout>> } | null = null;
    for (const band of bands) {
      const quote = await api.quoteBreakout({ event: ev.ticker, low: band.low.symbol, high: band.high.symbol, stake: 10 });
      if (quote.quote.offerable) {
        found = { ...band, q: quote };
        break;
      }
    }
    expect(found, 'the demo ladder offers a breakout on at least one band').not.toBeNull();
    const { low, high, q } = found!;
    expect(q.product).toBe('breakout');
    expect(q.quote.offerable).toBe(true);
    expect(q.quote.chanceOutside).toBeCloseTo(1 - (mid(low) - mid(high)), 8);
    expect(q.quote.fairPrice).toBe(q.quote.chanceOutside);
    expect(q.quote.pricePaid).toBeCloseTo(1 - low.bid! + high.ask!, 8);
    expect(q.stake!.ifOutside).toBeCloseTo(q.stake!.contracts - q.stake!.cost, 8);
    expect(q.stake!.ifInRange).toBeCloseTo(-q.stake!.cost, 8);

    const { bet } = await api.placeBet({ product: 'breakout', user: 'primary', event: ev.ticker, low: low.symbol, high: high.symbol, stake: 10 });
    expect(bet.product).toBe('breakout');
    expect(bet.id.startsWith('bo-')).toBe(true);
    // Named as a range names them: the lower strike is the "condition", the higher the "target".
    expect([bet.condition.symbol, bet.target.symbol]).toEqual([low.symbol, high.symbol]);
    const [first, second] = bet.legs;
    expect(first).toMatchObject({ role: 'outcome', side: 'buy', outcome: 'yes', symbol: high.symbol });
    expect(second).toMatchObject({ role: 'hedge', side: 'buy', outcome: 'no', symbol: low.symbol });
    expect(first!.quantityFilled).toBe(second!.quantityFilled);
    expect(bet.payoffs).toMatchObject({ ifOutside: bet.payoffs!.ifBothHit, ifInRange: bet.payoffs!.ifConditionOnly });
    expect(bet.payoffs!.ifConditionFails).toBeUndefined();
    expect(bet.payoffs!.ifInRange).toBeCloseTo(-bet.cost, 8);
    expect(bet.payoffs!.ifOutside).toBeCloseTo(first!.quantityFilled - bet.cost, 8);
    expect(outcomeOf(bet)).toBe('open');
    expect(orderLine(bet, first!)).toMatchObject({ label: 'Order 1', side: 'YES', strike: high.strike });
    expect(orderLine(bet, second!)).toMatchObject({ label: 'Order 2', side: 'NO', strike: low.strike });

    const sale = await api.cashOutQuote(bet.id);
    expect(sale.available).toBe(true);
    expect(sale.legs.map((l) => [l.role, l.outcome, l.symbol])).toEqual([
      ['outcome', 'yes', high.symbol],
      ['hedge', 'no', low.symbol],
    ]);

    // Two levels the wrong way round are not a breakout, and one that is all but sure to win is refused, not placed.
    await expect(api.quoteBreakout({ event: ev.ticker, low: high.symbol, high: low.symbol })).rejects.toMatchObject({ status: 400 });
    await expect(api.placeBet({ product: 'breakout', user: 'primary', event: ev.ticker, low: rungs[0]!.symbol, high: rungs[1]!.symbol, stake: 10 })).rejects.toMatchObject({ status: 422, body: { refused: true } });
  }, 15_000);

  it('gives every seeded result a finishing price that agrees with it', async () => {
    const api = mockApi();
    const { bets } = await api.bets();
    const settled = bets.filter((b) => b.status === 'settled');
    expect(settled.length).toBeGreaterThanOrEqual(5);
    for (const b of settled) {
      const at = b.settlement!.finishedAt!;
      const [lo, hi] = [Math.min(b.condition.strike, b.target.strike), Math.max(b.condition.strike, b.target.strike)];
      const inside = at >= lo && at < hi;
      const o = outcomeOf(b);
      if (b.product === 'range') expect(inside).toBe(o === 'won');
      else if (b.product === 'breakout') expect(inside).toBe(o === 'lost');
      // A rising parlay: at or above its target for a win, below its condition for a refund, between them for a loss.
      else expect(at >= hi ? 'won' : at < lo ? 'back' : 'lost').toBe(o);
    }
  });

  it('seeds a settled breakout that lost, so the demo shows the bet with no money back', async () => {
    const api = mockApi();
    const { bets } = await api.bets();
    const seeded = bets.find((b) => b.product === 'breakout' && b.status === 'settled');
    expect(seeded, 'the demo data has a settled breakout').toBeTruthy();
    expect(seeded!.settlement).toMatchObject({ conditionResolved: 'yes', targetResolved: 'no', payout: 0 });
    expect(seeded!.settlement!.pnl).toBeCloseTo(-seeded!.cost, 2);
    expect(statusWords(seeded!)).toBe('Finished inside');
    // Where it says the price ended agrees with the result: between the two levels.
    expect(seeded!.settlement!.finishedAt).toBeGreaterThanOrEqual(seeded!.condition.strike);
    expect(seeded!.settlement!.finishedAt).toBeLessThan(seeded!.target.strike);
    const { calls } = await api.calls();
    expect(calls.find((c) => c.betId === seeded!.id)?.reveal).toMatchObject({ outcome: 0 });
  });
});
