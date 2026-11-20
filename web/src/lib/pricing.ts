/**
 * Instant quote estimate while a handle is being dragged.
 *
 * This is a port of the executor's maths (`executor/src/pricing.ts` and
 * `offer.ts`), so the number on screen moves the moment the user does. The
 * executor's own `/quote` answer is authoritative: the UI replaces this
 * estimate with it as soon as it arrives. `pricing.test.ts` pins this file to
 * the worked example in `executor/README.md` so the two cannot drift silently.
 */

/** Gemini's published taker fee coefficient on production. */
export const PRODUCTION_FEE_COEF = 0.07;
export const MAX_ALL_IN_PRICE = 0.95;
export const REFUSE_MARKUP_DOLLARS = 0.08;
export const REFUSE_MARKUP_FRACTION = 0.2;
export const WARN_MARKUP_DOLLARS = 0.05;
export const WARN_MARKUP_FRACTION = 0.15;

const clean = (x: number) => Math.round(x * 1e8) / 1e8;
export const feeRate = (price: number, coef: number) => (coef > 0 ? coef * price * (1 - price) : 0);

export interface Book {
  bid: number | null;
  ask: number | null;
}

/** Price of $1 "if B, given A", fees included. Null when no sensible bet exists. */
export function allInPrice(askB: number, bidA: number, coef: number): number | null {
  if (!(askB > 0) || !(bidA > 0) || bidA >= 1 || askB >= bidA) return null;
  const refundPerHedge = bidA - feeRate(1 - bidA, coef);
  if (refundPerHedge <= 0) return null;
  return clean((askB + feeRate(askB, coef)) / refundPerHedge);
}

/** What selling both legs straight back returns per $100 staked. */
export function cashOutPer100(price: number, bidB: number, askA: number, coef: number): number {
  const outcomeContracts = 100 / price;
  const noBid = 1 - askA;
  const value = outcomeContracts * (bidB - feeRate(bidB, coef)) + 100 * (noBid - feeRate(noBid, coef));
  return Math.round(clean(value) * 100) / 100;
}

export interface Estimate {
  verdict: 'ok' | 'warn' | 'refuse';
  /** Why it is refused, in plain words, or null. */
  refusal: string | null;
  /** The executor's code for that refusal, so the page can say what to do about it. */
  code: 'price_too_high' | 'markup_too_high' | null;
  chanceCondition: number;
  chanceBothHappen: number;
  fairPrice: number;
  /** Price per $1 at the venue's real fee rate. */
  pricePaid: number;
  /** Price per $1 at Gemini's production fee rate. The rule is applied to this. */
  allIn: number;
  markup: number;
  markupPct: number;
  cashOutPer100: number;
}

export function estimate(condition: Book, target: Book, venueFeeCoef: number): Estimate | null {
  const { bid: bidA, ask: askA } = condition;
  const { bid: bidB, ask: askB } = target;
  if (bidA === null || askA === null || bidB === null || askB === null) return null;
  const chanceCondition = (bidA + askA) / 2;
  const chanceBothHappen = (bidB + askB) / 2;
  if (!(chanceCondition > 0)) return null;
  const fair = chanceBothHappen / chanceCondition;
  const paid = allInPrice(askB, bidA, venueFeeCoef);
  const prod = allInPrice(askB, bidA, PRODUCTION_FEE_COEF);
  if (paid === null || prod === null) return null;
  const markup = prod - fair;
  const markupPct = markup / fair;
  let verdict: Estimate['verdict'] = 'ok';
  let refusal: string | null = null;
  let code: Estimate['code'] = null;
  if (prod >= MAX_ALL_IN_PRICE) {
    verdict = 'refuse';
    code = 'price_too_high';
    refusal = 'The payout is too small for the price. Pick a higher target.';
  } else if (markup > REFUSE_MARKUP_DOLLARS || markupPct > REFUSE_MARKUP_FRACTION) {
    verdict = 'refuse';
    code = 'markup_too_high';
    refusal = 'The spread on this pair is too wide to be a fair deal.';
  } else if (markup >= WARN_MARKUP_DOLLARS || markupPct >= WARN_MARKUP_FRACTION) {
    verdict = 'warn';
  }
  return {
    verdict,
    refusal,
    code,
    chanceCondition,
    chanceBothHappen,
    fairPrice: clean(fair),
    pricePaid: paid,
    allIn: prod,
    markup: clean(markup),
    markupPct: clean(markupPct),
    cashOutPer100: cashOutPer100(paid, bidB, askA, venueFeeCoef),
  };
}

export interface StakeOutcomes {
  cost: number;
  ifBothHit: number;
  ifConditionFails: number;
  ifConditionOnly: number;
  contracts: number;
}

/** What a stake buys at an all-in price: the three outcomes, in dollars. */
export function outcomesFor(stake: number, price: number): StakeOutcomes {
  const contracts = stake / price;
  return {
    cost: stake,
    contracts,
    ifBothHit: clean(contracts - stake),
    ifConditionFails: 0,
    ifConditionOnly: -stake,
  };
}

