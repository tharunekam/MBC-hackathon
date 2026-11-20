import { describe, expect, it } from 'vitest';
import type { OfferQuote, QuoteResponse, RangeQuote, RangeQuoteResponse, RangeStakePlan, RefusalCode, Rung, StakePlan } from '../api/types';
import { buttonState, firstReason, localRefusal, rangeButtonState, type BetInputs, type RangeInputs } from './betState';
import { estimate, rangeEstimate } from './pricing';

const rung = (strike: number, bid: number | null, ask: number | null, open = true): Rung => ({
  symbol: `S${strike}`,
  label: `$${strike}`,
  strike,
  bid,
  ask,
  open,
  state: open ? 'active/open' : 'active/post_only',
});

const A = rung(62000, 0.72, 0.76);
const B = rung(63500, 0.3, 0.34);

const offer = (over: Partial<OfferQuote> = {}): OfferQuote => ({
  verdict: 'ok',
  reasons: [],
  warnings: [],
  offerable: true,
  overridden: false,
  chanceCondition: 0.74,
  chanceBothHappen: 0.32,
  fairPrice: 0.43,
  pricePaid: 0.45,
  allInPrice: 0.45,
  markup: 0.02,
  markupPct: 0.04,
  cashOutPer100: 95,
  cashOutPer100AtProductionFees: 94,
  feeCoefCharged: 0,
  ...over,
});

const plan = (over: Partial<StakePlan> = {}): StakePlan => ({
  requested: 10,
  reduced: false,
  outcomeContracts: 22,
  hedgeContracts: 22,
  cost: 10,
  ifBothHit: 12,
  ifConditionFails: 0,
  ifConditionOnly: -10,
  feesAtProductionRates: 0.4,
  cashOutNow: 9.5,
  ...over,
});

const answer = (o: Partial<OfferQuote> = {}, p: StakePlan | null = plan()): QuoteResponse => ({
  venue: 'test',
  asOf: '2026-11-18T00:00:00Z',
  event: { ticker: 'E', title: 'E', expiry: null },
  condition: { symbol: A.symbol, label: A.label, strike: A.strike } as QuoteResponse['condition'],
  target: { symbol: B.symbol, label: B.label, strike: B.strike } as QuoteResponse['target'],
  quote: offer(o),
  stake: p,
  depth: null,
});

const base = (over: Partial<BetInputs> = {}): BetInputs => ({
  phase: 'idle',
  readOnly: false,
  stake: 10,
  condition: A,
  target: B,
  answer: answer(),
  answerError: false,
  est: estimate({ bid: A.bid, ask: A.ask }, { bid: B.bid, ask: B.ask }, 0),
  ...over,
});

const refused = (code: RefusalCode, message = 'x') => answer({ offerable: false, verdict: 'refuse', reasons: [{ code, message }] }, null);

describe('the place bet button', () => {
  it('is live only for an answer to this pair and stake, and shows the real cost', () => {
    const s = buttonState(base());
    expect(s).toMatchObject({ canPlace: true, label: 'Place bet · $10.00', notice: null, blockedBy: null });
  });

  it('is not live on an estimate alone, however good it looks (the executor has not agreed yet)', () => {
    const s = buttonState(base({ answer: null }));
    expect(s.canPlace).toBe(false);
    expect(s.blockedBy).toBe('checking');
    expect(s.label).toBe('Checking the price');
  });

  it('says what is wrong when the quote cannot be fetched at all', () => {
    const s = buttonState(base({ answer: null, answerError: true }));
    expect(s).toMatchObject({ canPlace: false, blockedBy: 'unreachable', label: 'Prices unavailable' });
    expect(s.notice?.text).toMatch(/connection/);
  });

  it('never shows a zero price: a bet the book cannot fill is refused with a reason', () => {
    for (const p of [plan({ cost: 0, outcomeContracts: 0, hedgeContracts: 0 }), plan({ cost: 0.59, outcomeContracts: 1, reduced: true })]) {
      const s = buttonState(base({ answer: answer({}, p) }));
      expect(s.canPlace).toBe(false);
      expect(s.blockedBy).toBe('thin');
      expect(s.label).not.toMatch(/\$0\.00/);
      expect(s.notice?.tone).toBe('bad');
    }
    expect(buttonState(base({ answer: answer({}, plan({ cost: 0.59, outcomeContracts: 1, reduced: true })) })).notice?.text).toMatch(/\$0\.59/);
  });

  it('allows a reduced bet that is still at least the minimum', () => {
    const s = buttonState(base({ answer: answer({}, plan({ cost: 3.45, reduced: true })) }));
    expect(s).toMatchObject({ canPlace: true, label: 'Place bet · $3.45' });
  });

  it('is off while a bet is being placed, with no notice', () => {
    expect(buttonState(base({ phase: 'placing' }))).toMatchObject({ canPlace: false, label: 'Placing both orders', notice: null });
  });

  it('is off when bets are switched off, and for a stake under the minimum', () => {
    expect(buttonState(base({ readOnly: true }))).toMatchObject({ canPlace: false, blockedBy: 'readonly' });
    expect(buttonState(base({ stake: 0.5 }))).toMatchObject({ canPlace: false, blockedBy: 'stake', label: 'Stake at least $1' });
  });
});

