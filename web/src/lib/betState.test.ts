import { describe, expect, it } from 'vitest';
import type { OfferQuote, QuoteResponse, RefusalCode, Rung, StakePlan } from '../api/types';
import { buttonState, firstReason, localRefusal, type BetInputs } from './betState';
import { estimate } from './pricing';

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
    ['market_closed', /not open/i, /few minutes/],
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
