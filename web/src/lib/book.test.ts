import { describe, expect, it } from 'vitest';
import type { Bet, MarketEvent, Rung } from '../api/types';
import { betPay, extremes } from './basketPays';
import { bookIntro, bookOf, countWords, figureParts, leftOutWords, marketWords, moreWords, openBets, SHOWN_FIRST, splitMarkets, stretchesAt, waitingWords } from './book';

const rung = (strike: number, chance: number, spread = 0.01): Rung => ({ symbol: `S${strike}`, label: `$${strike}`, strike, bid: chance - spread, ask: chance + spread, open: true, state: 'active/open' });

type Event = Pick<MarketEvent, 'ticker' | 'title' | 'expiry' | 'rungs'>;
type TestBet = Pick<Bet, 'id' | 'status' | 'settlement' | 'cashOut' | 'eventTicker' | 'product' | 'direction' | 'condition' | 'target' | 'payoffs'>;

// Chances of finishing at or above: 62,000 92%, 62,500 82%, 63,000 62%, 63,500 41%, 64,000 20%.
// So the bars, lowest first, hold 8%, 10%, 20%, 21%, 21% and 20%.
const btc: Event = { ticker: 'BTC2611202100', title: 'BTC price today at 4pm EST', expiry: '2026-11-20T21:00:00.000Z', rungs: [rung(62000, 0.92), rung(62500, 0.82), rung(63000, 0.62), rung(63500, 0.41), rung(64000, 0.2)] };
const eth: Event = { ticker: 'ETH2611202000', title: 'ETH price today at 3pm EST', expiry: '2026-11-20T20:00:00.000Z', rungs: [rung(1800, 0.8), rung(1820, 0.6), rung(1840, 0.4)] };
const sol: Event = { ticker: 'SOL2611202200', title: 'SOL price today at 5pm EST', expiry: '2026-11-20T22:00:00.000Z', rungs: [rung(140, 0.7), rung(142, 0.5), rung(144, 0.3)] };

const level = (strike: number) => ({ symbol: `S${strike}`, label: `$${strike}`, strike });
const nets = (win: number, lose: number, back?: number): NonNullable<Bet['payoffs']> => ({ stake: -lose, ifBothHit: win, ifConditionOnly: lose, ...(back === undefined ? {} : { ifConditionFails: back }), conditionalPrice: 0.5, hedged: true });

let made = 0;
const bet = (over: Partial<TestBet>): TestBet => ({ id: `bet${++made}`, status: 'open', eventTicker: btc.ticker, condition: level(62500), target: level(63500), payoffs: nets(10, -10, 0), ...over });

/** Rising: stake back below 62,500, loses up to 63,500, wins from there. */
const parlay = () => bet({});
/** Wins between 63,000 and 64,000. */
const range = () => bet({ product: 'range', condition: level(63000), target: level(64000), payoffs: nets(6, -4) });
/** Wins outside 63,000 to 64,000. */
const breakout = () => bet({ product: 'breakout', condition: level(63000), target: level(64000), payoffs: nets(5, -8) });
const ethRange = () => bet({ eventTicker: eth.ticker, product: 'range', condition: level(1800), target: level(1840), payoffs: nets(7.5, -2.5) });
const solRange = () => bet({ eventTicker: sol.ticker, product: 'range', condition: level(140), target: level(144), payoffs: nets(4, -6) });

const settled = (b: TestBet): TestBet => ({ ...b, status: 'settled', settlement: { conditionResolved: 'yes', targetResolved: 'yes', payout: 20, pnl: 10, settledAt: '2026-11-20T21:00:05.000Z' } });

const netsOf = (book: ReturnType<typeof bookOf>, i = 0) => book.markets[i]!.curve.bars.map((b) => b.net);

