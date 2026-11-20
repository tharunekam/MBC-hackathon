import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type {
  Bet,
  BreakoutQuoteResponse,
  MarketEvent,
  QuoteResponse,
  RangeQuoteResponse,
  Rung,
} from '../api/types';
import {
  LEG_MAX_STAKE,
  answerMatches,
  basketAttemptKey,
  basketsFromBets,
  basketButton,
  buildRequest,
  costNote,
  cryptoLegs,
  defaultLevels,
  defaultRange,
  firstOptions,
  legStatus,
  legsPointAWay,
  levelsValid,
  listed,
  pickMarket,
  refusedLeg,
  restFrom,
  secondOptions,
  seedLegs,
  sharedMarketNote,
  sharedMarkets,
  splitEvenly,
  splitWords,
  stripLegPrefix,
  ticketTop,
  totals,
  withFirst,
  type LegStatus,
} from './basket';

/** A ladder whose chance of finishing at or above each strike falls from 95% to 5% in steps of 15 points. */
function ladder(
  key: string,
  base: number,
  step: number,
  category = 'Crypto',
): MarketEvent {
  const chances = [0.95, 0.8, 0.65, 0.5, 0.35, 0.2, 0.05];
  const ticker = `${key}2611200200`;
  const rungs: Rung[] = chances.map((c, i) => ({
    symbol: `${ticker}-HI${base + i * step}`,
    label: '',
    strike: base + i * step,
    bid: Math.round((c - 0.01) * 100) / 100,
    ask: Math.round((c + 0.01) * 100) / 100,
    open: true,
    state: 'open',
  }));
  return {
    ticker,
    title: `${key} price today at 9pm EST`,
    category,
    expiry: '2026-11-20T02:00:00.000Z',
    rungs,
    ladderOutOfOrder: false,
    pairs: [],
    offerableCount: 0,
    refusedCount: 0,
    refusedByReason: {},
    down: { pairs: [], offerableCount: 0, refusedCount: 0 },
  };
}

const BTC = ladder('BTC', 60000, 500);
const ETH = ladder('ETH', 3000, 20);
const SOL = ladder('SOL', 140, 2);
/** A second Bitcoin market, closing an hour later. */
const BTC2 = { ...ladder('BTC', 60000, 500), ticker: 'BTC2611200300' };
const sym = (ev: MarketEvent, i: number) => ev.rungs[i]!.symbol;

describe('levels', () => {
  it('offers first levels that leave room for a second, in the direction of the leg', () => {
    expect(firstOptions(BTC, 'up').map((r) => r.strike)).toEqual([
      60000, 60500, 61000, 61500, 62000, 62500,
    ]);
    expect(firstOptions(BTC, 'down').map((r) => r.strike)).toEqual([
      63000, 62500, 62000, 61500, 61000, 60500,
    ]);
    expect(secondOptions(BTC, 'up', sym(BTC, 4)).map((r) => r.strike)).toEqual([
      62500, 63000,
    ]);
    expect(
      secondOptions(BTC, 'down', sym(BTC, 2)).map((r) => r.strike),
    ).toEqual([60500, 60000]);
    expect(secondOptions(BTC, 'range', 'nope')).toEqual([]);
  });

  it('keeps the second level when it is still in order, and moves it to the nearest one that is otherwise', () => {
    expect(withFirst(BTC, 'up', sym(BTC, 1), sym(BTC, 4))).toEqual({
      a: sym(BTC, 1),
      b: sym(BTC, 4),
    });
    expect(withFirst(BTC, 'up', sym(BTC, 4), sym(BTC, 2))).toEqual({
      a: sym(BTC, 4),
      b: sym(BTC, 5),
    });
    expect(withFirst(BTC, 'down', sym(BTC, 3), sym(BTC, 5))).toEqual({
      a: sym(BTC, 3),
      b: sym(BTC, 2),
    });
  });

  it('checks that levels exist and are in order', () => {
    expect(levelsValid(BTC, 'up', sym(BTC, 1), sym(BTC, 3))).toBe(true);
    expect(levelsValid(BTC, 'down', sym(BTC, 1), sym(BTC, 3))).toBe(false);
    expect(levelsValid(BTC, 'range', sym(BTC, 1), 'gone')).toBe(false);
    expect(levelsValid(undefined, 'up', sym(BTC, 1), sym(BTC, 3))).toBe(false);
  });

  it('starts a range on the pair with a chance inside closest to 45 percent', () => {
    const r = defaultRange(BTC)!;
    const lo = BTC.rungs.find((x) => x.symbol === r.a)!;
    const hi = BTC.rungs.find((x) => x.symbol === r.b)!;
    const inside = (lo.bid! + lo.ask!) / 2 - (hi.bid! + hi.ask!) / 2;
    expect(inside).toBeGreaterThanOrEqual(0.4);
    expect(inside).toBeLessThanOrEqual(0.5);
  });

  it('starts every kind of leg on levels in order', () => {
    for (const kind of ['up', 'down', 'range'] as const) {
      const lv = defaultLevels(BTC, kind)!;
      expect(levelsValid(BTC, kind, lv.a, lv.b)).toBe(true);
    }
  });

  it('starts a breakout on two levels in order, with about an even chance of finishing outside them', () => {
    const lv = defaultLevels(BTC, 'breakout')!;
    expect(levelsValid(BTC, 'breakout', lv.a, lv.b)).toBe(true);
    const lo = BTC.rungs.find((x) => x.symbol === lv.a)!;
    const hi = BTC.rungs.find((x) => x.symbol === lv.b)!;
    const outside = 1 - ((lo.bid! + lo.ask!) / 2 - (hi.bid! + hi.ask!) / 2);
    expect(outside).toBeGreaterThan(0.39);
    expect(outside).toBeLessThan(0.61);
    // The same levels a range takes are in order for a breakout, and the options run the same way.
    expect(firstOptions(BTC, 'breakout')).toEqual(firstOptions(BTC, 'range'));
    expect(secondOptions(BTC, 'breakout', sym(BTC, 4))).toEqual(
      secondOptions(BTC, 'range', sym(BTC, 4)),
    );
  });

  it('starts a range on the middle strikes when nothing has prices', () => {
    const bare = {
      ...BTC,
      rungs: BTC.rungs.map((r) => ({ ...r, bid: null, ask: null })),
    };
    expect(defaultRange(bare)).toEqual({ a: sym(BTC, 2), b: sym(BTC, 3) });
  });
});

