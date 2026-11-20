/**
 * In-browser stand-in for the executor and the chain service, with the same
 * response shapes (see `types.ts`). The UI labels everything it serves as demo
 * data. It exists so the product can be built, reviewed and demoed before the
 * hosted services are ready, and as the offline fallback for a bad network.
 *
 * Prices are generated from a drifting spot with a normal-distribution ladder;
 * quotes use the same maths as the executor (`lib/pricing.ts`).
 */
import { dateTime } from '../lib/format';
import { breakoutEstimate, breakoutOutcomesFor, estimate, feeRate, mirrorBook, PRODUCTION_FEE_COEF, rangeEstimate, rangeOutcomesFor } from '../lib/pricing';
import { ApiError, type Api } from './client';
import type {
  BasketLegRequest,
  Bet,
  BreakoutQuote,
  BreakoutQuoteResponse,
  CallRecord,
  CashOutQuote,
  Direction,
  LeaderboardResponse,
  LeaderboardRow,
  MarketEvent,
  OfferQuote,
  Pair,
  PairLeg,
  PlaceBasketRequest,
  PlaceBetRequest,
  Product,
  QuoteResponse,
  RangeQuote,
  RangeQuoteResponse,
  Rung,
} from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cents = (x: number) => Math.round(x * 100) / 100;

/**
 * What the demo data says a bet would sell for: each order at two cents under what it cost, which is roughly what
 * crossing the spread back costs on a real book. The real figure comes from the executor's `GET /cashout`.
 */
function mockCashOutQuote(bet: Bet): CashOutQuote {
  const base = { betId: bet.id, asOf: new Date().toISOString(), stake: cents(bet.cost), proceedsAtProductionFees: null };
  if (bet.status !== 'open') {
    const reason = bet.status === 'cashed_out' ? 'This bet has already been cashed out.' : `This bet is "${bet.status}", so there is nothing to sell.`;
    return { ...base, available: false, code: 'not_open', reason, proceeds: null, pnl: null, legs: [] };
  }
  const legs = bet.legs
    .filter((l) => (l.role === 'outcome' || l.role === 'hedge') && l.quantityFilled > 0 && l.avgPrice !== null)
    .map((l) => ({
      role: l.role as 'outcome' | 'hedge',
      symbol: l.symbol,
      outcome: l.outcome,
      quantity: l.quantityFilled,
      price: Math.max(0.01, cents((l.avgPrice ?? 0) - 0.02)),
      available: 1000,
    }));
  const proceeds = cents(legs.reduce((sum, l) => sum + l.quantity * l.price, 0));
  return { ...base, available: true, code: null, reason: null, proceeds, pnl: cents(proceeds - base.stake), proceedsAtProductionFees: cents(proceeds * 0.985), legs };
}

// ------------------------------------------------------------------ ladders

interface Asset {
  key: string;
  name: string;
  spot: number;
  step: number;
  lowest: number;
  rungs: number;
  sigma: number;
  money: (k: number) => string;
}

const dollars = (k: number) => `$${k.toLocaleString('en-US')}`;
const ASSETS: Asset[] = [
  { key: 'BTC', name: 'Bitcoin', spot: 63240, step: 500, lowest: 61500, rungs: 8, sigma: 0.012, money: dollars },
  { key: 'ETH', name: 'Ethereum', spot: 1806, step: 20, lowest: 1740, rungs: 8, sigma: 0.012, money: dollars },
  { key: 'SOL', name: 'Solana', spot: 142, step: 2, lowest: 132, rungs: 8, sigma: 0.016, money: dollars },
];