describe('which bets are open', () => {
  it('keeps the bets still running, and only those', () => {
    const open = bet({});
    const oneOrder = bet({ status: 'unhedged' });
    const others: TestBet[] = [
      settled(bet({})),
      bet({ status: 'cashed_out', cashOut: { at: '2026-11-20T19:00:00.000Z', stake: 10, proceeds: 8, pnl: -2, complete: true } }),
      bet({ status: 'failed' }),
      bet({ status: 'unwound' }),
      bet({ status: 'needs_review' }),
    ];
    expect(openBets([open, ...others, oneOrder])).toEqual([open, oneOrder]);
  });

  it('does not count a bet whose orders are still on their way', () => {
    expect(openBets([bet({ status: 'placing', payoffs: undefined })])).toEqual([]);
  });
});

describe('the open bets, market by market', () => {
  it('adds up the bets on one market, bar by bar', () => {
    const [a, b] = [parlay(), range()];
    const book = bookOf([a, b], [btc]);
    expect(book.open).toBe(2);
    expect(book.leftOut).toBe(0);
    expect(book.markets).toHaveLength(1);
    const m = book.markets[0]!;
    expect(m.event).toBe(btc);
    expect(m.bets).toEqual([a, b]);
    expect(m.waiting).toBe(0);
    // parlay: 0, 0, −10, −10, +10, +10. range: −4, −4, −4, +6, +6, −4.
    expect(netsOf(book)).toEqual([-4, -4, -14, -4, 16, 6]);
    expect(m.curve.bars.map((x) => x.bucket.chance)).toEqual([0.08, 0.1, 0.2, 0.21, 0.21, 0.2]);
    expect(m.curve.ahead).toBeCloseTo(0.41, 8);
    expect(m.curve.behind).toBeCloseTo(0.59, 8);
    expect([m.curve.best, m.curve.worst]).toEqual([16, -14]);
  });

  it('gives the same best and worst as the strikes alone do', () => {
    for (const bets of [[parlay(), range()], [range(), breakout()], [parlay(), range(), breakout()], [parlay()]]) {
      const m = bookOf(bets, [btc]).markets[0]!;
      const e = extremes(bets.map(betPay))!;
      expect([m.curve.best, m.curve.worst]).toEqual([e.best, e.worst]);
    }
  });

  it('still shows a market that holds a single bet', () => {
    const book = bookOf([parlay()], [btc, eth]);
    expect(book.markets).toHaveLength(1);
    expect(book.markets[0]!.bets).toHaveLength(1);
    expect(netsOf(book)).toEqual([0, 0, -10, -10, 10, 10]);
  });

  it('keeps bets on two markets apart, each with its own chart', () => {
    const [a, b, c] = [parlay(), ethRange(), range()];
    const book = bookOf([a, b, c], [btc, eth]);
    expect(book.markets.map((m) => m.event.ticker)).toEqual([eth.ticker, btc.ticker]);
    expect(book.markets[0]!.bets).toEqual([b]);
    expect(book.markets[1]!.bets).toEqual([a, c]);
    // The Ethereum range on its own: wins between 1,800 and 1,840.
    expect(netsOf(book, 0)).toEqual([-2.5, 7.5, 7.5, -2.5]);
    // Bitcoin is the two bets on it added up, with nothing of Ethereum's in it.
    expect(netsOf(book, 1)).toEqual([-4, -4, -14, -4, 16, 6]);
    expect(book.markets[1]!.pays).toEqual([betPay(a), betPay(c)]);
  });

  it('leaves out bets that are no longer open', () => {
    const book = bookOf([parlay(), settled(range()), bet({ status: 'cashed_out' }), bet({ status: 'failed' }), bet({ status: 'unwound' })], [btc]);
    expect(book.open).toBe(1);
    expect(book.markets[0]!.bets).toHaveLength(1);
    expect(netsOf(book)).toEqual([0, 0, -10, -10, 10, 10]);
  });

  it('has nothing in it when no bet is open', () => {
    expect(bookOf([], [btc])).toEqual({ markets: [], open: 0, leftOut: 0 });
    expect(bookOf([settled(parlay())], [btc])).toEqual({ markets: [], open: 0, leftOut: 0 });
  });

  it('follows a bet as it settles', () => {
    const [a, b] = [parlay(), range()];
    expect(netsOf(bookOf([a, b], [btc]))).toEqual([-4, -4, -14, -4, 16, 6]);
    const after = bookOf([settled(a), b], [btc]);
    expect(after.markets[0]!.bets).toEqual([b]);
    expect(netsOf(after)).toEqual([-4, -4, -4, 6, 6, -4]);
    expect(bookOf([settled(a), settled(b)], [btc]).markets).toEqual([]);
  });

  it('follows the prices as they move: the results stay, the chances change', () => {
    const bets = [parlay(), range()];
    const before = bookOf(bets, [btc]).markets[0]!.curve;
    // The price has risen: every level is now likelier to be reached.
    const risen: Event = { ...btc, rungs: [rung(62000, 0.97), rung(62500, 0.93), rung(63000, 0.83), rung(63500, 0.63), rung(64000, 0.42)] };
    const after = bookOf(bets, [risen]).markets[0]!.curve;
    expect(after.bars.map((b) => b.net)).toEqual(before.bars.map((b) => b.net));
    expect(before.ahead).toBeCloseTo(0.41, 8);
    expect(after.ahead).toBeCloseTo(0.63, 8);
    expect([after.best, after.worst]).toEqual([before.best, before.worst]);
  });
});