describe('markets for legs', () => {
  it('puts a new leg on an asset no leg uses yet', () => {
    expect(pickMarket([BTC, ETH, SOL], [BTC.ticker, ETH.ticker])?.ticker).toBe(
      SOL.ticker,
    );
    // A market no leg uses, when there is one on an asset a leg is already on.
    expect(pickMarket([BTC, BTC2, ETH], [BTC.ticker, ETH.ticker])?.ticker).toBe(BTC2.ticker);
    expect(pickMarket([], [])).toBeUndefined();
  });

  it('never hands back a market a leg already uses: with none left there is nothing to pick', () => {
    // The first market would be a copy of the first leg, so Add a leg is turned off rather than copying it.
    expect(pickMarket([BTC, ETH, SOL], [BTC.ticker, ETH.ticker, SOL.ticker])).toBeUndefined();
    expect(pickMarket([BTC], [BTC.ticker])).toBeUndefined();
    expect(pickMarket([BTC, ETH], [ETH.ticker, BTC.ticker, null])).toBeUndefined();
  });

  it('seeds a rising parlay and a range on the first two assets, or both on one asset when there is only one', () => {
    const two = seedLegs([BTC, ETH, SOL], 30);
    expect(two.map((l) => [l.kind, l.event, l.stake])).toEqual([
      ['up', BTC.ticker, 15],
      ['range', ETH.ticker, 15],
    ]);
    const one = seedLegs([BTC], 25);
    expect(one.map((l) => [l.kind, l.event, l.stake])).toEqual([
      ['up', BTC.ticker, 12.5],
      ['range', BTC.ticker, 12.5],
    ]);
    expect(seedLegs([], 30)).toEqual([]);
    expect(new Set(two.map((l) => l.key)).size).toBe(2);
  });

  it('finds the legs that are on a market another leg is on too, in the order they are placed', () => {
    const [b, e, s] = [BTC.ticker, ETH.ticker, SOL.ticker];
    expect(sharedMarkets([b, e, s])).toEqual([]);
    expect(sharedMarkets([b, b])).toEqual([[0, 1]]);
    expect(sharedMarkets([b, e, b, s, b])).toEqual([[0, 2, 4]]);
    expect(sharedMarkets([e, b, b, e])).toEqual([
      [0, 3],
      [1, 2],
    ]);
    // A leg with no market yet shares nothing, however many there are.
    expect(sharedMarkets([null, null, b])).toEqual([]);
    expect(sharedMarkets([])).toEqual([]);
  });

  it('says nothing while every leg has a market to itself', () => {
    expect(sharedMarketNote([BTC.ticker, ETH.ticker])).toBeNull();
    expect(sharedMarketNote([BTC.ticker, null, null])).toBeNull();
    expect(sharedMarketNote([])).toBeNull();
    // The basket a page opens on when there are two assets.
    expect(sharedMarketNote(seedLegs([BTC, ETH, SOL], 30).map((l) => l.event))).toBeNull();
  });

  it('says in one sentence what legs on the same market can do to each other, and the way out', () => {
    const [b, e, s] = [BTC.ticker, ETH.ticker, SOL.ticker];
    expect(sharedMarketNote([b, b])).toBe(
      'Legs 1 and 2 share a market: the first one’s orders can move the prices the next one needs, so on a market with few orders a later leg can be turned down; legs on different markets avoid this.',
    );
    // With one asset the page opens on two legs on it, so the sentence is there from the start.
    expect(sharedMarketNote(seedLegs([BTC], 30).map((l) => l.event))).toBe(sharedMarketNote([b, b]));
    // The legs are named, so a person can see which one to move.
    expect(sharedMarketNote([e, b, s, b])).toMatch(/^Legs 2 and 4 share a market: the first one’s orders /);
    expect(sharedMarketNote([b, e, b, b])).toMatch(/^Legs 1, 3 and 4 share a market: /);
    expect(sharedMarketNote([b, b, null])).toMatch(/^Legs 1 and 2 share a market: /);
    // Two markets with more than one leg each: still one sentence.
    expect(sharedMarketNote([b, b, e, e])).toMatch(/^Some of these legs share a market: the first one’s orders /);
    for (const legs of [[b, b], [e, b, s, b], [b, b, e, e]]) {
      const note = sharedMarketNote(legs)!;
      expect(note).toMatch(/legs on different markets avoid this\.$/);
      expect(note.match(/\./g)).toHaveLength(1);
      expect(note).not.toMatch(/risk-free|guarantee|protected|buffer|volatil|Gemini/i);
    }
  });
});