// ------------------------------------------------------------------ range bets

/**
 * A range bet buys YES on a lower strike and NO on a higher one, the same number of contracts of each. One of the two always
 * pays a dollar, so what is really bought is the second dollar for finishing inside the range; its price is what the pair
 * costs above the dollar that always comes back. A port of `executor/src/range.ts`, for the instant estimate while a handle
 * is dragged: the executor's own answer replaces it.
 */

/** Cash for one contract of each leg: YES on the lower strike at its ask and NO on the higher at 1 minus its bid, fees included. */
export function rangeUnitCost(askLow: number, bidHigh: number, coef: number): number {
  const noHigh = clean(1 - bidHigh);
  return clean(askLow + feeRate(askLow, coef) + noHigh + feeRate(noHigh, coef));
}

/** What the range costs for each $1 of "inside the range" payout. Null when it is not a price. */
export function rangePrice(askLow: number, bidHigh: number, coef: number): number | null {
  if (!(askLow > 0) || !(bidHigh >= 0) || askLow >= 1) return null;
  const price = clean(rangeUnitCost(askLow, bidHigh, coef) - 1);
  return price > 0 && price < 1 ? price : null;
}

export interface RangeEstimate {
  verdict: 'ok' | 'warn' | 'refuse';
  refusal: string | null;
  code: 'price_too_high' | 'markup_too_high' | 'no_price' | null;
  chanceInRange: number;
  fairPrice: number;
  /** Price per $1 of "inside the range" payout at the venue's real fee rate. */
  pricePaid: number;
  /** The same at Gemini's production fee rate. The rule is applied to this. */
  allIn: number;
  markup: number;
  markupPct: number;
  /** Cash for one contract of each leg at the venue's fee rate. */
  unitCost: number;
  cashOutPer100: number;
}

export function rangeEstimate(low: Book, high: Book, venueFeeCoef: number): RangeEstimate | null {
  if (low.bid === null || low.ask === null || high.bid === null || high.ask === null) return null;
  const chance = clean((low.bid + low.ask) / 2 - (high.bid + high.ask) / 2);
  const paid = rangePrice(low.ask, high.bid, venueFeeCoef);
  const prod = rangePrice(low.ask, high.bid, PRODUCTION_FEE_COEF);
  if (!(chance > 0) || paid === null || prod === null) return null;
  const markup = clean(prod - chance);
  const markupPct = clean(markup / chance);
  let verdict: RangeEstimate['verdict'] = 'ok';
  let refusal: string | null = null;
  let code: RangeEstimate['code'] = null;
  if (prod >= MAX_ALL_IN_PRICE) {
    verdict = 'refuse';
    code = 'price_too_high';
    // A range costs more the further apart its levels are, so the way out of a price this high is a narrower one.
    refusal = 'The range costs too much for what it can win. Pick a narrower one.';
  } else if (markup > REFUSE_MARKUP_DOLLARS || markupPct > REFUSE_MARKUP_FRACTION) {
    verdict = 'refuse';
    code = 'markup_too_high';
    refusal = 'The spread on these two prices is too wide to be a fair deal.';
  } else if (markup >= WARN_MARKUP_DOLLARS || markupPct >= WARN_MARKUP_FRACTION) {
    verdict = 'warn';
  }
  const unit = rangeUnitCost(low.ask, high.bid, venueFeeCoef);
  const contracts = 100 / unit;
  const noBid = 1 - high.ask;
  const cashOut = Math.round(clean(contracts * (low.bid - feeRate(low.bid, venueFeeCoef)) + contracts * (noBid - feeRate(noBid, venueFeeCoef))) * 100) / 100;
  return { verdict, refusal, code, chanceInRange: chance, fairPrice: chance, pricePaid: paid, allIn: prod, markup, markupPct, unitCost: unit, cashOutPer100: cashOut };
}

export interface RangeOutcomes {
  contracts: number;
  cost: number;
  /** Dollars that come back whatever happens. */
  backAlways: number;
  ifInRange: number;
  ifOutside: number;
}

/** What a stake buys of a range at a cost per contract: what comes back always, and what each result nets. */
export function rangeOutcomesFor(stake: number, unitCost: number): RangeOutcomes {
  const contracts = Math.floor((stake / unitCost) * 100) / 100;
  const cost = clean(contracts * unitCost);
  return { contracts, cost, backAlways: contracts, ifInRange: clean(2 * contracts - cost), ifOutside: clean(contracts - cost) };
}

// ------------------------------------------------------------------ breakout bets