describe('a bet with no prices to count it by', () => {
  it('leaves out a bet whose market is no longer listed, and says how many', () => {
    const gone = bet({ eventTicker: 'BTC2611201900' });
    const [a, b] = [parlay(), range()];
    const book = bookOf([gone, a, b], [btc, eth]);
    expect(book.open).toBe(3);
    expect(book.leftOut).toBe(1);
    expect(book.markets).toHaveLength(1);
    expect(book.markets[0]!.bets).toEqual([a, b]);
    expect(netsOf(book)).toEqual([-4, -4, -14, -4, 16, 6]);
  });

  it('leaves out a bet whose market has no prices', () => {
    const dark: Event = { ...eth, rungs: eth.rungs.map((r) => ({ ...r, bid: null, ask: null })) };
    const book = bookOf([parlay(), ethRange()], [btc, dark]);
    expect(book.markets.map((m) => m.event.ticker)).toEqual([btc.ticker]);
    expect(book.leftOut).toBe(1);
    // One price is not a ladder either.
    const thin: Event = { ...eth, rungs: [rung(1800, 0.8), { ...rung(1820, 0.6), ask: null }, { ...rung(1840, 0.4), bid: null }] };
    expect(bookOf([ethRange()], [thin])).toEqual({ markets: [], open: 1, leftOut: 1 });
  });

  it('draws no market when every open bet is left out', () => {
    const book = bookOf([bet({ eventTicker: 'GONE1' }), bet({ eventTicker: 'GONE2' })], [btc]);
    expect(book).toEqual({ markets: [], open: 2, leftOut: 2 });
  });

  it('counts a bet under its own market when only its level has no price', () => {
    // 63,500 has lost its sell price, so it is no longer an edge of a bar: the parlay on it cannot be judged, the range can.
    const patchy: Event = { ...btc, rungs: btc.rungs.map((r) => (r.strike === 63500 ? { ...r, ask: null } : r)) };
    const [a, b] = [parlay(), range()];
    const book = bookOf([a, b], [patchy]);
    expect(book.markets[0]!.bets).toEqual([b]);
    expect(book.markets[0]!.waiting).toBe(1);
    expect(book.leftOut).toBe(0);
  });

  it('leaves out a bet that carries no figures', () => {
    const bare = bet({ payoffs: undefined });
    expect(bookOf([bare], [btc])).toEqual({ markets: [], open: 1, leftOut: 1 });
    const book = bookOf([bare, range()], [btc]);
    expect(book.markets[0]!.bets).toHaveLength(1);
    expect(book.markets[0]!.waiting).toBe(1);
    expect(book.leftOut).toBe(0);
  });
});

