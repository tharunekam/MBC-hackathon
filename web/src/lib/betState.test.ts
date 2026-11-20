import { describe, expect, it } from 'vitest';
import type { BreakoutQuote, BreakoutQuoteResponse, BreakoutStakePlan, OfferQuote, QuoteResponse, RangeQuote, RangeQuoteResponse, RangeStakePlan, RefusalCode, Rung, StakePlan } from '../api/types';
import { breakoutButtonState, buttonState, firstReason, localRefusal, rangeButtonState, type BetInputs, type BreakoutInputs, type RangeInputs } from './betState';
import { breakoutEstimate, estimate, rangeEstimate } from './pricing';

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

  it('asks for a stake when the box is empty or zero, even with a good answer for the last amount typed', () => {
    for (const stake of [0, Number.NaN]) {
      const s = buttonState(base({ stake }));
      expect(s).toMatchObject({ canPlace: false, blockedBy: 'stake', label: 'Enter a stake' });
      expect(s.label).not.toMatch(/Place bet/);
    }
  });

  it('says what the cap is once the executor has said so, in the words a basket uses, and never blames the connection', () => {
    const s = buttonState(base({ stake: 150, cap: 100, answer: null, answerError: true }));
    expect(s).toMatchObject({ canPlace: false, blockedBy: 'stake', label: 'Stake $100 at most' });
    // The page says the cap under the stake box; the button's own notice stays out of the way.
    expect(s.notice).toBeNull();
    expect(`${s.label}`).not.toMatch(/unavailable|connection/i);
    // At the cap itself the bet goes through.
    expect(buttonState(base({ stake: 100, cap: 100, answer: answer({}, plan({ requested: 100, cost: 100 })) }))).toMatchObject({ canPlace: true, label: 'Place bet · $100.00' });
  });

  it('passes on the executor’s own words when it refused the stake and gave no amount to read', () => {
    const s = buttonState(base({ stake: 150, answer: null, stakeRefused: 'Bets are capped on this demo.' }));
    expect(s).toMatchObject({ canPlace: false, blockedBy: 'stake', label: 'Stake is too large' });
    expect(s.notice?.text).toBe('Bets are capped on this demo.');
    expect(s.notice?.text).not.toMatch(/connection/);
  });
});

describe('a ladder that cannot take a bet says so before anything else', () => {
  const closed = { phase: 'closed' as const, label: 'This market has closed', text: 'This market closed at 9:35 PM and takes no more bets. The next one appears here by itself when it opens.' };

  it('whatever the stake, the answer or the prices say', () => {
    for (const over of [{}, { stake: 0 }, { answer: null }, { answer: null, answerError: true }, { answer: refused('markup_too_high') }, { condition: undefined }] as Partial<BetInputs>[]) {
      const s = buttonState(base({ ...over, market: closed }));
      expect(s).toMatchObject({ canPlace: false, blockedBy: 'market_closed', label: 'This market has closed' });
      expect(s.notice).toEqual({ tone: 'info', text: closed.text });
    }
  });

  it('but an order on its way, and bets switched off, are said first', () => {
    expect(buttonState(base({ phase: 'placing', market: closed })).blockedBy).toBe('placing');
    expect(buttonState(base({ readOnly: true, market: closed })).blockedBy).toBe('readonly');
  });

  it('and the page recovers as soon as the note is gone', () => {
    expect(buttonState(base({ market: null })).canPlace).toBe(true);
  });
});

