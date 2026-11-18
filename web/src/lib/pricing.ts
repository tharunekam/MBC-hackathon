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