describe('the order of the markets', () => {
  it('is by closing time, soonest first, however the bets are listed', () => {
    const book = bookOf([solRange(), parlay(), range(), ethRange()], [sol, btc, eth]);
    expect(book.markets.map((m) => m.event.ticker)).toEqual([eth.ticker, btc.ticker, sol.ticker]);
  });

  it('puts the market with more bets first of two that close together, then goes by ticker', () => {
    const together = [btc, eth, sol].map((e) => ({ ...e, expiry: '2026-11-20T21:00:00.000Z' }));
    expect(bookOf([solRange(), ethRange(), parlay(), range()], together).markets.map((m) => m.event.ticker)).toEqual([btc.ticker, eth.ticker, sol.ticker]);
    expect(bookOf([solRange(), ethRange(), parlay()], together).markets.map((m) => m.event.ticker)).toEqual([btc.ticker, eth.ticker, sol.ticker]);
  });

  it('puts a market with no close time last', () => {
    const book = bookOf([parlay(), ethRange()], [{ ...eth, expiry: null }, btc]);
    expect(book.markets.map((m) => m.event.ticker)).toEqual([btc.ticker, eth.ticker]);
    expect(bookOf([parlay(), ethRange()], [{ ...eth, expiry: 'soon' }, btc]).markets[1]!.event.ticker).toBe(eth.ticker);
  });

  it('shows the first two and folds the rest away', () => {
    expect(SHOWN_FIRST).toBe(2);
    expect(splitMarkets(['a', 'b'])).toEqual({ first: ['a', 'b'], rest: [] });
    expect(splitMarkets(['a', 'b', 'c', 'd'])).toEqual({ first: ['a', 'b'], rest: ['c', 'd'] });
    expect(splitMarkets([])).toEqual({ first: [], rest: [] });
    expect(moreWords(1)).toBe('1 more market');
    expect(moreWords(3)).toBe('3 more markets');
  });
});

describe('the finishing prices that give one result', () => {
  const curveOf = (...bets: TestBet[]) => bookOf(bets, [btc]).markets[0]!.curve;

  it('joins bars that sit side by side into one stretch, and adds up their chances', () => {
    const at = stretchesAt(curveOf(parlay()), 10);
    expect(at).toHaveLength(1);
    expect([at[0]!.from, at[0]!.to]).toEqual([63500, null]);
    expect(at[0]!.chance).toBeCloseTo(0.41, 8);
    const back = stretchesAt(curveOf(parlay()), 0);
    expect([back[0]!.from, back[0]!.to]).toEqual([null, 62500]);
    expect(back[0]!.chance).toBeCloseTo(0.18, 8);
  });

  it('keeps stretches apart when another result lies between them', () => {
    const at = stretchesAt(curveOf(breakout()), 5);
    expect(at.map((s) => [s.from, s.to])).toEqual([
      [null, 63000],
      [64000, null],
    ]);
    expect(at[0]!.chance).toBeCloseTo(0.38, 8);
    expect(at[1]!.chance).toBeCloseTo(0.2, 8);
    expect(stretchesAt(curveOf(breakout()), 123)).toEqual([]);
  });
});