describe('stakes and totals', () => {
  it('splits to the cent, and the last leg takes what is left over so the parts add up to what was typed', () => {
    expect(splitEvenly(30, 2)).toEqual([15, 15]);
    expect(splitEvenly(10, 3)).toEqual([3.33, 3.33, 3.34]);
    expect(splitEvenly(10, 6)).toEqual([1.66, 1.66, 1.66, 1.66, 1.66, 1.7]);
    expect(splitEvenly(0, 2)).toEqual([0, 0]);
    for (const [total, n] of [
      [10, 3],
      [29.99, 2],
      [100, 6],
      [0.05, 3],
      [33.33, 4],
    ] as const) {
      const cents = splitEvenly(total, n).reduce(
        (sum, part) => sum + Math.round(part * 100),
        0,
      );
      expect(cents).toBe(Math.round(total * 100));
    }
  });

  it('says what each leg gets, with cents, and what the last one takes', () => {
    expect(splitWords(30, 2)).toBe('Shared evenly: $15.00 a leg.');
    expect(splitWords(10, 3)).toBe(
      'Shared evenly: $3.33 a leg and $3.34 on the last, so they add up to $10.00.',
    );
    expect(splitWords(12.5, 1)).toBe('One leg takes all $12.50.');
    expect(splitWords(0, 2)).toBe('');
    expect(splitWords(30, 0)).toBe('');
  });

  it('adds the stakes as set, what the orders cost, the wins (every leg wins) and the losses (every leg loses)', () => {
    const t = totals([
      { stake: 10, status: { cost: 10, win: 12.5, lose: -10 } },
      { stake: 10, status: { cost: 9.99, win: 6.01, lose: -4.2 } },
    ]);
    expect(t).toEqual({ stake: 20, cost: 19.99, best: 18.51, worst: -14.2 });
  });

  it('has no best or worst case until every leg has figures', () => {
    expect(
      totals([
        { stake: 10, status: { cost: 10, win: 5, lose: -10 } },
        { stake: 5 },
      ]),
    ).toEqual({ stake: 15, cost: 15, best: null, worst: null });
  });

  it('says why the orders can cost less than the stakes, in a line that is always there', () => {
    // One sentence: the ticket used to carry this and the rule that every leg is checked as two separate grey paragraphs.
    const sized =
      'Each bet is sized to cost no more than its stake, and every leg is checked before any is placed.';
    expect(costNote({ stake: 30, cost: 30 })).toBe(sized);
    expect(costNote({ stake: 30, cost: 29.99 })).toBe(sized);
    expect(sized.split(/\s+/).length).toBeLessThanOrEqual(20);
    // A leg the market can only part cover is the one case where the gap is more than cents, so it is named.
    expect(costNote({ stake: 30, cost: 24.2 }, [1])).toBe(
      'The market can only cover part of leg 2 right now, and every leg is checked before any is placed.',
    );
    expect(costNote({ stake: 45, cost: 30 }, [0, 2])).toBe(
      'The market can only cover part of legs 1 and 3 right now, and every leg is checked before any is placed.',
    );
    for (const said of [sized, costNote({ stake: 30, cost: 24.2 }, [1])!]) expect(said).not.toMatch(/\bfill/i);
    expect(costNote({ stake: 30, cost: 30 }, [1])).toBe(sized);
    // It should not happen, and if it does the figure stands without a sentence that would be untrue.
    expect(costNote({ stake: 30, cost: 30.05 })).toBeNull();
  });

  it('keeps a ticket under the header when it fits, and lets a taller one scroll until its button is in view', () => {
    expect(ticketTop(600, 900)).toBe(84);
    expect(ticketTop(800, 900)).toBe(84);
    // 1,500 tall in a 900 window: it sticks 616 above the top, which is when its bottom is 16 from the window's.
    expect(ticketTop(1500, 900)).toBe(-616);
    expect(ticketTop(1500, 900) + 1500).toBe(900 - 16);
  });

  it('lists leg numbers the way a sentence does', () => {
    expect(listed([2])).toBe('2');
    expect(listed([2, 3])).toBe('2 and 3');
    expect(listed([1, 2, 4])).toBe('1, 2 and 4');
  });
});

