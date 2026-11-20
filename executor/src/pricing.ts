/**
 * Maths for a conditional bet built from two linked contracts in one event.
 *
 * A is the condition ("ETH closes at or above $1,800") and B is the outcome
 * that can only happen if A does ("...at or above $1,820"). The bet is:
 *
 *     buy qB YES on B   +   buy qA NO on A
 *
 * If A fails, B fails too, and the NO-on-A leg pays qA, returning the stake.
 * If A holds and B hits, the YES-on-B leg pays qB.
 * If A holds and B misses, both legs expire worthless.
 *
 * All prices are dollars per contract (0..1); every contract pays $1.
 */

export const PRICE_TICK = 0.01;
export const QTY_STEP = 0.01;

/** Rounds away binary floating-point noise (0.1 + 0.2 style) without changing real values. */
export const clean = (x: number): number => Math.round(x * 1e8) / 1e8;

export const floorToStep = (x: number, step = QTY_STEP): number => clean(Math.floor(clean(x / step)) * step);
export const ceilToStep = (x: number, step = QTY_STEP): number => clean(Math.ceil(clean(x / step)) * step);
export const fmt2 = (x: number): string => clean(x).toFixed(2);

/**
 * Gemini's published taker fee: coef x contracts x price x (1 - price), rounded
 * up to the cent (coef is 0.07 in production; the sandbox charged nothing).
 */
export function takerFee(quantity: number, price: number, coef: number): number {
  if (!(coef > 0) || !(quantity > 0)) return 0;
  return ceilToStep(coef * quantity * price * (1 - price), 0.01);
}

/** Fee per contract before rounding. */
export const feeRate = (price: number, coef: number): number => (coef > 0 ? coef * price * (1 - price) : 0);

/**
 * All-in price of $1 paid "if B, given A" when buying B at `askB` and hedging
 * with NO on A, where `bidA` is the best YES bid on A (so NO on A costs
 * 1 - bidA). With a fee coefficient, both legs' taker fees are included:
 *
 *     (askB + fee(askB)) / (bidA - fee(1 - bidA))
 *
 * Returns null when no sensible bet exists (missing book, B not cheaper than
 * A, or the all-in price reaches $1).
 */
export function conditionalPrice(askB: number | null, bidA: number | null, coef = 0): number | null {
  if (askB === null || bidA === null) return null;
  if (!(askB > 0) || !(bidA > 0) || bidA >= 1 || askB >= bidA) return null;
  const refundPerHedge = bidA - feeRate(1 - bidA, coef); // what one NO contract returns net of its cost and fee
  if (refundPerHedge <= 0) return null;
  const price = clean((askB + feeRate(askB, coef)) / refundPerHedge);
  return price < 1 ? price : null;
}

/**
 * NO-on-A quantity needed so that, if A fails, the payout covers everything
 * spent, fees included: qA >= costB + qA * noPriceA + fee(qA). Rounded UP to
 * the quantity step so the refund is never short. `costB` and `alreadySpent`
 * must include fees already paid. `alreadyHeld` and `alreadySpent` support
 * topping up after a partial fill.
 */
export function hedgeQuantity(costB: number, noPriceA: number, alreadyHeld = 0, alreadySpent = 0, coef = 0): number {
  if (!(noPriceA > 0) || noPriceA >= 1) throw new Error(`NO price on the condition must be between 0 and 1, got ${noPriceA}`);
  if (costB < 0) throw new Error('costB cannot be negative');
  const shortfall = costB + alreadySpent - alreadyHeld;
  if (shortfall <= 0) return 0;
  const refundPerHedge = 1 - noPriceA - feeRate(noPriceA, coef);
  if (refundPerHedge <= 0) throw new Error(`Fees leave nothing to refund at a NO price of ${noPriceA}`);
  // The hedge order's own fee is rounded up to the cent, so allow one cent for that.
  const rounding = coef > 0 ? 0.01 : 0;
  return ceilToStep((shortfall + rounding) / refundPerHedge);
}

export interface LegFill {
  quantity: number;
  avgPrice: number;
}