describe('each refusal says what to do, and only suggests moving the target when that helps', () => {
  const cases: Array<[RefusalCode, RegExp, RegExp]> = [
    ['no_price', /higher target/i, /further above/],
    ['price_too_high', /higher target/i, /further above/],
    ['markup_too_high', /another pair/i, /too far apart/],
    ['market_closed', /not open/i, /not open for trading/],
    ['ladder_out_of_order', /out of step/i, /out of order/],
    ['one_sided_book', /no market/i, /Nobody is buying or selling/],
  ];
  for (const [code, label, text] of cases) {
    it(code, () => {
      const s = buttonState(base({ answer: refused(code) }));
      expect(s.canPlace).toBe(false);
      expect(s.blockedBy).toBe(code);
      expect(s.label).toMatch(label);
      expect(s.notice?.text).toMatch(text);
    });
  }

  it('never tells anyone to move the target closer', () => {
    for (const [code] of cases) {
      const s = buttonState(base({ answer: refused(code) }));
      expect(`${s.label} ${s.notice?.text}`).not.toMatch(/closer/i);
    }
  });

  it('a market that is not open says so even if the price would also be too high', () => {
    expect(firstReason(['markup_too_high', 'market_closed', 'price_too_high'])).toBe('market_closed');
    expect(firstReason(['markup_too_high', 'price_too_high'])).toBe('price_too_high');
    expect(firstReason([])).toBeNull();
  });
});

describe('before the executor answers, only what the local numbers settle is refused', () => {
  it('a rung that is not open (post-only) is refused at once', () => {
    const s = buttonState(base({ answer: null, target: rung(63500, 0.3, 0.34, false) }));
    expect(s).toMatchObject({ canPlace: false, blockedBy: 'market_closed' });
  });

  it('a rung with no buyer or seller is refused at once', () => {
    expect(localRefusal(A, rung(63500, null, 0.34), null)).toBe('one_sided_book');
  });

  it('a target that costs as much as the condition (no price) is refused, with the right way out', () => {
    const near = rung(62500, 0.7, 0.74);
    const s = buttonState(base({ answer: null, target: near, est: estimate({ bid: A.bid, ask: A.ask }, { bid: near.bid, ask: near.ask }, 0) }));
    expect(s.blockedBy).toBe('no_price');
    expect(s.notice?.text).toMatch(/further above/);
  });

  it('a pair whose price is too high or spread too wide is refused with its own code', () => {
    const wide = rung(63500, 0.05, 0.6);
    const e = estimate({ bid: A.bid, ask: A.ask }, { bid: wide.bid, ask: wide.ask }, 0);
    expect(e?.code).toBe('markup_too_high');
    expect(buttonState(base({ answer: null, target: wide, est: e })).blockedBy).toBe('markup_too_high');
  });

  it('an executor refusal overrules a hopeful estimate', () => {
    const s = buttonState(base({ answer: refused('market_closed') }));
    expect(s.canPlace).toBe(false);
  });
});

describe('"not open" says what kind of not open', () => {
  const closed = (state: string): Rung => ({ ...rung(63500, 0.3, 0.34, false), state });
  it('a new listing that is post-only opens soon', () => {
    const s = buttonState(base({ answer: refused('market_closed'), target: closed('active/post_only') }));
    expect(s.label).toMatch(/not open for bets yet/i);
    expect(s.notice?.text).toMatch(/few minutes/);
  });
  it('a settled or closed market will not reopen, and says so', () => {
    for (const state of ['settled', 'closed', 'active/closed', 'expired']) {
      const s = buttonState(base({ answer: refused('market_closed'), target: closed(state) }));
      expect(s.label).toMatch(/has closed/i);
      expect(s.notice?.text).not.toMatch(/few minutes/);
    }
  });
  it('an unknown state makes no promise about reopening', () => {
    const s = buttonState(base({ answer: null, target: closed('mystery') }));
    expect(s.blockedBy).toBe('market_closed');
    expect(s.notice?.text).not.toMatch(/few minutes|reopen/);
  });
});

// ------------------------------------------------------------------ range