const quote = (
  over: Partial<QuoteResponse['quote']> = {},
): QuoteResponse['quote'] => ({
  verdict: 'ok',
  reasons: [],
  warnings: [],
  offerable: true,
  overridden: false,
  chanceCondition: 0.8,
  chanceBothHappen: 0.35,
  fairPrice: 0.44,
  pricePaid: 0.47,
  allInPrice: 0.48,
  markup: 0.03,
  markupPct: 0.07,
  cashOutPer100: 96,
  cashOutPer100AtProductionFees: null,
  feeCoefCharged: 0,
  ...over,
});

function parlayAnswer(
  a: Rung,
  b: Rung,
  stake: number,
  over: Partial<QuoteResponse['quote']> = {},
): QuoteResponse {
  return {
    venue: 'test',
    asOf: '',
    product: 'parlay',
    direction: 'up',
    event: { ticker: BTC.ticker, title: '', expiry: null },
    condition: { ...a },
    target: { ...b },
    quote: quote(over),
    stake: {
      requested: stake,
      reduced: false,
      outcomeContracts: stake / 0.47,
      hedgeContracts: 4,
      cost: stake,
      ifBothHit: 11.28,
      ifConditionFails: 0,
      ifConditionOnly: -stake,
      feesAtProductionRates: 0,
      cashOutNow: null,
    },
    depth: null,
  };
}