export interface Payoffs {
  /** Total dollars spent on both legs. */
  stake: number;
  /** Net result if the condition A fails (should be ~0: stake returned). */
  ifConditionFails: number;
  /** Net result if A holds and B hits. */
  ifBothHit: number;
  /** Net result if A holds but B misses. */
  ifConditionOnly: number;
  /** Dollars staked per $1 of payout when both hit; null if nothing was bought on B. */
  conditionalPrice: number | null;
  /** True when the refund on a failed condition covers the stake (to within a cent). */
  hedged: boolean;
}

export function payoffs(b: LegFill, a: LegFill): Payoffs {
  const stake = clean(b.quantity * b.avgPrice + a.quantity * a.avgPrice);
  const ifConditionFails = clean(a.quantity - stake);
  return {
    stake,
    ifConditionFails,
    ifBothHit: clean(b.quantity - stake),
    ifConditionOnly: clean(-stake),
    conditionalPrice: b.quantity > 0 ? clean(stake / b.quantity) : null,
    hedged: b.quantity > 0 && ifConditionFails >= -0.005,
  };
}

/** Dollar payout of a settled bet given how A and B resolved. */
export function settlementPayout(b: LegFill, a: LegFill, aResolved: 'yes' | 'no', bResolved: 'yes' | 'no'): number {
  return clean((bResolved === 'yes' ? b.quantity : 0) + (aResolved === 'no' ? a.quantity : 0));
}

// ------------------------------------------------------------------ range bets

/**
 * A range bet buys YES on a lower strike L and NO on a higher strike H, the same number of contracts of each.
 *
 *     price at or above H      the YES on L pays $1
 *     price between L and H    both pay: $2
 *     price below L            the NO on H pays $1
 *
 * One of the two always pays a dollar, so what is really bought is the second dollar for landing inside the range. Its
 * price per $1 is what the pair costs above that guaranteed dollar:  askL + (1 - bidH) - 1  =  askL - bidH, plus fees.
 */

/** Cash for one contract of each leg: YES on L at its ask, NO on H at 1 - H's bid, each with its taker fee. */
export function rangeUnitCost(askL: number, bidH: number, coef = 0): number {
  const noH = clean(1 - bidH);
  return clean(askL + feeRate(askL, coef) + noH + feeRate(noH, coef));
}

/** What the range pays for each $1 of "inside the range" payout, after the dollar that always comes back. Null if it is not a price. */
export function rangePrice(askL: number | null, bidH: number | null, coef = 0): number | null {
  if (askL === null || bidH === null || !(askL > 0) || !(bidH >= 0) || askL >= 1) return null;
  const price = clean(rangeUnitCost(askL, bidH, coef) - 1);
  return price > 0 && price < 1 ? price : null;
}


// ------------------------------------------------------------------ breakout bets

/**
 * A breakout is the range's opposite: YES on the higher strike H and NO on the lower strike L, the same number of contracts
 * of each.
 *
 *     price at or above H      the YES on H pays $1
 *     price between L and H    neither pays
 *     price below L            the NO on L pays $1
 *
 * Exactly one of the two can pay, so the pair costs less than a dollar and that cost IS the price of $1 for finishing outside
 * the two levels, whichever way:  (1 - bidL) + askH, plus fees. A range is a bet that the price stays put; this is a bet that
 * it moves, and it needs no view on which way.
 */

/** Cash for one contract of each leg: NO on L at 1 - L's bid, YES on H at its ask, each with its taker fee. */
export function breakoutUnitCost(bidL: number, askH: number, coef = 0): number {
  const noL = clean(1 - bidL);
  return clean(noL + feeRate(noL, coef) + askH + feeRate(askH, coef));
}

/** What a breakout costs for each $1 of "outside the two levels" payout. Null if it is not a price. */
export function breakoutPrice(bidL: number | null, askH: number | null, coef = 0): number | null {
  if (bidL === null || askH === null || !(askH > 0) || !(bidL > 0) || bidL >= 1) return null;
  const price = breakoutUnitCost(bidL, askH, coef);
  return price > 0 && price < 1 ? price : null;
}
