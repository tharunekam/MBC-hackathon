/**
 * The offer rule: decides whether a conditional bet is good enough value to
 * show to a user, and produces the numbers every quote must carry.
 *
 * "Fair" is what the bet would cost with no spread and no fees: the chance
 * both things happen divided by the chance the condition happens, each read
 * from the middle of its book. The rule compares that with the all-in price
 * at Gemini's PRODUCTION fee rate, even on the sandbox (which charges none),
 * so a pair is never shown as better value than it would be for real money.
 */
import type { Rung } from './pairs.ts';
import { ceilToStep, clean, feeRate, floorToStep, hedgeQuantity, takerFee } from './pricing.ts';

/** Gemini's published production taker fee coefficient. */
export const PRODUCTION_TAKER_FEE_COEF = 0.07;

/** Refuse when $1 of payout costs this much or more, all-in. */
export const MAX_ALL_IN_PRICE = 0.95;
/**
 * Refuse when the all-in price is more than this many dollars above fair...
 * (Loosened from 0.05 / 0.15 after the production census showed too few pairs
 * passing; the old limits survive as the "warn" thresholds below.)
 */
export const REFUSE_MARKUP_DOLLARS = 0.08;
/** ...or more than this fraction above fair. */
export const REFUSE_MARKUP_FRACTION = 0.2;
/** Warn (amber) from this many dollars above fair... */
export const WARN_MARKUP_DOLLARS = 0.05;
/** ...or from this fraction above fair. */
export const WARN_MARKUP_FRACTION = 0.15;

const EPS = 1e-9;

export type RefusalCode =
  | 'market_closed'
  | 'one_sided_book'
  | 'ladder_out_of_order'
  | 'no_price'
  | 'price_too_high'
  | 'markup_too_high';

export interface OfferReason {
  code: RefusalCode;
  message: string;
}

export interface OfferQuote {
  /** The rule's own verdict, never softened by any override. */
  verdict: 'ok' | 'warn' | 'refuse';
  /** Why the pair is refused (empty unless verdict is "refuse"). */
  reasons: OfferReason[];
  /** Why the pair carries a warning (empty unless verdict is "warn"). */
  warnings: string[];
  /** True when a bet may be placed: verdict ok/warn, or refused only for markup with the sandbox waiver on. */
  offerable: boolean;
  /** True when the pair is offerable only because the sandbox markup waiver is on. */
  overridden: boolean;

  /** Chance the condition happens: the middle of A's book. */
  chanceCondition: number | null;
  /** Chance both happen: the middle of B's book (B can only happen if A does). */
  chanceBothHappen: number | null;
  /** chanceBothHappen / chanceCondition: the price of $1 with no spread and no fees. */
  fairPrice: number | null;
  /** Price per $1 actually charged on this venue (its real fee rate; the sandbox charges none). */
  pricePaid: number | null;
  /** Price per $1 at Gemini's production fee rate. The rule is applied to this number. */
  allInPrice: number | null;
  /** allInPrice - fairPrice, in dollars per $1 of payout. */
  markup: number | null;
  /** markup / fairPrice. */
  markupPct: number | null;
  /** What selling both legs straight back would return per $100 staked, at this venue's fee rate. */
  cashOutPer100: number | null;
  /** The same at Gemini's production fee rate. */
  cashOutPer100AtProductionFees: number | null;
  /** Fee coefficient this venue actually charges (0 on the sandbox). */
  feeCoefCharged: number;
}

export interface OfferOptions {
  /** Fee coefficient the venue actually charges. */
  feeCoef?: number;
  /**
   * Sandbox demo switch: lets a pair refused ONLY for markup be traded anyway.
   * Never waives a closed market, a one-sided book, an out-of-order ladder or
   * a price at or above the cap.
   */
  waiveMarkup?: boolean;
}

/** Price of $1 "if B, given A" at a fee coefficient; unlike pricing.conditionalPrice it may return 1 or more. */
function rawPrice(askB: number, bidA: number, coef: number): number | null {
  if (!(askB > 0) || !(bidA > 0) || bidA >= 1 || askB >= bidA) return null;
  const refundPerHedge = bidA - feeRate(1 - bidA, coef);
  if (refundPerHedge <= 0) return null;
  return clean((askB + feeRate(askB, coef)) / refundPerHedge);
}