describe('one leg', () => {
  const a = BTC.rungs[1]!;
  const b = BTC.rungs[4]!;
  const base = {
    kind: 'up' as const,
    stake: 10,
    phase: 'idle' as const,
    readOnly: false,
    a,
    b,
    answerError: false,
    feeCoef: 0,
  };

  it('is ready only with the executor answer for these levels and this stake, and uses its figures', () => {
    const ans = parlayAnswer(a, b, 10);
    const s = legStatus({ ...base, answer: ans, shown: ans });
    expect(s.state.canPlace).toBe(true);
    expect(s).toMatchObject({
      cost: 10,
      win: 11.28,
      lose: -10,
      chanceWin: 0.35,
      estimated: false,
    });
    expect(s.chanceBack).toBeCloseTo(0.2, 10);
  });

  it('carries what a parlay nets when its stake comes back: nothing by the estimate, the quote\'s own figure once it answers', () => {
    expect(legStatus({ ...base, answer: null, shown: null }).back).toBe(0);
    const ans = parlayAnswer(a, b, 10);
    ans.stake!.ifConditionFails = 0.03;
    expect(legStatus({ ...base, answer: ans, shown: ans }).back).toBe(0.03);
  });

  it('waits while there is no current answer, showing the estimate', () => {
    const s = legStatus({ ...base, answer: null, shown: null });
    expect(s.state.canPlace).toBe(false);
    expect(s.state.blockedBy).toBe('checking');
    expect(s.estimated).toBe(true);
    expect(s.cost).toBe(10);
  });

  it('says why the executor refused it', () => {
    const ans = parlayAnswer(a, b, 10, {
      offerable: false,
      verdict: 'refuse',
      reasons: [{ code: 'markup_too_high', message: 'wide' }],
    });
    const s = legStatus({ ...base, answer: ans, shown: ans });
    expect(s.state.canPlace).toBe(false);
    expect(s.state.blockedBy).toBe('markup_too_high');
  });

  it('refuses a stake below the minimum and above the cap', () => {
    expect(
      legStatus({ ...base, stake: 0.5, answer: null, shown: null }).state
        .blockedBy,
    ).toBe('stake');
    const big = LEG_MAX_STAKE + 1;
    const ans = parlayAnswer(a, b, big);
    const s = legStatus({ ...base, stake: big, answer: ans, shown: ans });
    expect(s.state.canPlace).toBe(false);
    expect(s.state.label).toBe(`Stake $${LEG_MAX_STAKE} at most`);
  });

  it('caps a leg at the hosted demo’s $25 until the venue says what its own cap is, and then at that', () => {
    expect(LEG_MAX_STAKE).toBe(25);
    const at = (stake: number, maxStake?: number | null) => {
      const ans = parlayAnswer(a, b, stake);
      return legStatus({ ...base, stake, answer: ans, shown: ans, maxStake });
    };
    // Unknown cap: the default holds. $26 is over it.
    expect(at(26).state.canPlace).toBe(false);
    expect(at(26).state.label).toBe('Stake $25 at most');
    expect(at(26, null).state.label).toBe('Stake $25 at most');
    // A venue that caps at $100 lets $26 through, and one that caps at $10 turns away $11 and says $10.
    expect(at(26, 100).state.canPlace).toBe(true);
    expect(at(11, 10).state.label).toBe('Stake $10 at most');
  });

  it('reads a range answer with its own figures', () => {
    const lo = BTC.rungs[2]!;
    const hi = BTC.rungs[5]!;
    const ans: RangeQuoteResponse = {
      venue: 'test',
      asOf: '',
      product: 'range',
      event: { ticker: BTC.ticker, title: '', expiry: null },
      low: { ...lo },
      high: { ...hi },
      quote: { ...quote(), chanceInRange: 0.45, pricePaid: 0.47 },
      stake: {
        requested: 10,
        reduced: false,
        contracts: 6.8,
        cost: 9.99,
        backAlways: 6.8,
        ifInRange: 3.61,
        ifOutside: -3.19,
        feesAtProductionRates: 0,
        cashOutNow: null,
      },
      depth: null,
    };
    const s = legStatus({
      ...base,
      kind: 'range',
      a: lo,
      b: hi,
      answer: ans,
      shown: ans,
    });
    expect(s.state.canPlace).toBe(true);
    expect(s).toMatchObject({
      cost: 9.99,
      win: 3.61,
      lose: -3.19,
      chanceWin: 0.45,
      chanceBack: null,
    });
  });

  const breakoutAnswer = (lo: Rung, hi: Rung): BreakoutQuoteResponse => ({
    venue: 'test',
    asOf: '',
    product: 'breakout',
    event: { ticker: BTC.ticker, title: '', expiry: null },
    low: { ...lo },
    high: { ...hi },
    quote: {
      verdict: 'ok',
      reasons: [],
      warnings: [],
      offerable: true,
      overridden: false,
      chanceOutside: 0.55,
      fairPrice: 0.55,
      pricePaid: 0.57,
      allInPrice: 0.6,
      markup: 0.05,
      markupPct: 0.09,
      cashOutPer100: 93,
      cashOutPer100AtProductionFees: null,
      feeCoefCharged: 0,
    },
    stake: {
      requested: 10,
      reduced: false,
      contracts: 17.54,
      cost: 9.99,
      ifOutside: 7.55,
      ifInRange: -9.99,
      feesAtProductionRates: 0,
      cashOutNow: null,
    },
    depth: null,
  });

  it('reads a breakout answer with its own figures: the win is outside, and nothing comes back', () => {
    const lo = BTC.rungs[2]!;
    const hi = BTC.rungs[5]!;
    const ans = breakoutAnswer(lo, hi);
    const s = legStatus({
      ...base,
      kind: 'breakout',
      a: lo,
      b: hi,
      answer: ans,
      shown: ans,
    });
    expect(s.state.canPlace).toBe(true);
    expect(s).toMatchObject({
      cost: 9.99,
      win: 7.55,
      lose: -9.99,
      chanceWin: 0.55,
      chanceBack: null,
      pricePaid: 0.57,
      estimated: false,
    });
  });

  it('shows a breakout leg its own estimate while the executor has not answered', () => {
    const lo = BTC.rungs[2]!;
    const hi = BTC.rungs[4]!;
    const s = legStatus({
      ...base,
      kind: 'breakout',
      a: lo,
      b: hi,
      answer: null,
      shown: null,
    });
    expect(s.state.blockedBy).toBe('checking');
    expect(s.estimated).toBe(true);
    // 65% and 35%: 70% outside, and the pair costs 1 - 0.64 + 0.36.
    expect(s.chanceWin).toBeCloseTo(0.7, 8);
    expect(s.pricePaid).toBeCloseTo(0.72, 8);
    expect(s.lose).toBeCloseTo(-(s.cost ?? 0), 8);
    expect(s.win).toBeGreaterThan(0);
  });

  it('never takes a range answer for a breakout leg or the other way round, though both name a low and a high', () => {
    const lo = BTC.rungs[2]!;
    const hi = BTC.rungs[5]!;
    const b = breakoutAnswer(lo, hi);
    const r = { ...b, product: 'range' } as unknown as RangeQuoteResponse;
    expect(answerMatches('breakout', b, lo.symbol, hi.symbol)).toBe(true);
    expect(answerMatches('range', b, lo.symbol, hi.symbol)).toBe(false);
    expect(answerMatches('range', r, lo.symbol, hi.symbol)).toBe(true);
    expect(answerMatches('breakout', r, lo.symbol, hi.symbol)).toBe(false);
    expect(answerMatches('breakout', b, lo.symbol, 'other')).toBe(false);
    // A leg handed the wrong kind of answer falls back to its estimate and waits.
    const s = legStatus({
      ...base,
      kind: 'breakout',
      a: lo,
      b: hi,
      answer: r,
      shown: r,
    });
    expect(s.state.canPlace).toBe(false);
    expect(s.estimated).toBe(true);
  });

  it('matches an answer to levels and kind', () => {
    const ans = parlayAnswer(a, b, 10);
    expect(answerMatches('up', ans, a.symbol, b.symbol)).toBe(true);
    expect(answerMatches('down', ans, a.symbol, b.symbol)).toBe(false);
    expect(answerMatches('range', ans, a.symbol, b.symbol)).toBe(false);
    expect(answerMatches('up', ans, a.symbol, 'other')).toBe(false);
    expect(answerMatches('up', null, a.symbol, b.symbol)).toBe(false);
  });
});

