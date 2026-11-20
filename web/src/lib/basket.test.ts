import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type {
  MarketEvent,
  QuoteResponse,
  RangeQuoteResponse,
  Rung,
} from '../api/types';
import {
  LEG_MAX_STAKE,
  answerMatches,
  basketButton,
  buildRequest,
  cryptoLegs,
  defaultLevels,
  defaultRange,
  firstOptions,
  legStatus,
  levelsValid,
  pickMarket,
  refusedLeg,
  secondOptions,
  seedLegs,
  splitEvenly,
  stripLegPrefix,
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
    expect(
      pickMarket([BTC, ETH, SOL], [BTC.ticker, ETH.ticker, SOL.ticker])?.ticker,
    ).toBe(BTC.ticker);
    expect(pickMarket([], [])).toBeUndefined();
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
});

describe('stakes and totals', () => {
  it('splits to the cent and the parts add up', () => {
    expect(splitEvenly(30, 2)).toEqual([15, 15]);
    expect(splitEvenly(10, 3)).toEqual([3.34, 3.33, 3.33]);
    expect(splitEvenly(10, 3).reduce((a, b) => a + b, 0)).toBeCloseTo(10, 10);
    expect(splitEvenly(0, 2)).toEqual([0, 0]);
  });

  it('adds the costs, the wins (every leg wins) and the losses (every leg loses)', () => {
    const t = totals([
      { stake: 10, status: { cost: 10, win: 12.5, lose: -10 } },
      { stake: 10, status: { cost: 9.99, win: 6.01, lose: -4.2 } },
    ]);
    expect(t).toEqual({ stake: 19.99, best: 18.51, worst: -14.2 });
  });

  it('has no best or worst case until every leg has figures', () => {
    expect(
      totals([
        { stake: 10, status: { cost: 10, win: 5, lose: -10 } },
        { stake: 5 },
      ]),
    ).toEqual({ stake: 15, best: null, worst: null });
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
});