describe('one market in words', () => {
  const words = (...bets: TestBet[]) => {
    const m = bookOf(bets, [btc]).markets[0]!;
    return marketWords(m.curve, m.pays, 'Bitcoin');
  };

  it('says how often two bets end ahead, then the best and the worst and the prices that give them', () => {
    const w = words(parlay(), range());
    expect(w.odds).toBe('Both bets together: ahead 41% of the time, behind 59%.');
    expect(w.reach).toBe('Best +$16.00 if Bitcoin finishes between $63,500 and $64,000 (21% chance). Worst −$14.00 if it finishes between $62,500 and $63,000 (20% chance).');
  });

  it('speaks for one bet on its own, calls a parlay’s level stretch what it is, and does not repeat a chance already given', () => {
    const w = words(parlay());
    expect(w.odds).toBe('This bet: ahead 41% of the time, stake back 18%, behind 41%.');
    // The best is every price that ends ahead and the worst every price that ends behind: their chances are in the line above.
    expect(w.reach).toBe('Best +$10.00 if Bitcoin finishes at $63,500 or above. Worst −$10.00 if it finishes between $62,500 and $63,500.');
    expect(words(range()).odds).toBe('This bet: ahead 42% of the time, behind 58%.');
  });

  it('names every stretch when a result comes at more than one', () => {
    const w = words(breakout());
    expect(w.odds).toBe('This bet: ahead 58% of the time, behind 42%.');
    expect(w.reach).toBe('Best +$5.00 if Bitcoin finishes below $63,000 or at $64,000 or above. Worst −$8.00 if it finishes between $63,000 and $64,000.');
    // Two narrow ranges with a gap between them: both lose below the first, in the gap, and above the second.
    const three = words(bet({ product: 'range', condition: level(62000), target: level(62500), payoffs: nets(6, -4) }), bet({ product: 'range', condition: level(63000), target: level(63500), payoffs: nets(6, -4) }));
    expect(three.reach).toBe('Best +$2.00 if Bitcoin finishes between $62,000 and $62,500 or between $63,000 and $63,500. Worst −$8.00 if it finishes below $62,000, between $62,500 and $63,000 or at $63,500 or above.');
  });

  it('counts three bets or more', () => {
    const w = words(parlay(), range(), breakout());
    expect(w.odds).toMatch(/^All 3 bets together: ahead /);
    // parlay + range + breakout: +1, +1, −9, −12, +8, +11.
    expect(w.reach).toBe('Best +$11.00 if Bitcoin finishes at $64,000 or above (20% chance). Worst −$12.00 if it finishes between $63,000 and $63,500 (21% chance).');
  });

  it('calls it level when several bets cancel out, and says so when they net the same everywhere', () => {
    // A range and a breakout on the same two levels, priced so each one's win is the other's loss.
    const w = words(range(), bet({ product: 'breakout', condition: level(63000), target: level(64000), payoffs: nets(4, -6) }));
    expect(w.odds).toBe('Both bets together: ahead 0% of the time, level 100%, behind 0%.');
    expect(w.reach).toBe('Wherever Bitcoin finishes, these bets net $0.00.');
  });

  it('never rounds a real chance away', () => {
    const m = bookOf([parlay(), range()], [btc]).markets[0]!;
    const rare = { ...m.curve, bars: m.curve.bars.map((b, i) => (i === 4 ? { ...b, bucket: { ...b.bucket, chance: 0.002 } } : b)), ahead: 0.202, behind: 0.798 };
    const w = marketWords(rare, m.pays, 'Bitcoin');
    expect(w.reach).toContain('between $63,500 and $64,000 (under 1% chance)');
    const sure = { ...m.curve, ahead: 0.998, level: 0, behind: 0.002 };
    expect(marketWords(sure, m.pays, 'Bitcoin').odds).toBe('Both bets together: ahead over 99% of the time, behind under 1%.');
  });

  it('prints shares that add up to 100', () => {
    const m = bookOf([parlay()], [btc]).markets[0]!;
    const curve = { ...m.curve, ahead: 0.376, level: 0.156, behind: 0.468 };
    expect(marketWords(curve, m.pays, 'Bitcoin').odds).toBe('This bet: ahead 38% of the time, stake back 15%, behind 47%.');
  });
});