// Abramowitz-Stegun approximation of the normal CDF.
function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function nextHour(now: Date): Date {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

/** The spot drifts a little so the ladder moves while you watch. */
const spotNow = (a: Asset, t: number) => a.spot * (1 + 0.0011 * Math.sin(t / 15000 + a.step) + 0.0006 * Math.sin(t / 4100));

export const mockSpot = (key: string, t = Date.now()) => {
  const a = ASSETS.find((x) => x.key === key) ?? ASSETS[0]!;
  return spotNow(a, t);
};

function buildRungs(a: Asset, eventTicker: string, t: number): Rung[] {
  const s = spotNow(a, t);
  const out: Rung[] = [];
  for (let i = 0; i < a.rungs; i++) {
    const strike = a.lowest + i * a.step;
    const mid = 1 - normCdf(Math.log(strike / s) / a.sigma);
    const half = 0.02 - 0.01 * 4 * mid * (1 - mid);
    const bid = Math.max(0.01, cents(Math.floor((mid - half) * 100) / 100));
    const ask = Math.min(0.99, cents(Math.ceil((mid + half) * 100) / 100));
    out.push({
      symbol: `GEMI-${eventTicker}-HI${strike}`,
      label: `${a.money(strike)} or above`,
      strike,
      bid,
      ask,
      open: true,
      state: 'active/open',
    });
  }
  return out;
}

function toLeg(r: Rung): PairLeg {
  return { symbol: r.symbol, label: r.label, strike: r.strike, bid: r.bid, ask: r.ask };
}

/** A rung as a bet going `direction` sees it: a falling bet reads the same contract from its NO side. */
const asSeen = (r: Rung, direction: Direction): Rung => (direction === 'down' ? { ...r, ...mirrorBook(r) } : r);

/** The offer rule's numbers for a parlay. The books are as the bet sees them (see `asSeen`). */
function offerFrom(cond: Rung, target: Rung): OfferQuote {
  const e = estimate({ bid: cond.bid, ask: cond.ask }, { bid: target.bid, ask: target.ask }, 0);
  const base = { feeCoefCharged: 0 };
  if (e === null) {
    return {
      ...base,
      verdict: 'refuse',
      reasons: [{ code: 'no_price', message: 'The outcome costs as much as the condition.' }],
      warnings: [],
      offerable: false,
      overridden: false,
      chanceCondition: null,
      chanceBothHappen: null,
      fairPrice: null,
      pricePaid: null,
      allInPrice: null,
      markup: null,
      markupPct: null,
      cashOutPer100: null,
      cashOutPer100AtProductionFees: null,
    };
  }
  return {
    ...base,
    verdict: e.verdict,
    reasons: e.refusal ? [{ code: 'markup_too_high', message: e.refusal }] : [],
    warnings: e.verdict === 'warn' ? [`Costs ${(e.markup * 100).toFixed(1)} cents (${(e.markupPct * 100).toFixed(1)}%) more than the fair price with fees.`] : [],
    offerable: e.verdict !== 'refuse',
    overridden: false,
    chanceCondition: e.chanceCondition,
    chanceBothHappen: e.chanceBothHappen,
    fairPrice: e.fairPrice,
    pricePaid: e.pricePaid,
    allInPrice: e.allIn,
    markup: e.markup,
    markupPct: e.markupPct,
    cashOutPer100: e.cashOutPer100,
    cashOutPer100AtProductionFees: null,
  };
}

/** The offer rule's numbers for a range between two strikes. */
function rangeOfferFrom(low: Rung, high: Rung): RangeQuote {
  const e = rangeEstimate({ bid: low.bid, ask: low.ask }, { bid: high.bid, ask: high.ask }, 0);
  const base = { feeCoefCharged: 0, overridden: false };
  if (e === null) {
    return {
      ...base,
      verdict: 'refuse',
      reasons: [{ code: 'no_price', message: 'The two prices leave no sensible range to bet on.' }],
      warnings: [],
      offerable: false,
      chanceInRange: null,
      fairPrice: null,
      pricePaid: null,
      allInPrice: null,
      markup: null,
      markupPct: null,
      cashOutPer100: null,
      cashOutPer100AtProductionFees: null,
    };
  }
  return {
    ...base,
    verdict: e.verdict,
    reasons: e.refusal && e.code ? [{ code: e.code === 'no_price' ? 'no_price' : e.code, message: e.refusal }] : [],
    warnings: e.verdict === 'warn' ? [`Costs ${(e.markup * 100).toFixed(1)} cents (${(e.markupPct * 100).toFixed(1)}%) more than the fair price with fees.`] : [],
    offerable: e.verdict !== 'refuse',
    chanceInRange: e.chanceInRange,
    fairPrice: e.fairPrice,
    pricePaid: e.pricePaid,
    allInPrice: e.allIn,
    markup: e.markup,
    markupPct: e.markupPct,
    cashOutPer100: e.cashOutPer100,
    cashOutPer100AtProductionFees: null,
  };
}

/** The offer rule's numbers for a breakout: finishing outside two strikes, either way. */
function breakoutOfferFrom(low: Rung, high: Rung): BreakoutQuote {
  const e = breakoutEstimate({ bid: low.bid, ask: low.ask }, { bid: high.bid, ask: high.ask }, 0);
  const base = { feeCoefCharged: 0, overridden: false };
  if (e === null) {
    return {
      ...base,
      verdict: 'refuse',
      reasons: [{ code: 'no_price', message: 'No sensible price exists: the pair costs a dollar or more for the dollar it can win.' }],
      warnings: [],
      offerable: false,
      chanceOutside: null,
      fairPrice: null,
      pricePaid: null,
      allInPrice: null,
      markup: null,
      markupPct: null,
      cashOutPer100: null,
      cashOutPer100AtProductionFees: null,
    };
  }
  return {
    ...base,
    verdict: e.verdict,
    reasons: e.refusal && e.code ? [{ code: e.code, message: e.refusal }] : [],
    warnings: e.verdict === 'warn' ? [`Costs ${(e.markup * 100).toFixed(1)} cents (${(e.markupPct * 100).toFixed(1)}%) more than the fair price with fees.`] : [],
    offerable: e.verdict !== 'refuse',
    chanceOutside: e.chanceOutside,
    fairPrice: e.fairPrice,
    pricePaid: e.pricePaid,
    allInPrice: e.allIn,
    markup: e.markup,
    markupPct: e.markupPct,
    cashOutPer100: e.cashOutPer100,
    cashOutPer100AtProductionFees: null,
  };
}

/** What both orders of a breakout would pay in taker fees at Gemini's production rate. The demo itself charges none. */
const breakoutProdFee = (contracts: number, low: Rung, high: Rung) =>
  cents(contracts * (feeRate(1 - (low.bid ?? 0), PRODUCTION_FEE_COEF) + feeRate(high.ask ?? 0, PRODUCTION_FEE_COEF)));

/** Every pair of a parlay going `direction`: a rising one has the lower strike as its condition, a falling one the higher. */
function pairsFor(rungs: Rung[], direction: Direction): Pair[] {
  const out: Pair[] = [];
  for (let i = 0; i < rungs.length; i++) {
    for (let j = i + 1; j < rungs.length; j++) {
      const [c, b] = direction === 'down' ? [rungs[j]!, rungs[i]!] : [rungs[i]!, rungs[j]!];
      out.push({ condition: toLeg(c), target: toLeg(b), quote: offerFrom(asSeen(c, direction), asSeen(b, direction)) });
    }
  }
  return out;
}

function buildEvent(a: Asset, t: number): MarketEvent {
  const expiry = nextHour(new Date(t));
  const ticker = `${a.key}${expiry.toISOString().slice(2, 13).replace(/[-T]/g, '')}00`;
  const rungs = buildRungs(a, ticker, t);
  const pairs = pairsFor(rungs, 'up');
  const falling = pairsFor(rungs, 'down');
  const offerable = pairs.filter((p) => p.quote.offerable);
  const fallingOfferable = falling.filter((p) => p.quote.offerable);
  const refusedByReason: Record<string, number> = {};
  for (const p of pairs) for (const r of p.quote.reasons) refusedByReason[r.code] = (refusedByReason[r.code] ?? 0) + 1;
  return {
    ticker,
    // Built from the event's own fields, in the viewer's own clock and the app's one date format, so it never goes stale
    // overnight or disagrees with the picker: "Bitcoin · Nov 20, 6 AM".
    title: `${a.name} · ${dateTime(expiry)}`,
    category: 'Crypto',
    expiry: expiry.toISOString(),
    rungs,
    ladderOutOfOrder: false,
    pairs,
    offerableCount: offerable.length,
    refusedCount: pairs.length - offerable.length,
    refusedByReason,
    down: { pairs: falling, offerableCount: fallingOfferable.length, refusedCount: falling.length - fallingOfferable.length },
  };
}

// ------------------------------------------------------------------ ids and hashes

const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fakeSignature = () => Array.from(crypto.getRandomValues(new Uint8Array(88)), (b) => B58[b % B58.length]).join('');
const fakeOrderId = () => `${Math.floor(1e17 + Math.random() * 9e17)}`;
const WORDS_A = ['quiet', 'amber', 'lucky', 'steady', 'bright', 'north', 'calm', 'swift'];
const WORDS_B = ['otter', 'heron', 'fox', 'lynx', 'wren', 'finch', 'marten', 'crane'];

/**
 * A finishing price that fits a seeded result, for bets whose result the demo data decides: four tenths of the way from one
 * level to the other, or the same distance beyond the level that settled it. A bet settled later finishes where the demo's
 * own price is.
 */
const finishNear = (from: number, to: number) => cents(from + (to - from) * 0.4);

/** Bet ids carry their product, as the executor's do (see `executor/src/bet-id.ts`). */
const idFor = (kind: { product: Product; direction: Direction }, id: string) =>
  kind.product === 'range' ? `rg-${id}` : kind.product === 'breakout' ? `bo-${id}` : kind.direction === 'down' ? `dn-${id}` : id;

/** Sells a bet back at a quote: two sell orders on its ledger, what they brought in, and the bet marked as cashed out. */
function sellBack(bet: Bet, quote: CashOutQuote & { proceeds: number }, sentAt: string): NonNullable<Bet['cashOut']> {
  quote.legs.forEach((l, i) => {
    bet.legs.push({
      clientOrderId: `gv-${bet.id}-c${i === 0 ? 'b' : 'a'}1`,
      role: 'cashout',
      symbol: l.symbol,
      side: 'sell',
      outcome: l.outcome,
      limitPrice: l.price ?? 0,
      quantityRequested: l.quantity,
      quantityFilled: l.quantity,
      avgPrice: l.price,
      fee: 0,
      status: 'filled',
      orderId: `7${hex(5)}`,
      sentAt,
    });
  });
  bet.cashOut = { at: sentAt, stake: quote.stake, proceeds: quote.proceeds, pnl: cents(quote.proceeds - quote.stake), complete: true };
  bet.status = 'cashed_out';
  return bet.cashOut;
}

// ------------------------------------------------------------------ the mock service

type Outcome = 'won' | 'refunded' | 'lost' | 'open';

export function mockApi(): Api {
  const startedAt = Date.now();
  const bets: Bet[] = [];
  const calls: CallRecord[] = [];
  let seeded = false;

  const events = (t = Date.now()) => ASSETS.map((a) => buildEvent(a, t));
  const eventOf = (ticker: string): MarketEvent => {
    const ev = events().find((e) => e.ticker === ticker);
    if (!ev) throw new ApiError(404, { error: `Gemini has no event "${ticker}".`, code: 'unknown_event' }, 'unknown');
    return ev;
  };
  const rungOf = (ev: MarketEvent, symbol: string) => ev.rungs.find((r) => r.symbol === symbol);

  const findPair = (ev: MarketEvent, condition: string, target: string, direction: Direction) => {
    const c = rungOf(ev, condition);
    const b = rungOf(ev, target);
    const ordered = c && b && (direction === 'down' ? b.strike < c.strike : b.strike > c.strike);
    if (!c || !b || !ordered) {
      throw new ApiError(400, { error: `Those two contracts are not a linked pair: the outcome strike must be ${direction === 'down' ? 'lower' : 'higher'} than the condition strike.`, code: 'not_a_linked_pair' }, 'bad pair');
    }
    return { c, b };
  };
  const findRange = (ev: MarketEvent, low: string, high: string) => {
    const l = rungOf(ev, low);
    const h = rungOf(ev, high);
    if (!l || !h || !(h.strike > l.strike)) throw new ApiError(400, { error: 'Those two contracts are not a range: the first strike must be lower than the second.', code: 'not_a_range' }, 'bad range');
    return { l, h };
  };

  /** What a parlay stake buys. `c` and `b` are the rungs as the bet sees them (see `asSeen`). */
  function plan(stake: number, c: Rung, b: Rung) {
    const offer = offerFrom(c, b);
    const price = offer.pricePaid ?? 1;
    const qB = Math.floor((stake / price) * 100) / 100;
    const qA = cents(stake); // hedge contracts equal the stake: a NO on the condition pays $1 each
    const cost = cents(qB * (b.ask ?? 0) + qA * (1 - (c.bid ?? 0)));
    const prodFee =
      Math.ceil(PRODUCTION_FEE_COEF * qB * (b.ask ?? 0) * (1 - (b.ask ?? 0)) * 100) / 100 +
      Math.ceil(PRODUCTION_FEE_COEF * qA * (1 - (c.bid ?? 0)) * (c.bid ?? 0) * 100) / 100;
    return { offer, qB, qA, cost, prodFee: cents(prodFee) };
  }

  function makeParlay(args: { id: string; ev: MarketEvent; c: Rung; b: Rung; direction: Direction; stake: number; createdAt: Date; outcome?: Outcome }): Bet {
    const { direction } = args;
    const mc = asSeen(args.c, direction);
    const mb = asSeen(args.b, direction);
    const { offer, qB, qA, cost, prodFee } = plan(args.stake, mc, mb);
    const sent = args.createdAt.toISOString();
    const id = idFor({ product: 'parlay', direction }, args.id);
    const legs: Bet['legs'] = [
      { clientOrderId: `gv-${id}-b`, role: 'outcome', symbol: args.b.symbol, side: 'buy', outcome: direction === 'down' ? 'no' : 'yes', limitPrice: mb.ask ?? 0, quantityRequested: qB, quantityFilled: qB, avgPrice: mb.ask, fee: 0, status: 'filled', orderId: fakeOrderId(), sentAt: sent },
      { clientOrderId: `gv-${id}-a1`, role: 'hedge', symbol: args.c.symbol, side: 'buy', outcome: direction === 'down' ? 'yes' : 'no', limitPrice: cents(1 - (mc.bid ?? 0)), quantityRequested: qA, quantityFilled: qA, avgPrice: cents(1 - (mc.bid ?? 0)), fee: 0, status: 'filled', orderId: fakeOrderId(), sentAt: sent },
    ];
    const bet: Bet = {
      id,
      user: 'primary',
      createdAt: sent,
      eventTicker: args.ev.ticker,
      eventTitle: args.ev.title,
      expiry: args.ev.expiry,
      product: 'parlay',
      ...(direction === 'down' ? { direction } : {}),
      condition: { symbol: args.c.symbol, label: args.c.label, strike: args.c.strike },
      target: { symbol: args.b.symbol, label: args.b.label, strike: args.b.strike },
      requestedStake: args.stake,
      quotedPrice: offer.pricePaid ?? 0,
      status: 'open',
      legs,
      cost,
      payoffs: { stake: cost, ifConditionFails: cents(qA - cost), ifBothHit: cents(qB - cost), ifConditionOnly: -cost, conditionalPrice: offer.pricePaid, hedged: true },
      offer,
      scorable: false,
      flow: { bets: 1, ordersSent: 2, ordersFilled: 2, contracts: cents(qB + qA), premium: cost, feesAtProductionRates: prodFee, feesCharged: 0 },
    };
    if (args.outcome && args.outcome !== 'open') {
      const conditionResolved = args.outcome === 'refunded' ? 'no' : 'yes';
      const targetResolved = args.outcome === 'won' ? 'yes' : 'no';
      const payout = cents((targetResolved === 'yes' ? qB : 0) + (conditionResolved === 'no' ? qA : 0));
      const [c, t] = [args.c.strike, args.b.strike];
      // Past the target for a win, back past the condition for a refund, and between the two for a loss; either way up.
      const finishedAt = args.outcome === 'won' ? finishNear(t, t + (t - c)) : args.outcome === 'refunded' ? finishNear(c, c - (t - c)) : finishNear(c, t);
      bet.status = 'settled';
      bet.scorable = true;
      bet.settlement = { conditionResolved, targetResolved, payout, pnl: cents(payout - cost), settledAt: args.ev.expiry ?? sent, finishedAt };
    }
    return bet;
  }

  function makeRange(args: { id: string; ev: MarketEvent; low: Rung; high: Rung; stake: number; createdAt: Date; outcome?: 'won' | 'lost' | 'open' }): Bet {
    const offer = rangeOfferFrom(args.low, args.high);
    const e = rangeEstimate({ bid: args.low.bid, ask: args.low.ask }, { bid: args.high.bid, ask: args.high.ask }, 0);
    const out = rangeOutcomesFor(args.stake, e?.unitCost ?? 1.5);
    const sent = args.createdAt.toISOString();
    const id = idFor({ product: 'range', direction: 'up' }, args.id);
    const noPrice = cents(1 - (args.high.bid ?? 0));
    const legs: Bet['legs'] = [
      { clientOrderId: `gv-${id}-b`, role: 'outcome', symbol: args.low.symbol, side: 'buy', outcome: 'yes', limitPrice: args.low.ask ?? 0, quantityRequested: out.contracts, quantityFilled: out.contracts, avgPrice: args.low.ask, fee: 0, status: 'filled', orderId: fakeOrderId(), sentAt: sent },
      { clientOrderId: `gv-${id}-a1`, role: 'hedge', symbol: args.high.symbol, side: 'buy', outcome: 'no', limitPrice: noPrice, quantityRequested: out.contracts, quantityFilled: out.contracts, avgPrice: noPrice, fee: 0, status: 'filled', orderId: fakeOrderId(), sentAt: sent },
    ];
    const bet: Bet = {
      id,
      user: 'primary',
      createdAt: sent,
      eventTicker: args.ev.ticker,
      eventTitle: args.ev.title,
      expiry: args.ev.expiry,
      product: 'range',
      condition: { symbol: args.low.symbol, label: args.low.label, strike: args.low.strike },
      target: { symbol: args.high.symbol, label: args.high.label, strike: args.high.strike },
      requestedStake: args.stake,
      quotedPrice: offer.pricePaid ?? 0,
      status: 'open',
      legs,
      cost: out.cost,
      payoffs: { stake: out.cost, ifBothHit: out.ifInRange, ifConditionOnly: out.ifOutside, ifInRange: out.ifInRange, ifOutside: out.ifOutside, conditionalPrice: offer.pricePaid, hedged: true },
      offer,
      scorable: false,
      flow: { bets: 1, ordersSent: 2, ordersFilled: 2, contracts: cents(out.contracts * 2), premium: out.cost, feesAtProductionRates: cents(out.contracts * 0.02), feesCharged: 0 },
    };
    if (args.outcome && args.outcome !== 'open') {
      const inRange = args.outcome === 'won';
      const payout = cents(inRange ? out.contracts * 2 : out.contracts);
      const [lo, hi] = [args.low.strike, args.high.strike];
      bet.status = 'settled';
      bet.scorable = true;
      bet.settlement = { conditionResolved: 'yes', targetResolved: inRange ? 'yes' : 'no', payout, pnl: cents(payout - out.cost), settledAt: args.ev.expiry ?? sent, finishedAt: inRange ? finishNear(lo, hi) : finishNear(hi, hi + (hi - lo)) };
    }
    return bet;
  }

  /**
   * A breakout as the executor records it: the first order is the YES on the higher strike and the second the NO on the lower,
   * the same size. The strikes are named as a range names them, lower as `condition` and higher as `target`.
   */
  function makeBreakout(args: { id: string; ev: MarketEvent; low: Rung; high: Rung; stake: number; createdAt: Date; outcome?: 'won' | 'lost' | 'open' }): Bet {
    const offer = breakoutOfferFrom(args.low, args.high);
    const out = breakoutOutcomesFor(args.stake, offer.pricePaid ?? 0.5);
    const sent = args.createdAt.toISOString();
    const id = idFor({ product: 'breakout', direction: 'up' }, args.id);
    const noPrice = cents(1 - (args.low.bid ?? 0));
    const legs: Bet['legs'] = [
      { clientOrderId: `gv-${id}-b`, role: 'outcome', symbol: args.high.symbol, side: 'buy', outcome: 'yes', limitPrice: args.high.ask ?? 0, quantityRequested: out.contracts, quantityFilled: out.contracts, avgPrice: args.high.ask, fee: 0, status: 'filled', orderId: fakeOrderId(), sentAt: sent },
      { clientOrderId: `gv-${id}-a1`, role: 'hedge', symbol: args.low.symbol, side: 'buy', outcome: 'no', limitPrice: noPrice, quantityRequested: out.contracts, quantityFilled: out.contracts, avgPrice: noPrice, fee: 0, status: 'filled', orderId: fakeOrderId(), sentAt: sent },
    ];
    const bet: Bet = {
      id,
      user: 'primary',
      createdAt: sent,
      eventTicker: args.ev.ticker,
      eventTitle: args.ev.title,
      expiry: args.ev.expiry,
      product: 'breakout',
      condition: { symbol: args.low.symbol, label: args.low.label, strike: args.low.strike },
      target: { symbol: args.high.symbol, label: args.high.label, strike: args.high.strike },
      requestedStake: args.stake,
      quotedPrice: offer.pricePaid ?? 0,
      status: 'open',
      legs,
      cost: out.cost,
      payoffs: { stake: out.cost, ifBothHit: out.ifOutside, ifConditionOnly: out.ifInRange, ifInRange: out.ifInRange, ifOutside: out.ifOutside, conditionalPrice: offer.pricePaid, hedged: true },
      offer,
      scorable: false,
      flow: { bets: 1, ordersSent: 2, ordersFilled: 2, contracts: cents(out.contracts * 2), premium: out.cost, feesAtProductionRates: breakoutProdFee(out.contracts, args.low, args.high), feesCharged: 0 },
    };
    if (args.outcome && args.outcome !== 'open') {
      // Never refunded: the "condition" always reads yes, and the target says whether it finished outside.
      const outside = args.outcome === 'won';
      const payout = cents(outside ? out.contracts : 0);
      const [lo, hi] = [args.low.strike, args.high.strike];
      bet.status = 'settled';
      bet.scorable = true;
      bet.settlement = { conditionResolved: 'yes', targetResolved: outside ? 'yes' : 'no', payout, pnl: cents(payout - out.cost), settledAt: args.ev.expiry ?? sent, finishedAt: outside ? finishNear(hi, hi + (hi - lo)) : finishNear(lo, hi) };
    }
    return bet;
  }

  /** The bet's call, as the chain service records it. */
  function callFor(bet: Bet, outcome?: Outcome): CallRecord {
    const call: CallRecord = {
      id: `call-${bet.id}`,
      handle: 'you',
      betId: bet.id,
      state: 'committed',
      commitHash: hex(32),
      commitSignature: fakeSignature(),
      committedAt: bet.createdAt,
      network: 'fake',
    };
    if (outcome === 'won' || outcome === 'lost') {
      const fair = bet.offer?.fairPrice ?? 0.5;
      const o = outcome === 'won' ? 1 : 0;
      call.state = 'revealed';
      call.reveal = { signature: fakeSignature(), revealedAt: new Date(Date.now() - 1800_000).toISOString(), eventTitle: bet.eventTitle, conditionLabel: bet.condition.label, targetLabel: bet.target.label, fairPriceAtEntry: fair, outcome: o, edge: cents(o - fair) };
    }
    if (outcome === 'refunded') call.state = 'void';
    return call;
  }

  function seed() {
    if (seeded) return;
    seeded = true;
    const base = events();
    const btc = base[0]!;
    const eth = base[1]!;
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
    const stale = (b: Bet) => (b.eventTitle = b.eventTitle.replace(/at \d+(am|pm)/, (_, ap) => `at ${ap === 'am' ? '9am' : '2pm'}`));
    const pick = (ev: MarketEvent, ci: number, bi: number) => ({ ev, c: ev.rungs[ci]!, b: ev.rungs[bi]! });
    const parlays: [Outcome, ReturnType<typeof pick>, Direction, number, number][] = [
      ['won', pick(btc, 1, 3), 'up', 25, 5],
      ['refunded', pick(btc, 5, 6), 'up', 25, 4],
      ['lost', pick(eth, 2, 3), 'up', 15, 3],
      ['open', pick(btc, 3, 5), 'up', 20, 0.3],
    ];
    parlays.forEach(([outcome, p, direction, stake, ago], i) => {
      const bet = makeParlay({ id: `demo${i + 1}`, ev: p.ev, c: p.c, b: p.b, direction, stake, createdAt: hoursAgo(ago), outcome });
      if (i !== 3) stale(bet);
      bets.push(bet);
      calls.push(callFor(bet, outcome));
    });
    // A range that finished inside, and a basket still open, so every product has something to show.
    const range = makeRange({ id: 'demo5', ev: eth, low: eth.rungs[2]!, high: eth.rungs[5]!, stake: 20, createdAt: hoursAgo(6), outcome: 'won' });
    stale(range);
    bets.push(range);
    calls.push(callFor(range, 'won'));
    const sol = base[2]!;
    // And a breakout that finished between its two levels, so the bet with no money back shows what that looks like.
    const breakout = makeBreakout({ id: 'demo9', ev: sol, low: sol.rungs[4]!, high: sol.rungs[6]!, stake: 10, createdAt: hoursAgo(7), outcome: 'lost' });
    stale(breakout);
    bets.push(breakout);
    calls.push(callFor(breakout, 'lost'));
    // A bet that was sold back before its market settled, and whose market has settled since: the call came off, so it can
    // still be revealed and scored even though the bet itself was never paid.
    const sold = makeParlay({ id: 'demo10', ev: eth, c: eth.rungs[1]!, b: eth.rungs[3]!, direction: 'up', stake: 20, createdAt: hoursAgo(2.5) });
    stale(sold);
    const sale = mockCashOutQuote(sold);
    if (sale.proceeds !== null) {
      sellBack(sold, { ...sale, proceeds: sale.proceeds }, hoursAgo(2.2).toISOString());
      const [c, t] = [sold.condition.strike, sold.target.strike];
      sold.called = { conditionResolved: 'yes', targetResolved: 'yes', at: hoursAgo(1.5).toISOString(), finishedAt: finishNear(t, t + (t - c)) };
      sold.scorable = true;
    }
    bets.push(sold);
    calls.push(callFor(sold));
    const legs: Bet[] = [
      makeParlay({ id: 'demo6', ev: btc, c: btc.rungs[2]!, b: btc.rungs[4]!, direction: 'up', stake: 10, createdAt: hoursAgo(0.2) }),
      makeParlay({ id: 'demo7', ev: eth, c: eth.rungs[5]!, b: eth.rungs[3]!, direction: 'down', stake: 10, createdAt: hoursAgo(0.2) }),
      makeRange({ id: 'demo8', ev: sol, low: sol.rungs[2]!, high: sol.rungs[5]!, stake: 10, createdAt: hoursAgo(0.2) }),
    ];
    legs.forEach((bet, index) => {
      bet.basket = { id: 'bk-demo', name: 'Majors, a quiet hour', index, size: legs.length };
      bets.push(bet);
      calls.push(callFor(bet));
    });
  }

  const handleFor = (i: number) => `${WORDS_A[i % WORDS_A.length]}-${WORDS_B[(i * 3 + 1) % WORDS_B.length]}-${(i * 37 + 11) % 90}`;

  /** Places one leg: the bet a parlay, range or breakout request describes, refused the way the executor refuses. */
  function placeOne(req: PlaceBetRequest | (BasketLegRequest & { user?: string })): Bet {
    if (req.stake > 100) throw new ApiError(400, { error: 'Demo bets are capped at $100.', code: 'invalid_stake' }, 'stake');
    const ev = eventOf(req.event);
    if ('product' in req && req.product === 'range') {
      const { l, h } = findRange(ev, req.low, req.high);
      const offer = rangeOfferFrom(l, h);
      if (!offer.offerable) throw new ApiError(422, { error: offer.reasons[0]?.message ?? 'This bet is not on offer.', code: offer.reasons[0]?.code ?? 'offer_refused', refused: true, quote: offer }, 'refused');
      return makeRange({ id: `d${hex(3)}`, ev, low: l, high: h, stake: req.stake, createdAt: new Date() });
    }
    if ('product' in req && req.product === 'breakout') {
      const { l, h } = findRange(ev, req.low, req.high);
      const offer = breakoutOfferFrom(l, h);
      if (!offer.offerable) throw new ApiError(422, { error: offer.reasons[0]?.message ?? 'This bet is not on offer.', code: offer.reasons[0]?.code ?? 'offer_refused', refused: true, quote: offer }, 'refused');
      return makeBreakout({ id: `d${hex(3)}`, ev, low: l, high: h, stake: req.stake, createdAt: new Date() });
    }
    const parlay = req as Extract<PlaceBetRequest, { condition: string }>;
    const direction = parlay.direction ?? 'up';
    const { c, b } = findPair(ev, parlay.condition, parlay.target, direction);
    const offer = offerFrom(asSeen(c, direction), asSeen(b, direction));
    if (!offer.offerable) throw new ApiError(422, { error: offer.reasons[0]?.message ?? 'This bet is not on offer.', code: offer.reasons[0]?.code ?? 'offer_refused', refused: true, quote: offer }, 'refused');
    return makeParlay({ id: `d${hex(3)}`, ev, c, b, direction, stake: parlay.stake, createdAt: new Date() });
  }

  return {
    mode: 'mock',

    async health() {
      // The demo refuses a bet above $100, as the real services do when they set a limit, so it says so the same way.
      return { ok: true, venue: 'Demo data', sandbox: true, maxStake: 100, users: [{ user: 'primary', connected: true }], time: new Date().toISOString() };
    },

    async markets(event) {
      await sleep(120);
      seed();
      const all = events();
      const evs = event ? all.filter((e) => e.ticker === event) : all;
      if (event && evs.length === 0) throw new ApiError(404, { error: `Gemini has no event "${event}".`, code: 'unknown_event' }, 'unknown');
      return {
        venue: 'Demo data',
        asOf: new Date().toISOString(),
        feeCoefCharged: 0,
        totals: { events: evs.length, eventsWithOffers: evs.filter((e) => e.offerableCount > 0).length, offerable: evs.reduce((n, e) => n + e.offerableCount, 0), refused: evs.reduce((n, e) => n + e.refusedCount, 0) },
        events: evs,
      };
    },

    async quote({ event, condition, target, stake, direction = 'up' }): Promise<QuoteResponse> {
      await sleep(180);
      const ev = eventOf(event);
      const { c, b } = findPair(ev, condition, target, direction);
      const mc = asSeen(c, direction);
      const mb = asSeen(b, direction);
      const offer = offerFrom(mc, mb);
      let stakePlan: QuoteResponse['stake'] = null;
      let depth: QuoteResponse['depth'] = null;
      if (stake !== undefined && offer.pricePaid !== null) {
        const p = plan(stake, mc, mb);
        const maxStake = 40 + Math.round(Math.abs(Math.sin(c.strike)) * 60);
        depth = { outcomeAvailable: 120, conditionAvailable: 400, maxStake };
        const capped = Math.min(stake, maxStake);
        const pc = plan(capped, mc, mb);
        stakePlan = {
          requested: stake,
          reduced: capped < stake,
          outcomeContracts: pc.qB,
          hedgeContracts: pc.qA,
          cost: pc.cost,
          ifBothHit: cents(pc.qB - pc.cost),
          ifConditionFails: cents(pc.qA - pc.cost),
          ifConditionOnly: -pc.cost,
          feesAtProductionRates: p.prodFee,
          cashOutNow: offer.cashOutPer100 === null ? null : cents((offer.cashOutPer100 * pc.cost) / 100),
        };
      }
      return { venue: 'Demo data', asOf: new Date().toISOString(), product: 'parlay', direction, event: { ticker: ev.ticker, title: ev.title, expiry: ev.expiry }, condition: toLeg(c), target: toLeg(b), quote: offer, stake: stakePlan, depth };
    },

    async quoteRange({ event, low, high, stake }): Promise<RangeQuoteResponse> {
      await sleep(180);
      const ev = eventOf(event);
      const { l, h } = findRange(ev, low, high);
      const offer = rangeOfferFrom(l, h);
      const e = rangeEstimate({ bid: l.bid, ask: l.ask }, { bid: h.bid, ask: h.ask }, 0);
      let stakePlan: RangeQuoteResponse['stake'] = null;
      let depth: RangeQuoteResponse['depth'] = null;
      if (stake !== undefined && e !== null) {
        const maxStake = 40 + Math.round(Math.abs(Math.sin(l.strike)) * 60);
        depth = { outcomeAvailable: 120, conditionAvailable: 400, maxStake };
        const capped = Math.min(stake, maxStake);
        const o = rangeOutcomesFor(capped, e.unitCost);
        stakePlan = {
          requested: stake,
          reduced: capped < stake,
          contracts: o.contracts,
          cost: o.cost,
          backAlways: o.backAlways,
          ifInRange: o.ifInRange,
          ifOutside: o.ifOutside,
          feesAtProductionRates: cents(o.contracts * 0.02),
          cashOutNow: offer.cashOutPer100 === null ? null : cents((offer.cashOutPer100 * o.cost) / 100),
        };
      }
      return { venue: 'Demo data', asOf: new Date().toISOString(), product: 'range', event: { ticker: ev.ticker, title: ev.title, expiry: ev.expiry }, low: toLeg(l), high: toLeg(h), quote: offer, stake: stakePlan, depth };
    },

    async quoteBreakout({ event, low, high, stake }): Promise<BreakoutQuoteResponse> {
      await sleep(180);
      const ev = eventOf(event);
      const { l, h } = findRange(ev, low, high);
      const offer = breakoutOfferFrom(l, h);
      let stakePlan: BreakoutQuoteResponse['stake'] = null;
      let depth: BreakoutQuoteResponse['depth'] = null;
      if (stake !== undefined && offer.pricePaid !== null) {
        const maxStake = 40 + Math.round(Math.abs(Math.sin(l.strike)) * 60);
        depth = { outcomeAvailable: 120, conditionAvailable: 400, maxStake };
        const capped = Math.min(stake, maxStake);
        const o = breakoutOutcomesFor(capped, offer.pricePaid);
        stakePlan = {
          requested: stake,
          reduced: capped < stake,
          contracts: o.contracts,
          cost: o.cost,
          ifOutside: o.ifOutside,
          ifInRange: o.ifInRange,
          feesAtProductionRates: breakoutProdFee(o.contracts, l, h),
          cashOutNow: offer.cashOutPer100 === null ? null : cents((offer.cashOutPer100 * o.cost) / 100),
        };
      }
      return { venue: 'Demo data', asOf: new Date().toISOString(), product: 'breakout', event: { ticker: ev.ticker, title: ev.title, expiry: ev.expiry }, low: toLeg(l), high: toLeg(h), quote: offer, stake: stakePlan, depth };
    },

    async placeBet(req: PlaceBetRequest) {
      seed();
      await sleep(1900);
      const bet = placeOne(req);
      bets.push(bet);
      return { bet, stakeReduced: null };
    },

    async placeBasket(req: PlaceBasketRequest) {
      seed();
      if (req.legs.length < 2 || req.legs.length > 6) throw new ApiError(400, { error: 'A basket needs from 2 to 6 legs.', code: 'invalid_legs' }, 'legs');
      // Every leg is checked before the first is placed, so a basket that cannot be placed is refused whole.
      const checked = req.legs.map((leg, i) => {
        try {
          return placeOne({ ...leg, user: req.user });
        } catch (err) {
          if (err instanceof ApiError) throw new ApiError(err.status, { ...(err.body ?? { error: err.message, code: err.code }), error: `Leg ${i + 1}: ${err.message}`, leg: i }, err.message);
          throw err;
        }
      });
      await sleep(900 * checked.length);
      const id = `bk-${hex(3)}`;
      const name = req.name?.trim() || undefined;
      checked.forEach((bet, index) => {
        bet.basket = { id, ...(name ? { name } : {}), index, size: checked.length };
        bets.push(bet);
      });
      return { basket: { id, name: name ?? null, size: checked.length, failed: null }, bets: checked };
    },

    async cashOutQuote(betId: string) {
      seed();
      await sleep(350);
      const bet = bets.find((b) => b.id === betId);
      if (!bet) throw new ApiError(404, { error: `No bet "${betId}".`, code: 'unknown_bet' }, 'unknown bet');
      return mockCashOutQuote(bet);
    },

    async cashOut(betId: string, minProceeds?: number) {
      seed();
      const bet = bets.find((b) => b.id === betId);
      if (!bet) throw new ApiError(404, { error: `No bet "${betId}".`, code: 'unknown_bet' }, 'unknown bet');
      const quote = mockCashOutQuote(bet);
      if (!quote.available || quote.proceeds === null) {
        throw new ApiError(quote.code === 'not_open' ? 409 : 422, { error: quote.reason ?? 'This bet cannot be cashed out right now.', code: quote.code ?? 'not_open' }, 'refused');
      }
      if (minProceeds !== undefined && quote.proceeds < minProceeds - 0.005) {
        throw new ApiError(422, { error: `Selling now would bring in ${quote.proceeds.toFixed(2)} dollars, below the ${minProceeds.toFixed(2)} you asked for. Nothing was sold.`, code: 'below_minimum' }, 'refused');
      }
      await sleep(1400);
      const cashOut = sellBack(bet, { ...quote, proceeds: quote.proceeds }, new Date().toISOString());
      return { bet, cashOut };
    },

    async bets() {
      seed();
      await sleep(100);
      // A copy, as a server's answer is. The bets here are changed in place when they are sold or settle; handing out the
      // same objects let a page's old answer change underneath it, so its next answer looked like no news and the figures
      // above the list stayed as they were.
      return { bets: structuredClone([...bets].reverse()) };
    },

    async settle() {
      seed();
      await sleep(900);
      const settled: Bet[] = [];
      // Sold-back bets whose market now has a result: nothing is paid, only how the call turned out is written down.
      const called: Bet[] = [];
      for (const bet of bets) {
        const soldBack = bet.status === 'cashed_out' && !bet.called;
        if ((bet.status !== 'open' && !soldBack) || Date.now() - new Date(bet.createdAt).getTime() < 15_000) continue;
        const a = ASSETS.find((x) => bet.eventTitle.startsWith(x.name)) ?? ASSETS[0]!;
        const s = spotNow(a, Date.now());
        const qOutcome = bet.legs[0]?.quantityFilled ?? 0;
        const qHedge = bet.legs[1]?.quantityFilled ?? 0;
        let conditionResolved: 'yes' | 'no';
        let targetResolved: 'yes' | 'no';
        let payout: number;
        if (bet.product === 'range') {
          const inside = s >= bet.condition.strike && s < bet.target.strike;
          conditionResolved = 'yes';
          targetResolved = inside ? 'yes' : 'no';
          payout = cents(inside ? qOutcome + qHedge : Math.min(qOutcome, qHedge));
        } else if (bet.product === 'breakout') {
          // The YES on the higher strike pays at or above it, the NO on the lower strike below it, and neither in between.
          const above = s >= bet.target.strike;
          const below = s < bet.condition.strike;
          conditionResolved = 'yes';
          targetResolved = above || below ? 'yes' : 'no';
          payout = cents(above ? qOutcome : below ? qHedge : 0);
        } else {
          const falling = bet.direction === 'down';
          conditionResolved = (falling ? s < bet.condition.strike : s >= bet.condition.strike) ? 'yes' : 'no';
          targetResolved = (falling ? s < bet.target.strike : s >= bet.target.strike) ? 'yes' : 'no';
          payout = cents((targetResolved === 'yes' ? qOutcome : 0) + (conditionResolved === 'no' ? qHedge : 0));
        }
        const call = calls.find((c) => c.betId === bet.id);
        if (call && call.state === 'committed' && conditionResolved === 'no') call.state = 'void';
        bet.scorable = true;
        if (soldBack) {
          // The bet stays cashed out: it was sold, so it is never paid. Its call still has a result, as the executor records.
          bet.called = { conditionResolved, targetResolved, at: new Date().toISOString(), finishedAt: cents(s) };
          called.push(bet);
          continue;
        }
        bet.status = 'settled';
        bet.settlement = { conditionResolved, targetResolved, payout, pnl: cents(payout - bet.cost), settledAt: new Date().toISOString(), finishedAt: cents(s) };
        settled.push(bet);
      }
      // `called` is what the executor's POST /settle also answers with; the client's type does not list it yet.
      const result = { settled, needsReview: [], stillOpen: bets.filter((b) => b.status === 'open').length, called };
      return result;
    },

    async flow() {
      seed();
      await sleep(80);
      const real = bets.filter((b) => b.status !== 'failed');
      return {
        venue: 'Demo data',
        user: null,
        bets: real.length,
        ordersSent: real.reduce((n, b) => n + b.flow.ordersSent, 0),
        ordersFilled: real.reduce((n, b) => n + b.flow.ordersFilled, 0),
        contracts: cents(real.reduce((n, b) => n + b.flow.contracts, 0)),
        premium: cents(real.reduce((n, b) => n + b.flow.premium, 0)),
        feesAtProductionRates: cents(real.reduce((n, b) => n + b.flow.feesAtProductionRates, 0)),
        feesCharged: 0,
        productionFeeCoef: PRODUCTION_FEE_COEF,
        note: 'Demo data. On the Gemini sandbox no fees are charged; the fee figure is what the same fills would pay at Gemini\'s published taker rate.',
      };
    },

    async reconcile() {
      seed();
      await sleep(1100);
      const cost = cents(bets.reduce((n, b) => n + b.cost, 0));
      return {
        venue: 'Demo data',
        checkedAt: new Date().toISOString(),
        user: 'primary',
        ordersChecked: bets.length * 2,
        ordersMatched: bets.length * 2,
        mismatches: [],
        untrackedOrders: 0,
        untrackedCashFlow: 0,
        baselineCash: 1000,
        expectedCash: cents(1000 - cost),
        actualCash: cents(1000 - cost),
        cashDifference: 0,
        betsNeedingReview: [],
        ok: true,
      };
    },

    async commitCall(betId) {
      seed();
      await sleep(1100);
      const existing = calls.find((c) => c.betId === betId);
      if (existing) return existing;
      const bet = bets.find((b) => b.id === betId);
      const call: CallRecord = { id: `call-${hex(3)}`, handle: 'you', betId, state: 'committed', commitHash: hex(32), commitSignature: fakeSignature(), committedAt: bet?.createdAt ?? new Date().toISOString(), network: 'fake' };
      calls.push(call);
      return call;
    },

    async revealCall(callId) {
      seed();
      await sleep(1200);
      const call = calls.find((c) => c.id === callId);
      const bet = call && bets.find((b) => b.id === call.betId);
      if (!call || !bet) throw new ApiError(404, { error: 'No such call.', code: 'not_found' }, 'missing');
      if (call.state === 'revealed') return call;
      // As the chain service does it: a settled bet is scored from its settlement, and a bet that was sold back from how its
      // call turned out, once the market has said. Until then a sold-back call stays sealed.
      const result = bet.settlement ?? (bet.status === 'cashed_out' ? bet.called : undefined);
      if (!result && bet.status === 'cashed_out') {
        throw new ApiError(409, { error: 'This bet was sold back before its market settled. Its call can be revealed once the market has settled.', code: 'cashed_out' }, 'sold');
      }
      if (!result) throw new ApiError(409, { error: 'This bet has not settled yet, so there is nothing to reveal.', code: 'not_settled' }, 'open');
      if (result.conditionResolved === 'no') {
        call.state = 'void';
        // A bet still held got its stake back; one that was sold back had already been paid what it sold for.
        throw new ApiError(409, { error: bet.settlement ? 'The first half failed, so your stake came back and this call does not count.' : 'The first half failed, so this call does not count.', code: 'void_call' }, 'void');
      }
      const fair = bet.offer?.fairPrice ?? 0.5;
      const o = result.targetResolved === 'yes' ? 1 : 0;
      call.state = 'revealed';
      call.reveal = { signature: fakeSignature(), revealedAt: new Date().toISOString(), eventTitle: bet.eventTitle, conditionLabel: bet.condition.label, targetLabel: bet.target.label, fairPriceAtEntry: fair, outcome: o, edge: cents(o - fair) };
      return call;
    },

    async reveal(signature) {
      seed();
      await sleep(120);
      const call = calls.find((c) => c.reveal?.signature === signature);
      const bet = call && bets.find((b) => b.id === call.betId);
      if (!call?.reveal || !bet) throw new ApiError(404, { error: 'No such revealed call.', code: 'unknown_reveal' }, 'missing');
      return {
        signature,
        commitSignature: call.commitSignature,
        handle: call.handle,
        betId: bet.id,
        event: bet.eventTicker,
        condition: bet.condition.symbol,
        target: bet.target.symbol,
        entryPrice: bet.quotedPrice,
        fairPrice: call.reveal.fairPriceAtEntry,
        outcome: call.reveal.outcome ?? 0,
        edge: call.reveal.edge ?? 0,
        revealedAt: call.reveal.revealedAt,
        network: 'fake',
        authority: 'DemoAuthority11111111111111111111111111111111',
      };
    },

    async calls() {
      seed();
      await sleep(80);
      // A copy for the same reason as the bets: a call changes in place when it is revealed.
      return { calls: structuredClone([...calls].reverse()) };
    },

    async leaderboard(): Promise<LeaderboardResponse> {
      seed();
      await sleep(150);
      // `sealed` is every call a player has committed, revealed or not, and `refunded` the sealed ones whose first half failed.
      // Most players have a call or two still sealed (open, or kept back); one has revealed every call; one had a refund.
      const others = [
        { calls: 9, sealed: 11, refunded: 1, edge: 2.41, hitRate: 0.67 },
        { calls: 6, sealed: 6, refunded: 0, edge: 1.77, hitRate: 0.67 },
        { calls: 11, sealed: 13, refunded: 0, edge: 1.12, hitRate: 0.55 },
        { calls: 4, sealed: 5, refunded: 0, edge: 0.58, hitRate: 0.5 },
        { calls: 7, sealed: 9, refunded: 0, edge: -0.34, hitRate: 0.43 },
      ].map((r, i) => ({ ...r, handle: handleFor(i), lastRevealedAt: new Date(startedAt - (i + 1) * 5400_000).toISOString() }));
      const own = calls.filter((c) => c.handle === 'you');
      const mine = own.filter((c) => c.state === 'revealed' && c.reveal);
      const rows: Omit<LeaderboardRow, 'rank'>[] = [...others];
      if (mine.length >= 1) {
        rows.push({
          handle: 'you',
          calls: mine.length,
          // Counted from the same calls My bets shows: every one committed, and the ones a failed first half made void.
          sealed: own.length,
          refunded: own.filter((c) => c.state === 'void').length,
          edge: cents(mine.reduce((n, c) => n + (c.reveal?.edge ?? 0), 0)),
          hitRate: mine.filter((c) => c.reveal?.outcome === 1).length / mine.length,
          lastRevealedAt: mine[mine.length - 1]!.reveal!.revealedAt,
          recent: [...mine].reverse().slice(0, 5).map((c) => {
            // The ticker and the two contract symbols a reveal publishes: the same ones `reveal()` answers with for this call.
            const bet = bets.find((b) => b.id === c.betId);
            return {
              signature: c.reveal!.signature,
              betId: c.betId,
              ...(bet ? { event: bet.eventTicker, condition: bet.condition.symbol, target: bet.target.symbol } : {}),
              revealedAt: c.reveal!.revealedAt,
              outcome: c.reveal!.outcome === 1 ? (1 as const) : (0 as const),
              edge: c.reveal!.edge ?? 0,
            };
          }),
        });
      }
      rows.sort((x, y) => y.edge - x.edge);
      // No program and no keys: demo rows exist only here, so there is nothing on Solana for the page to read.
      return { asOf: new Date().toISOString(), minCalls: 1, source: 'quicknode-stream', network: 'fake', program: null, authorities: [], rows: rows.map((r, i) => ({ rank: i + 1, ...r })) };
    },
  };
}