describe('the place button', () => {
  const ready = (cost: number): LegStatus => ({
    state: {
      canPlace: true,
      label: 'Place bet',
      notice: null,
      blockedBy: null,
    },
    cost,
    win: 1,
    lose: -1,
    back: null,
    chanceWin: 0.4,
    chanceBack: null,
    pricePaid: 0.4,
    estimated: false,
    reducedTo: null,
  });
  const blocked = (label: string): LegStatus => ({
    ...ready(10),
    state: { canPlace: false, label, notice: null, blockedBy: 'no_price' },
  });

  it('is live when every leg is, with the total cost', () => {
    expect(
      basketButton({
        phase: 'idle',
        readOnly: false,
        legs: [ready(10), ready(9.99)],
      }),
    ).toEqual({
      canPlace: true,
      label: 'Place basket · $19.99',
      blockedLeg: null,
    });
  });

  it('names the first leg in the way', () => {
    const b = basketButton({
      phase: 'idle',
      readOnly: false,
      legs: [
        ready(10),
        blocked('Pick levels further apart'),
        blocked('Not open for bets'),
      ],
    });
    expect(b).toEqual({
      canPlace: false,
      label: 'Leg 2: pick levels further apart',
      blockedLeg: 1,
    });
    expect(
      basketButton({
        phase: 'idle',
        readOnly: false,
        legs: [undefined, ready(1)],
      }).label,
    ).toBe('Leg 1: loading prices');
  });

  it('says what is happening while placing, and when bets are off', () => {
    expect(
      basketButton({
        phase: 'placing',
        readOnly: false,
        legs: [ready(1), ready(1), ready(1)],
      }).label,
    ).toBe('Placing 3 bets');
    expect(
      basketButton({
        phase: 'idle',
        readOnly: true,
        legs: [ready(1), ready(1)],
      }).canPlace,
    ).toBe(false);
    expect(
      basketButton({ phase: 'idle', readOnly: false, legs: [ready(1)] })
        .canPlace,
    ).toBe(false);
  });
});