/**
 * Dollars returned by selling both legs of a $100 bet straight back at the
 * bids: the YES-on-B contracts at B's bid, the NO-on-A contracts at A's NO bid
 * (1 - A's ask), each less the taker fee on the sale.
 */
export function cashOutPer100(price: number, bidB: number, askA: number, coef: number): number {
  const outcomeContracts = 100 / price; // $100 buys this many YES-on-B
  const hedgeContracts = 100; // and exactly enough NO-on-A to return $100 if A fails
  const noBid = 1 - askA;
  const value = outcomeContracts * (bidB - feeRate(bidB, coef)) + hedgeContracts * (noBid - feeRate(noBid, coef));
  return Math.round(clean(value) * 100) / 100;
}

export interface Inversion {
  lower: Rung;
  higher: Rung;
  side: 'bid' | 'ask';
}

/**
 * Places where a higher strike is priced above a lower one. "X or above" must
 * get cheaper as X rises, so any inversion means a stale or broken book.
 * Equal prices are fine. Missing sides are skipped.
 */
export function ladderInversions(rungs: Rung[]): Inversion[] {
  const sorted = [...rungs].sort((x, y) => x.strike - y.strike);
  const out: Inversion[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const lower = sorted[i]!;
      const higher = sorted[j]!;
      if (higher.strike <= lower.strike) continue;
      if (lower.bid !== null && higher.bid !== null && higher.bid > lower.bid + EPS) out.push({ lower, higher, side: 'bid' });
      if (lower.ask !== null && higher.ask !== null && higher.ask > lower.ask + EPS) out.push({ lower, higher, side: 'ask' });
    }
  }
  return out;
}

const cents = (x: number) => `${(x * 100).toFixed(1)} cents`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * Applies the offer rule to one (condition A, outcome B) pair.
 * `rungs` is the whole ladder of the event, used for the out-of-order check.
 */
export function assessPair(rungs: Rung[], a: Rung, b: Rung, opts: OfferOptions = {}): OfferQuote {
  const feeCoef = opts.feeCoef ?? 0;
  const reasons: OfferReason[] = [];
  const warnings: string[] = [];
  const quote: OfferQuote = {
    verdict: 'ok',
    reasons,
    warnings,
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
    feeCoefCharged: feeCoef,
  };

  if (!a.open || !b.open) {
    const closed = [a, b].filter((r) => !r.open).map((r) => `"${r.label}" (${r.state})`);
    reasons.push({ code: 'market_closed', message: `Not open for trading right now: ${closed.join(' and ')}.` });
  }

  const inversions = ladderInversions(rungs);
  if (inversions.length > 0) {
    const first = inversions[0]!;
    reasons.push({
      code: 'ladder_out_of_order',
      message:
        `This market's prices are out of order: "${first.higher.label}" has a higher ${first.side} ` +
        `(${first.higher[first.side]}) than "${first.lower.label}" (${first.lower[first.side]}), which cannot be right.`,
    });
  }

  const oneSided = [a, b].filter((r) => r.bid === null || r.ask === null);
  if (oneSided.length > 0) {
    reasons.push({
      code: 'one_sided_book',
      message: `No two-sided market on ${oneSided.map((r) => `"${r.label}"`).join(' and ')}: a buyer or a seller is missing.`,
    });
  }

  if (a.bid !== null && a.ask !== null && b.bid !== null && b.ask !== null) {
    const midA = clean((a.bid + a.ask) / 2);
    const midB = clean((b.bid + b.ask) / 2);
    quote.chanceCondition = midA;
    quote.chanceBothHappen = midB;
    quote.fairPrice = midA > 0 ? clean(midB / midA) : null;

    const paid = rawPrice(b.ask, a.bid, feeCoef);
    const allIn = rawPrice(b.ask, a.bid, PRODUCTION_TAKER_FEE_COEF);
    quote.pricePaid = paid;
    quote.allInPrice = allIn;

    if (allIn === null || paid === null) {
      reasons.push({
        code: 'no_price',
        message: 'No sensible price exists: the outcome costs as much as the condition.',
      });
    } else {
      quote.cashOutPer100 = cashOutPer100(paid, b.bid, a.ask, feeCoef);
      quote.cashOutPer100AtProductionFees = cashOutPer100(allIn, b.bid, a.ask, PRODUCTION_TAKER_FEE_COEF);
      if (allIn >= MAX_ALL_IN_PRICE - EPS) {
        reasons.push({
          code: 'price_too_high',
          message: `Costs $${allIn.toFixed(3)} per $1 of payout with fees, at or above the $${MAX_ALL_IN_PRICE.toFixed(2)} limit.`,
        });
      }
      if (quote.fairPrice !== null && quote.fairPrice > 0) {
        const markup = clean(allIn - quote.fairPrice);
        const markupPct = clean(markup / quote.fairPrice);
        quote.markup = markup;
        quote.markupPct = markupPct;
        const overDollars = markup > REFUSE_MARKUP_DOLLARS + EPS;
        const overPct = markupPct > REFUSE_MARKUP_FRACTION + EPS;
        if (overDollars || overPct) {
          reasons.push({
            code: 'markup_too_high',
            message:
              `Costs ${cents(markup)} (${pct(markupPct)}) more than the fair price with fees; ` +
              `the limit is ${cents(REFUSE_MARKUP_DOLLARS)} or ${pct(REFUSE_MARKUP_FRACTION)}.`,
          });
        } else if (markup >= WARN_MARKUP_DOLLARS - EPS || markupPct >= WARN_MARKUP_FRACTION - EPS) {
          warnings.push(`Costs ${cents(markup)} (${pct(markupPct)}) more than the fair price with fees.`);
        }
      }
    }
  }

  if (reasons.length > 0) {
    quote.verdict = 'refuse';
    quote.warnings = [];
    const onlyMarkup = reasons.every((r) => r.code === 'markup_too_high');
    quote.overridden = opts.waiveMarkup === true && onlyMarkup;
    quote.offerable = quote.overridden;
  } else {
    quote.verdict = warnings.length > 0 ? 'warn' : 'ok';
    quote.offerable = true;
  }
  return quote;
}