describe('the sentences around the charts', () => {
  it('says what one chart shows', () => {
    expect(bookIntro(bookOf([parlay()], [btc]))).toBe('What your open bet nets at each price the market can finish at.');
    expect(bookIntro(bookOf([parlay(), range()], [btc]))).toBe('What your open bets on this market net together at each price it can finish at.');
  });

  it('says plainly that separate markets are not added together', () => {
    expect(bookIntro(bookOf([parlay(), ethRange()], [btc, eth]))).toBe(
      'What your open bets net at each price a market can finish at, with bets on the same market added together. Each market is decided by its own price, so the charts are not added together.',
    );
  });

  it('has no introduction when there is nothing to introduce', () => {
    expect(bookIntro(bookOf([bet({ eventTicker: 'GONE' })], [btc]))).toBeNull();
  });

  it('says in one sentence which open bets are not counted', () => {
    expect(leftOutWords(0, 2)).toBeNull();
    expect(leftOutWords(1, 2)).toBe('1 other open bet is left out: its market has no prices right now.');
    expect(leftOutWords(3, 1)).toBe('3 other open bets are left out: their markets have no prices right now.');
    expect(leftOutWords(1, 0)).toBe('Your open bet is not shown here: its market has no prices right now.');
    expect(leftOutWords(2, 0)).toBe('Your 2 open bets are not shown here: their markets have no prices right now.');
  });

  it('says so under a market when a bet on it is not in its chart', () => {
    expect(waitingWords(0)).toBeNull();
    expect(waitingWords(1)).toBe('1 more open bet on this market is left out: one of its levels has no price right now.');
    expect(waitingWords(2)).toBe('2 more open bets on this market are left out: some of their levels have no price right now.');
  });

  it('counts the bets a chart adds up', () => {
    expect(countWords(1)).toBe('1 bet');
    expect(countWords(2)).toBe('2 bets');
  });

  it('keeps to plain words', () => {
    const m = bookOf([parlay(), range()], [btc]).markets[0]!;
    const one = bookOf([parlay()], [btc]).markets[0]!;
    const said = [
      ...Object.values(marketWords(m.curve, m.pays, 'Bitcoin')),
      ...Object.values(marketWords(one.curve, one.pays, 'Bitcoin')),
      bookIntro(bookOf([parlay()], [btc])),
      bookIntro(bookOf([parlay(), range()], [btc])),
      bookIntro(bookOf([parlay(), ethRange()], [btc, eth])),
      leftOutWords(1, 0),
      leftOutWords(2, 1),
      waitingWords(1),
      waitingWords(2),
      moreWords(2),
    ].join(' ');
    expect(said).not.toMatch(/risk-free|guarantee|protected|buffer|volatil|portfolio|exposure|P&L|\bleg\b|\blegs\b/i);
  });
});

describe('a sentence cut at its figures', () => {
  it('sets apart signed results and chances, and leaves finishing prices in the text', () => {
    expect(figureParts('Best +$16.00 if Bitcoin finishes between $63,500 and $64,000 (21% chance). Worst −$1,014.00 if it finishes below $62,500.')).toEqual([
      'Best ',
      '+$16.00',
      ' if Bitcoin finishes between $63,500 and $64,000 (',
      '21%',
      ' chance). Worst ',
      '−$1,014.00',
      ' if it finishes below $62,500.',
    ]);
  });

  it('keeps "under 1%" and "over 99%" whole, and treats a result of nothing as a figure', () => {
    expect(figureParts('ahead over 99% of the time, behind under 1%.')).toEqual(['ahead ', 'over 99%', ' of the time, behind ', 'under 1%', '.']);
    expect(figureParts('these bets net $0.00.')).toEqual(['these bets net ', '$0.00', '.']);
    // A level priced in fractions of a cent is a price, not a result.
    expect(figureParts('below $0.005 or at $0.905 or above')).toEqual(['below $0.005 or at $0.905 or above']);
  });

  it('puts every figure at an odd place, so a page can tell them from the words', () => {
    const parts = figureParts('This bet: ahead 41% of the time, stake back 18%, behind 41%.');
    expect(parts.filter((_, i) => i % 2 === 1)).toEqual(['41%', '18%', '41%']);
    expect(parts.join('')).toBe('This bet: ahead 41% of the time, stake back 18%, behind 41%.');
  });
});