describe('the request', () => {
  it('builds each leg in the shape the executor takes, with a trimmed name', () => {
    const legs = seedLegs([BTC, ETH], 20);
    const req = buildRequest('  Majors  ', legs);
    expect(req.name).toBe('Majors');
    expect(req.user).toBe('primary');
    expect(req.legs[0]).toEqual({
      product: 'parlay',
      event: BTC.ticker,
      condition: legs[0]!.a,
      target: legs[0]!.b,
      direction: 'up',
      stake: 10,
    });
    expect(req.legs[1]).toEqual({
      product: 'range',
      event: ETH.ticker,
      low: legs[1]!.a,
      high: legs[1]!.b,
      stake: 10,
    });
  });

  it('sends a breakout leg as its own product, with its lower and higher level', () => {
    const [first, second] = seedLegs([BTC, ETH], 20);
    const lv = defaultLevels(ETH, 'breakout')!;
    const req = buildRequest('', [
      first!,
      { ...second!, kind: 'breakout', a: lv.a, b: lv.b },
    ]);
    expect(req.legs[1]).toEqual({
      product: 'breakout',
      event: ETH.ticker,
      low: lv.a,
      high: lv.b,
      stake: 10,
    });
  });

  it('leaves out an empty name and cuts a long one to 40 characters', () => {
    const legs = seedLegs([BTC, ETH], 20);
    expect('name' in buildRequest('   ', legs)).toBe(false);
    expect(buildRequest('x'.repeat(60), legs).name).toHaveLength(40);
  });

  it('refuses a leg with no levels', () => {
    const legs = seedLegs([BTC, ETH], 20);
    legs[1] = { ...legs[1]!, b: null };
    expect(() => buildRequest('', legs)).toThrow();
  });

  it('carries each leg’s own price limit: the price its quote showed plus three cents, as a single bet does', () => {
    const [first, second] = seedLegs([BTC, ETH], 20);
    const lv = defaultLevels(ETH, 'breakout')!;
    const legs = [first!, { ...second!, kind: 'breakout' as const, a: lv.a, b: lv.b }];
    const req = buildRequest('', legs, 'primary', [0.462, 0.3081]);
    expect(req.legs[0]).toMatchObject({ product: 'parlay', maxPrice: 0.492 });
    expect(req.legs[1]).toMatchObject({ product: 'breakout', maxPrice: 0.3381 });
    // The same two prices on a range leg.
    const range = buildRequest('', seedLegs([BTC, ETH], 20), 'primary', [0.4, 0.6]);
    expect(range.legs[1]).toMatchObject({ product: 'range', maxPrice: 0.63 });
  });

  it('a leg with no usable price carries no limit of its own, so the executor’s applies, and the ceiling stays under $1', () => {
    const legs = seedLegs([BTC, ETH], 20);
    const req = buildRequest('', legs, 'primary', [null, undefined]);
    expect('maxPrice' in req.legs[0]!).toBe(false);
    expect('maxPrice' in req.legs[1]!).toBe(false);
    expect('maxPrice' in buildRequest('', legs).legs[0]!).toBe(false);
    expect((buildRequest('', legs, 'primary', [0.99, 0.985]).legs as { maxPrice: number }[]).every((l) => l.maxPrice < 1)).toBe(true);
  });

  it('keeps one attempt’s id when only the price limits or the name change, and gives a different basket a new one', () => {
    const legs = seedLegs([BTC, ETH], 20);
    const a = buildRequest('Majors', legs, 'primary', [0.46, 0.4]);
    // The price ticked between an answer that was lost and the retry; the person also changed the name: the same bets.
    const b = buildRequest('Majors, renamed', legs, 'primary', [0.47, 0.41]);
    expect(basketAttemptKey(b)).toBe(basketAttemptKey(a));
    expect(basketAttemptKey(buildRequest('', legs))).toBe(basketAttemptKey(a));
    // A different stake, level or kind is a different basket.
    expect(basketAttemptKey(buildRequest('', legs.map((l) => ({ ...l, stake: l.stake + 1 }))))).not.toBe(basketAttemptKey(a));
    expect(basketAttemptKey(buildRequest('', [legs[0]!, { ...legs[1]!, kind: 'breakout' }]))).not.toBe(basketAttemptKey(a));
  });
});

const tagged = (index: number, over: Partial<Bet> = {}): Bet =>
  ({
    id: `bk-${index}`,
    createdAt: '2026-11-20T10:00:00.000Z',
    status: 'open',
    clientRequestId: 'attempt-0001',
    basket: { id: 'bk-1', name: 'Mixed', index, size: 3 },
    legs: [],
    ...over,
  }) as unknown as Bet;