/**
 * A breakout is the range turned inside out: YES on the HIGHER strike and NO on the LOWER one, the same number of contracts of
 * each. At or above the higher strike the YES pays a dollar, below the lower one the NO does, and in between neither pays.
 * Only one of the two can ever pay, so a pair costs less than a dollar, and what it costs IS the price of $1 for finishing
 * outside the two levels, whichever way. A port of `executor/src/breakout.ts`, for the instant estimate while a handle is
 * dragged: the executor's own answer replaces it.
 */

/** Cash for one contract of each leg: NO on the lower strike at 1 minus its bid and YES on the higher at its ask, fees included. */
export function breakoutUnitCost(bidLow: number, askHigh: number, coef: number): number {
  const noLow = clean(1 - bidLow);
  return clean(noLow + feeRate(noLow, coef) + askHigh + feeRate(askHigh, coef));
}

/** What a breakout costs for each $1 of "outside the two levels" payout: the pair's own cost. Null when it is not a price. */
export function breakoutPrice(bidLow: number, askHigh: number, coef: number): number | null {
  if (!(askHigh > 0) || !(bidLow > 0) || bidLow >= 1) return null;
  const price = breakoutUnitCost(bidLow, askHigh, coef);
  return price > 0 && price < 1 ? price : null;
}

export interface BreakoutEstimate {
  verdict: 'ok' | 'warn' | 'refuse';
  refusal: string | null;
  code: 'price_too_high' | 'markup_too_high' | null;
  /** Chance of finishing below the lower strike, or at or above the higher one. */
  chanceOutside: number;
  fairPrice: number;
  /** Price per $1 of "outside" payout at the venue's real fee rate. */
  pricePaid: number;
  /** The same at Gemini's production fee rate. The rule is applied to this. */
  allIn: number;
  markup: number;
  markupPct: number;
  /** Cash for one contract of each leg at the venue's fee rate. For a breakout this is the price itself. */
  unitCost: number;
  cashOutPer100: number;
}

export function breakoutEstimate(low: Book, high: Book, venueFeeCoef: number): BreakoutEstimate | null {
  if (low.bid === null || low.ask === null || high.bid === null || high.ask === null) return null;
  const inside = clean((low.bid + low.ask) / 2 - (high.bid + high.ask) / 2);
  const chance = clean(1 - inside);
  const paid = breakoutPrice(low.bid, high.ask, venueFeeCoef);
  const prod = breakoutPrice(low.bid, high.ask, PRODUCTION_FEE_COEF);
  // No chance of landing between the levels makes "outside" a certainty, not a bet; no chance outside leaves nothing to win.
  if (!(inside > 0) || !(chance > 0) || paid === null || prod === null) return null;
  const markup = clean(prod - chance);
  const markupPct = clean(markup / chance);
  let verdict: BreakoutEstimate['verdict'] = 'ok';
  let refusal: string | null = null;
  let code: BreakoutEstimate['code'] = null;
  if (prod >= MAX_ALL_IN_PRICE) {
    verdict = 'refuse';
    code = 'price_too_high';
    refusal = 'Finishing outside these two levels is close to certain, so it costs too much for what it can win. Pick levels further apart.';
  } else if (markup > REFUSE_MARKUP_DOLLARS || markupPct > REFUSE_MARKUP_FRACTION) {
    verdict = 'refuse';
    code = 'markup_too_high';
    refusal = 'The spread on these two prices is too wide to be a fair deal.';
  } else if (markup >= WARN_MARKUP_DOLLARS || markupPct >= WARN_MARKUP_FRACTION) {
    verdict = 'warn';
  }
  // Selling straight back: the NO on the lower strike at its NO bid (1 minus the ask) and the YES on the higher at its bid.
  const contracts = 100 / paid;
  const noBid = 1 - low.ask;
  const cashOut = Math.round(clean(contracts * (noBid - feeRate(noBid, venueFeeCoef)) + contracts * (high.bid - feeRate(high.bid, venueFeeCoef))) * 100) / 100;
  return { verdict, refusal, code, chanceOutside: chance, fairPrice: chance, pricePaid: paid, allIn: prod, markup, markupPct, unitCost: paid, cashOutPer100: cashOut };
}

export interface BreakoutOutcomes {
  /** Contracts of each leg, which is also the dollars paid if it finishes outside. */
  contracts: number;
  cost: number;
  ifOutside: number;
  ifInRange: number;
}

/** What a stake buys of a breakout at a cost per contract: one dollar a contract outside the two levels, nothing between them. */
export function breakoutOutcomesFor(stake: number, unitCost: number): BreakoutOutcomes {
  const contracts = Math.floor((stake / unitCost) * 100) / 100;
  const cost = clean(contracts * unitCost);
  return { contracts, cost, ifOutside: clean(contracts - cost), ifInRange: clean(-cost) };
}

/** A book as a falling bet sees it: the same contract from the NO side. A rising bet's book is its own. */
export function mirrorBook(b: Book): Book {
  return { bid: b.ask === null ? null : clean(1 - b.ask), ask: b.bid === null ? null : clean(1 - b.bid) };
}
