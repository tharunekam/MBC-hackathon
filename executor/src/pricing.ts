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
 * Price of $1 paid "if B, given A" when buying B at `askB` and hedging with
 * NO on A, where `bidA` is the best YES bid on A (so NO on A costs 1 - bidA).
 * Returns null when no sensible bet exists (missing book, or B is not cheaper than A).
 */
export function conditionalPrice(askB: number | null, bidA: number | null): number | null {
  if (askB === null || bidA === null) return null;
  if (!(askB > 0) || !(bidA > 0) || bidA >= 1 || askB >= bidA) return null;
  return clean(askB / bidA);
}

/**
 * NO-on-A quantity needed so that, if A fails, the payout covers everything
 * spent: qA >= costB + qA * noPriceA. Rounded UP to the quantity step so the
 * refund is never short. `alreadyHeld` and `alreadySpent` support topping up
 * after a partial fill.
 */
export function hedgeQuantity(costB: number, noPriceA: number, alreadyHeld = 0, alreadySpent = 0): number {
  if (!(noPriceA > 0) || noPriceA >= 1) throw new Error(`NO price on the condition must be between 0 and 1, got ${noPriceA}`);
  if (costB < 0) throw new Error('costB cannot be negative');
  const shortfall = costB + alreadySpent - alreadyHeld;
  if (shortfall <= 0) return 0;
  return ceilToStep(shortfall / (1 - noPriceA));
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