describe('a basket found in the list of bets', () => {
  it('is described as the executor answers for it, by the id it was placed under', () => {
    const [found] = basketsFromBets([tagged(2), tagged(0), tagged(1)]);
    expect(found!.basket).toEqual({ id: 'bk-1', name: 'Mixed', size: 3, failed: null, clientRequestId: 'attempt-0001' });
    expect(found!.bets.map((b) => b.id)).toEqual(['bk-0', 'bk-1', 'bk-2']);
  });

  it('names the leg that did not end open, from the bet’s own status and note', () => {
    const [found] = basketsFromBets([tagged(0), tagged(1), tagged(2, { status: 'unwound', note: 'The second order could not be completed.' })]);
    expect(found!.basket.failed).toEqual({ index: 2, code: 'unwound', message: 'The second order could not be completed.' });
    // A leg that is settled or sold back by now is not a failed one.
    expect(basketsFromBets([tagged(0, { status: 'settled' }), tagged(1, { status: 'cashed_out' }), tagged(2)])[0]!.basket.failed).toBeNull();
  });

  it('says nothing of a basket with legs missing or still being placed: only the executor’s own answer knows why', () => {
    // Two of three: the third may be on its way, or may never have been placed.
    expect(basketsFromBets([tagged(0), tagged(1)])).toEqual([]);
    expect(basketsFromBets([tagged(0), tagged(1), tagged(2, { status: 'placing' })])).toEqual([]);
  });

  it('keeps baskets apart, and leaves out bets that belong to none', () => {
    const other = (i: number) => tagged(i, { id: `bk-x${i}`, clientRequestId: 'attempt-0002', basket: { id: 'bk-2', index: i, size: 2 } });
    const found = basketsFromBets([tagged(0), other(0), { ...tagged(0), id: 'single', basket: undefined } as Bet, tagged(1), other(1), tagged(2)]);
    expect(found.map((f) => [f.basket.id, f.basket.clientRequestId, f.bets.length])).toEqual([
      ['bk-1', 'attempt-0001', 3],
      ['bk-2', 'attempt-0002', 2],
    ]);
    expect(found[1]!.basket.name).toBeNull();
  });
});

describe('answers from the executor', () => {
  it('reads which leg a refused basket stopped on', () => {
    const err = new ApiError(
      422,
      { error: 'Leg 2: too wide', code: 'markup_too_high', leg: 1 },
      'x',
    );
    expect(refusedLeg(err)).toEqual({ index: 1, message: 'too wide' });
    expect(
      refusedLeg(
        new ApiError(400, { error: 'capped', code: 'stake_too_large' }, 'x'),
      ),
    ).toBeNull();
    expect(refusedLeg(new Error('x'))).toBeNull();
    expect(stripLegPrefix('Leg 12: something')).toBe('something');
  });

  it('counts legs on crypto assets', () => {
    expect(cryptoLegs([BTC, ETH, undefined])).toBe(2);
    expect(cryptoLegs([ladder('NGAS', 3, 1, 'Energy'), BTC])).toBe(1);
  });

  it('says crypto legs "that point the same way" win together more often only when every crypto leg points a way', () => {
    const crypto = (kind: 'up' | 'down' | 'range' | 'breakout') => ({ kind, crypto: true });
    // Two rising or falling Stake Backs on separate crypto markets: the sentence is right (the joint chance does lean high).
    expect(legsPointAWay([crypto('up'), crypto('up')])).toBe(true);
    expect(legsPointAWay([crypto('up'), crypto('down')])).toBe(true);
    // A Range or a Breakout points nowhere: BTC range with ETH rising wins together 1.3% of the time, against 8.2% if unrelated.
    expect(legsPointAWay([crypto('up'), crypto('range')])).toBe(false);
    expect(legsPointAWay([crypto('breakout'), crypto('down')])).toBe(false);
    expect(legsPointAWay([crypto('range'), crypto('breakout')])).toBe(false);
    // Legs on other assets are not part of what the sentence says.
    expect(legsPointAWay([crypto('up'), crypto('up'), { kind: 'range', crypto: false }])).toBe(true);
    expect(legsPointAWay([])).toBe(true);
  });
});

describe('placing the rest of a basket that was placed in part', () => {
  const res = (failed: { index: number; code: string } | null, bets: { index: number; status: string }[]) =>
    ({
      basket: { id: 'k', name: null, size: 4, failed: failed ? { ...failed, message: 'x' } : null },
      bets: bets.map((b) => ({ id: `b${b.index}`, status: b.status, basket: { id: 'k', index: b.index, size: 4 } })),
    }) as unknown as Parameters<typeof restFrom>[0];

  it('starts again at a leg that bought nothing or was sold straight back', () => {
    expect(restFrom(res({ index: 1, code: 'failed' }, [{ index: 0, status: 'open' }, { index: 1, status: 'failed' }]))).toBe(1);
    expect(restFrom(res({ index: 2, code: 'unwound' }, [{ index: 0, status: 'open' }, { index: 1, status: 'open' }, { index: 2, status: 'unwound' }]))).toBe(2);
    // A leg refused before any bet exists is not in the list at all.
    expect(restFrom(res({ index: 1, code: 'market_closed' }, [{ index: 0, status: 'open' }]))).toBe(1);
  });

  it('starts after a leg that is on the books with only its first order filled, so it is not bought twice', () => {
    expect(restFrom(res({ index: 1, code: 'unhedged' }, [{ index: 0, status: 'open' }, { index: 1, status: 'unhedged' }]))).toBe(2);
  });

  it('is the start for a basket that was placed whole', () => {
    expect(restFrom(res(null, []))).toBe(0);
  });
});