describe('each refusal says what to do, and only suggests moving the target when that helps', () => {
  const cases: Array<[RefusalCode, RegExp, RegExp]> = [
    ['no_price', /higher target/i, /further above/],
    ['price_too_high', /higher target/i, /further above/],
    ['markup_too_high', /other levels/i, /too far apart/],
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
      // It used to say "Pick the next ladder above" when there was no other ladder to pick.
      expect(s.notice?.text).not.toMatch(/above|next ladder/i);
    }
  });
  it('never calls the two levels a condition, a leg, a part or a pair', () => {
    const all: RefusalCode[] = ['market_closed', 'ladder_out_of_order', 'one_sided_book', 'no_price', 'price_too_high', 'markup_too_high'];
    for (const code of all) {
      for (const direction of ['up', 'down'] as const) {
        const s = buttonState(base({ direction, answer: refused(code) }));
        expect(`${s.label} ${s.notice?.text}`).not.toMatch(/condition|\bleg\b|\bpart\b|\bpair\b/i);
      }
    }
    expect(buttonState(base({ direction: 'down', answer: refused('price_too_high') })).notice?.text).toMatch(/further below the first level/);
    expect(buttonState(base({ answer: refused('price_too_high') })).notice?.text).toMatch(/further above the first level/);
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

  it('asks for a stake when there is none, names the cap when the stake is over it, and says a closed market is closed', () => {
    expect(rangeButtonState(rbase({ stake: 0 }))).toMatchObject({ canPlace: false, blockedBy: 'stake', label: 'Enter a stake', notice: null });
    expect(rangeButtonState(rbase({ stake: 150, cap: 100, answer: null, answerError: true }))).toMatchObject({ canPlace: false, blockedBy: 'stake', label: 'Stake $100 at most' });
    const market = { phase: 'closed' as const, label: 'This market has closed', text: 'This market closed at 9 PM and takes no more bets. Pick another market above.' };
    expect(rangeButtonState(rbase({ market }))).toMatchObject({ canPlace: false, blockedBy: 'market_closed', label: 'This market has closed', notice: { tone: 'info', text: market.text } });
  });

  const cases: Array<[RefusalCode, RegExp, RegExp]> = [
    ['no_price', /further apart/i, /no sensible price/],
    // A range costs more the further apart its levels are, so the way out of a price that is too high is a narrower range.
    ['price_too_high', /narrower/i, /cost too much/],
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

// ------------------------------------------------------------------ breakout

describe('the place bet button for a breakout', () => {
  const LO = rung(62000, 0.74, 0.76);
  const HI = rung(64000, 0.3, 0.32);

  const quote = (over: Partial<BreakoutQuote> = {}): BreakoutQuote => ({
    verdict: 'ok',
    reasons: [],
    warnings: [],
    offerable: true,
    overridden: false,
    chanceOutside: 0.56,
    fairPrice: 0.56,
    pricePaid: 0.58,
    allInPrice: 0.61,
    markup: 0.05,
    markupPct: 0.09,
    cashOutPer100: 93,
    cashOutPer100AtProductionFees: 88,
    feeCoefCharged: 0,
    ...over,
  });

  const plan = (over: Partial<BreakoutStakePlan> = {}): BreakoutStakePlan => ({
    requested: 10,
    reduced: false,
    contracts: 17.24,
    cost: 10,
    ifOutside: 7.24,
    ifInRange: -10,
    feesAtProductionRates: 0.5,
    cashOutNow: 9.3,
    ...over,
  });

  const answer = (q: Partial<BreakoutQuote> = {}, p: BreakoutStakePlan | null = plan()): BreakoutQuoteResponse => ({
    venue: 'test',
    asOf: '2026-11-19T00:00:00Z',
    product: 'breakout',
    event: { ticker: 'E', title: 'E', expiry: null },
    low: { symbol: LO.symbol, label: LO.label, strike: LO.strike, bid: LO.bid, ask: LO.ask },
    high: { symbol: HI.symbol, label: HI.label, strike: HI.strike, bid: HI.bid, ask: HI.ask },
    quote: quote(q),
    stake: p,
    depth: { outcomeAvailable: 100, conditionAvailable: 100, maxStake: 60 },
  });

  const estOf = (lo: Rung, hi: Rung) => breakoutEstimate({ bid: lo.bid, ask: lo.ask }, { bid: hi.bid, ask: hi.ask }, 0);

  const bbase = (over: Partial<BreakoutInputs> = {}): BreakoutInputs => ({
    phase: 'idle',
    readOnly: false,
    stake: 10,
    low: LO,
    high: HI,
    answer: answer(),
    answerError: false,
    est: estOf(LO, HI),
    ...over,
  });

  const refused = (code: RefusalCode, message = 'x') => answer({ offerable: false, verdict: 'refuse', reasons: [{ code, message }] }, null);

  it('is live for the executor answer to these levels and this stake, and shows the real cost', () => {
    expect(breakoutButtonState(bbase())).toMatchObject({ canPlace: true, label: 'Place bet · $10.00', notice: null, blockedBy: null });
    expect(breakoutButtonState(bbase({ answer: answer({}, plan({ cost: 4.5, reduced: true })) }))).toMatchObject({ canPlace: true, label: 'Place bet · $4.50' });
  });

  it('is off while placing, when bets are off, while a level is missing, and under the minimum stake', () => {
    expect(breakoutButtonState(bbase({ phase: 'placing' }))).toMatchObject({ canPlace: false, label: 'Placing both orders', blockedBy: 'placing' });
    expect(breakoutButtonState(bbase({ readOnly: true }))).toMatchObject({ canPlace: false, blockedBy: 'readonly' });
    expect(breakoutButtonState(bbase({ high: undefined }))).toMatchObject({ canPlace: false, blockedBy: 'loading' });
    expect(breakoutButtonState(bbase({ stake: 0.5 }))).toMatchObject({ canPlace: false, blockedBy: 'stake', label: 'Stake at least $1' });
  });

  // A breakout costs more the closer its levels are, so both of its price refusals ask for levels further apart.
  const cases: Array<[RefusalCode, RegExp, RegExp]> = [
    ['no_price', /further apart/i, /no sensible price for finishing outside/],
    ['price_too_high', /further apart/i, /close to certain/],
    ['markup_too_high', /other levels/i, /too far apart for a fair deal/],
    ['ladder_out_of_order', /out of step/i, /out of order/],
    ['one_sided_book', /no market/i, /Nobody is buying or selling/],
  ];
  for (const [code, label, text] of cases) {
    it(`an executor refusal (${code}) names its cause and the way out`, () => {
      const s = breakoutButtonState(bbase({ answer: refused(code) }));
      expect(s.canPlace).toBe(false);
      expect(s.blockedBy).toBe(code);
      expect(s.label).toMatch(label);
      expect(s.notice?.tone).toBe('bad');
      expect(s.notice?.text).toMatch(text);
      expect(`${s.label} ${s.notice?.text}`).not.toMatch(/target|condition|closer|narrower|floor|ceiling/i);
    });
  }

  it('market_closed says what kind of not open, from the levels themselves', () => {
    const postOnly = { ...HI, open: false, state: 'active/post_only' };
    const s = breakoutButtonState(bbase({ high: postOnly, answer: refused('market_closed') }));
    expect(s).toMatchObject({ canPlace: false, blockedBy: 'market_closed' });
    expect(s.notice?.text).toMatch(/few minutes/);
  });

  it('a refusal with no known code, and a failed quote request, both speak of a breakout', () => {
    const s = breakoutButtonState(bbase({ answer: answer({ offerable: false, verdict: 'refuse', reasons: [] }, null) }));
    expect(s).toMatchObject({ canPlace: false, label: 'Not on offer' });
    expect(s.notice?.text).toMatch(/breakout/);
    const t = breakoutButtonState(bbase({ answer: null, answerError: true }));
    expect(t).toMatchObject({ canPlace: false, blockedBy: 'unreachable', label: 'Prices unavailable' });
    expect(t.notice?.text).toMatch(/breakout/);
  });

  it('never shows a zero price: a breakout the book cannot fill is refused as thin', () => {
    for (const p of [plan({ cost: 0, contracts: 0 }), plan({ cost: 0.62, contracts: 1, reduced: true })]) {
      const s = breakoutButtonState(bbase({ answer: answer({}, p) }));
      expect(s).toMatchObject({ canPlace: false, blockedBy: 'thin', label: 'Not enough on the market' });
      expect(s.label).not.toMatch(/\$0\.00/);
    }
  });

  it('is not live on an estimate alone, and refuses early only on what the local numbers settle', () => {
    expect(breakoutButtonState(bbase({ answer: null }))).toMatchObject({ canPlace: false, blockedBy: 'checking', label: 'Checking the price', notice: null });

    const shut = { ...HI, open: false, state: 'active/post_only' };
    expect(breakoutButtonState(bbase({ answer: null, high: shut })).blockedBy).toBe('market_closed');
    expect(breakoutButtonState(bbase({ answer: null, low: { ...LO, bid: null }, est: null })).blockedBy).toBe('one_sided_book');

    // Two levels so close that the pair costs a dollar: no price, and the way out is levels further apart.
    const near = rung(62500, 0.7, 0.74);
    const none = breakoutButtonState(bbase({ answer: null, high: near, est: estOf(LO, near) }));
    expect(none.blockedBy).toBe('no_price');
    expect(none.label).toMatch(/further apart/i);

    // Both levels far below the price: finishing outside is all but sure.
    const lo = rung(60000, 0.97, 0.99);
    const hi = rung(60500, 0.93, 0.95);
    const sure = estOf(lo, hi);
    expect(sure?.code).toBe('price_too_high');
    expect(breakoutButtonState(bbase({ answer: null, low: lo, high: hi, est: sure })).blockedBy).toBe('price_too_high');
  });

  it('an executor refusal overrules a hopeful estimate', () => {
    expect(breakoutButtonState(bbase({ answer: refused('markup_too_high') })).canPlace).toBe(false);
  });
});