describe('the place bet button for a range', () => {
  const LO = rung(62000, 0.74, 0.76);
  const HI = rung(64000, 0.3, 0.32);

  const rangeQuote = (over: Partial<RangeQuote> = {}): RangeQuote => ({
    verdict: 'ok',
    reasons: [],
    warnings: [],
    offerable: true,
    overridden: false,
    chanceInRange: 0.44,
    fairPrice: 0.44,
    pricePaid: 0.46,
    allInPrice: 0.47,
    markup: 0.02,
    markupPct: 0.05,
    cashOutPer100: 96,
    cashOutPer100AtProductionFees: 95,
    feeCoefCharged: 0,
    ...over,
  });

  const rangePlan = (over: Partial<RangeStakePlan> = {}): RangeStakePlan => ({
    requested: 10,
    reduced: false,
    contracts: 6.84,
    cost: 10,
    backAlways: 6.84,
    ifInRange: 3.68,
    ifOutside: -3.16,
    feesAtProductionRates: 0.14,
    cashOutNow: 9.6,
    ...over,
  });

  const rangeAnswer = (q: Partial<RangeQuote> = {}, p: RangeStakePlan | null = rangePlan()): RangeQuoteResponse => ({
    venue: 'test',
    asOf: '2026-11-18T00:00:00Z',
    product: 'range',
    event: { ticker: 'E', title: 'E', expiry: null },
    low: { symbol: LO.symbol, label: LO.label, strike: LO.strike, bid: LO.bid, ask: LO.ask },
    high: { symbol: HI.symbol, label: HI.label, strike: HI.strike, bid: HI.bid, ask: HI.ask },
    quote: rangeQuote(q),
    stake: p,
    depth: { outcomeAvailable: 100, conditionAvailable: 100, maxStake: 60 },
  });

  const estOf = (lo: Rung, hi: Rung) => rangeEstimate({ bid: lo.bid, ask: lo.ask }, { bid: hi.bid, ask: hi.ask }, 0);

  const rbase = (over: Partial<RangeInputs> = {}): RangeInputs => ({
    phase: 'idle',
    readOnly: false,
    stake: 10,
    low: LO,
    high: HI,
    answer: rangeAnswer(),
    answerError: false,
    est: estOf(LO, HI),
    ...over,
  });

  const rangeRefused = (code: RefusalCode, message = 'x') => rangeAnswer({ offerable: false, verdict: 'refuse', reasons: [{ code, message }] }, null);

  it('is live for the executor answer to this range and stake, and shows the real cost', () => {
    expect(rangeButtonState(rbase())).toMatchObject({ canPlace: true, label: 'Place bet · $10.00', notice: null, blockedBy: null });
    expect(rangeButtonState(rbase({ answer: rangeAnswer({}, rangePlan({ cost: 4.5, reduced: true })) }))).toMatchObject({ canPlace: true, label: 'Place bet · $4.50' });
  });

  it('is off while placing, with no notice', () => {
    expect(rangeButtonState(rbase({ phase: 'placing' }))).toMatchObject({ canPlace: false, label: 'Placing both orders', notice: null, blockedBy: 'placing' });
  });

  it('is off when bets are switched off', () => {
    expect(rangeButtonState(rbase({ readOnly: true }))).toMatchObject({ canPlace: false, blockedBy: 'readonly', label: 'Bets are switched off' });
  });

  it('waits for prices while either level is missing', () => {
    expect(rangeButtonState(rbase({ low: undefined }))).toMatchObject({ canPlace: false, blockedBy: 'loading', label: 'Loading prices' });
    expect(rangeButtonState(rbase({ high: undefined }))).toMatchObject({ canPlace: false, blockedBy: 'loading' });
  });

  it('asks for at least the minimum stake', () => {
    const s = rangeButtonState(rbase({ stake: 0.5 }));
    expect(s).toMatchObject({ canPlace: false, blockedBy: 'stake', label: 'Stake at least $1' });
    expect(s.notice?.tone).toBe('info');
    expect(rangeButtonState(rbase({ stake: Number.NaN })).blockedBy).toBe('stake');
  });

  const cases: Array<[RefusalCode, RegExp, RegExp]> = [
    ['no_price', /further apart/i, /no sensible price/],
    ['price_too_high', /further apart/i, /cost too much/],
    ['markup_too_high', /other levels/i, /too far apart for a fair deal/],
    ['ladder_out_of_order', /out of step/i, /out of order/],
    ['one_sided_book', /no market/i, /Nobody is buying or selling/],
  ];
  for (const [code, label, text] of cases) {
    it(`an executor refusal (${code}) names its cause and the way out`, () => {
      const s = rangeButtonState(rbase({ answer: rangeRefused(code) }));
      expect(s.canPlace).toBe(false);
      expect(s.blockedBy).toBe(code);
      expect(s.label).toMatch(label);
      expect(s.notice?.tone).toBe('bad');
      expect(s.notice?.text).toMatch(text);
      expect(`${s.label} ${s.notice?.text}`).not.toMatch(/target|condition|closer/i);
    });
  }

  it('market_closed says what kind of not open, from the levels themselves', () => {
    const postOnly = { ...HI, open: false, state: 'active/post_only' };
    const s = rangeButtonState(rbase({ high: postOnly, answer: rangeRefused('market_closed') }));
    expect(s).toMatchObject({ canPlace: false, blockedBy: 'market_closed' });
    expect(s.label).toMatch(/not open for bets yet/i);
    expect(s.notice?.text).toMatch(/few minutes/);

    const settled = { ...LO, open: false, state: 'settled' };
    const t = rangeButtonState(rbase({ low: settled, answer: rangeRefused('market_closed') }));
    expect(t.label).toMatch(/has closed/i);
    expect(t.notice?.text).not.toMatch(/few minutes/);
  });

  it('a closed market is named first when several things are wrong', () => {
    const a = rangeAnswer({ offerable: false, verdict: 'refuse', reasons: [{ code: 'markup_too_high', message: 'x' }, { code: 'market_closed', message: 'y' }] }, null);
    expect(rangeButtonState(rbase({ answer: a })).blockedBy).toBe('market_closed');
  });

  it('a refusal with no known code still says something', () => {
    const a = rangeAnswer({ offerable: false, verdict: 'refuse', reasons: [] }, null);
    const s = rangeButtonState(rbase({ answer: a }));
    expect(s).toMatchObject({ canPlace: false, label: 'Not on offer' });
    expect(s.notice?.text).toMatch(/range/);
  });

  it('never shows a zero price: a range the book cannot fill is refused as thin', () => {
    for (const p of [rangePlan({ cost: 0, contracts: 0, backAlways: 0 }), rangePlan({ cost: 0.62, contracts: 0.42, reduced: true })]) {
      const s = rangeButtonState(rbase({ answer: rangeAnswer({}, p) }));
      expect(s).toMatchObject({ canPlace: false, blockedBy: 'thin', label: 'Not enough on the market' });
      expect(s.label).not.toMatch(/\$0\.00/);
      expect(s.notice?.text).toMatch(/other levels/);
    }
    expect(rangeButtonState(rbase({ answer: rangeAnswer({}, rangePlan({ cost: 0.62, contracts: 0.42 })) })).notice?.text).toMatch(/\$0\.62/);
  });

  it('an offerable answer with no stake plan is still being checked', () => {
    expect(rangeButtonState(rbase({ answer: rangeAnswer({}, null) }))).toMatchObject({ canPlace: false, blockedBy: 'checking' });
  });

  it('is not live on an estimate alone, however good it looks', () => {
    expect(rangeButtonState(rbase({ answer: null }))).toMatchObject({ canPlace: false, blockedBy: 'checking', label: 'Checking the price', notice: null });
  });

  it('refuses early on what the local numbers already settle', () => {
    const shut = { ...HI, open: false, state: 'active/post_only' };
    expect(rangeButtonState(rbase({ answer: null, high: shut })).blockedBy).toBe('market_closed');

    const oneSided = { ...LO, bid: null };
    expect(rangeButtonState(rbase({ answer: null, low: oneSided, est: null })).blockedBy).toBe('one_sided_book');

    // No sensible price at all (the levels are the wrong way round on the book).
    const flat = rung(64000, 0.8, 0.82);
    expect(rangeButtonState(rbase({ answer: null, high: flat, est: estOf(LO, flat) })).blockedBy).toBe('no_price');

    // A spread too wide to be fair.
    const wide = rung(64000, 0.05, 0.6);
    const e = estOf(LO, wide);
    expect(e?.code).toBe('markup_too_high');
    const s = rangeButtonState(rbase({ answer: null, high: wide, est: e }));
    expect(s.blockedBy).toBe('markup_too_high');
    expect(s.notice?.text).toMatch(/other levels/);

    // An unknown state makes no promise about reopening.
    const odd = { ...HI, open: false, state: 'mystery' };
    expect(rangeButtonState(rbase({ answer: null, high: odd })).notice?.text).not.toMatch(/few minutes|reopen/);
  });

  it('an early refusal outranks a failed quote request, and a failed request alone says so', () => {
    const shut = { ...HI, open: false, state: 'active/post_only' };
    expect(rangeButtonState(rbase({ answer: null, answerError: true, high: shut })).blockedBy).toBe('market_closed');
    const s = rangeButtonState(rbase({ answer: null, answerError: true }));
    expect(s).toMatchObject({ canPlace: false, blockedBy: 'unreachable', label: 'Prices unavailable' });
    expect(s.notice?.text).toMatch(/connection/);
    expect(s.notice?.text).toMatch(/range/);
  });

  it('an executor refusal overrules a hopeful estimate', () => {
    expect(rangeButtonState(rbase({ answer: rangeRefused('price_too_high') })).canPlace).toBe(false);
  });
});