export interface BetPlan {
  /** YES contracts to buy on the outcome. */
  outcomeContracts: number;
  /** NO contracts to buy on the condition. */
  hedgeContracts: number;
  /** Dollars spent in total, fees included, if both legs fill at the quoted prices. */
  cost: number;
  ifBothHit: number;
  ifConditionFails: number;
  ifConditionOnly: number;
  /** Taker fees on both orders at Gemini's production rate. */
  feesAtProductionRates: number;
}

/** What a bet of `outcomeContracts` costs and pays at the quoted prices. */
export function planForQuantity(outcomeContracts: number, askB: number, bidA: number, coef: number): BetPlan {
  const noPrice = clean(1 - bidA);
  const costB = clean(outcomeContracts * askB + takerFee(outcomeContracts, askB, coef));
  const hedgeContracts = outcomeContracts > 0 ? hedgeQuantity(costB, noPrice, 0, 0, coef) : 0;
  const cost = clean(costB + hedgeContracts * noPrice + takerFee(hedgeContracts, noPrice, coef));
  return {
    outcomeContracts,
    hedgeContracts,
    cost,
    ifBothHit: clean(outcomeContracts - cost),
    ifConditionFails: clean(hedgeContracts - cost),
    ifConditionOnly: clean(-cost),
    feesAtProductionRates: clean(
      takerFee(outcomeContracts, askB, PRODUCTION_TAKER_FEE_COEF) + takerFee(hedgeContracts, noPrice, PRODUCTION_TAKER_FEE_COEF),
    ),
  };
}

/**
 * The depth guard. Shrinks the outcome quantity until BOTH legs fit in what is
 * resting at the best price: `askSizeB` YES contracts offered on the outcome
 * and `bidSizeA` YES bids on the condition (which is what a NO buy trades
 * against). Returns 0 when not even the smallest bet fits.
 */
export function capToDepth(wanted: number, askB: number, bidA: number, coef: number, askSizeB: number, bidSizeA: number): number {
  let quantity = floorToStep(Math.max(0, Math.min(wanted, askSizeB)));
  if (quantity <= 0 || bidSizeA <= 0) return 0;
  const price = rawPrice(askB, bidA, coef);
  if (price === null) return 0;
  // First guess from the price, then step down until the rounded-up hedge really fits.
  quantity = Math.min(quantity, floorToStep(bidSizeA / price));
  while (quantity > 0 && planForQuantity(quantity, askB, bidA, coef).hedgeContracts > bidSizeA + EPS) {
    quantity = clean(quantity - 0.01);
  }
  return quantity > 0 ? floorToStep(quantity) : 0;
}

/** Rounds a dollar amount up to the cent. */
export const toCentsUp = (x: number): number => ceilToStep(x, 0.01);
