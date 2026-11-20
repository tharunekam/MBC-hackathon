/**
 * A range bet: win if a price finishes between two levels.
 *
 * It is two plain orders on one ladder, the same number of contracts of each: YES on the lower strike and NO on the higher.
 * See `rangeUnitCost` in pricing.ts for why that is a bet on the range and what it costs. This file prices it, applies the
 * offer rule to it and sizes it. Placing it is in range-bet.ts.
 */
import {
  MAX_ALL_IN_PRICE,
  PRODUCTION_TAKER_FEE_COEF,
  REFUSE_MARKUP_DOLLARS,
  REFUSE_MARKUP_FRACTION,
  WARN_MARKUP_DOLLARS,
  WARN_MARKUP_FRACTION,
  cents,
  ladderInversions,
  pct,
} from './offer.ts';
import type { OfferOptions, OfferReason } from './offer.ts';
import { ladder } from './pairs.ts';
import type { Rung } from './pairs.ts';
import { QTY_STEP, clean, feeRate, floorToStep, rangePrice, rangeUnitCost, takerFee } from './pricing.ts';
import type { GeminiEvent } from './gemini/types.ts';

const EPS = 1e-9;

/** The offer rule's verdict and numbers for a range bet. The same verdict words as a pair's quote. */
export interface RangeQuote {
  verdict: 'ok' | 'warn' | 'refuse';
  reasons: OfferReason[];
  warnings: string[];
  offerable: boolean;
  overridden: boolean;
  /** Chance the price finishes at or above the lower strike and below the higher one: the middle of one book less the other. */
  chanceInRange: number | null;
  /** What a $1 "inside the range" payout is worth with no spread and no fees. The same number as the chance. */
  fairPrice: number | null;
  /** Price per $1 of "inside the range" payout actually charged on this venue (its fee rate; the sandbox charges none). */
  pricePaid: number | null;
  /** The same at Gemini's production fee rate. The rule is applied to this number. */
  allInPrice: number | null;
  /** allInPrice - fairPrice. */
  markup: number | null;
  markupPct: number | null;
  /** What selling both legs straight back would return per $100 spent, at this venue's fee rate. */
  cashOutPer100: number | null;
  cashOutPer100AtProductionFees: number | null;
  feeCoefCharged: number;
}

/**
 * Dollars returned by selling both legs of a range bet straight back, per $100 spent: the YES on the lower strike at its
 * bid, the NO on the higher strike at its NO bid (1 minus its ask), each less the taker fee on the sale.
 */
export function rangeCashOutPer100(unitCost: number, bidLow: number, askHigh: number, coef: number): number {
  const contracts = 100 / unitCost;
  const noBid = 1 - askHigh;
  return Math.round(clean(contracts * (bidLow - feeRate(bidLow, coef)) + contracts * (noBid - feeRate(noBid, coef))) * 100) / 100;
}

/**
 * Applies the offer rule to one range (lower strike `low`, higher strike `high`). It is the pair rule with the range's own
 * price: what the second dollar costs, compared with the chance of landing inside.
 * `rungs` is the whole ladder of the event, used for the out-of-order check.
 */
export function assessRange(rungs: Rung[], low: Rung, high: Rung, opts: OfferOptions = {}): RangeQuote {
  const feeCoef = opts.feeCoef ?? 0;
  const reasons: OfferReason[] = [];
  const warnings: string[] = [];
  const quote: RangeQuote = {
    verdict: 'ok',
    reasons,
    warnings,
    offerable: false,
    overridden: false,
    chanceInRange: null,
    fairPrice: null,
    pricePaid: null,
    allInPrice: null,
    markup: null,
    markupPct: null,
    cashOutPer100: null,
    cashOutPer100AtProductionFees: null,
    feeCoefCharged: feeCoef,
  };

  if (!low.open || !high.open) {
    const closed = [low, high].filter((r) => !r.open).map((r) => `"${r.label}" (${r.state})`);
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

  const oneSided = [low, high].filter((r) => r.bid === null || r.ask === null);
  if (oneSided.length > 0) {
    reasons.push({
      code: 'one_sided_book',
      message: `No two-sided market on ${oneSided.map((r) => `"${r.label}"`).join(' and ')}: a buyer or a seller is missing.`,
    });
  }

  if (low.bid !== null && low.ask !== null && high.bid !== null && high.ask !== null) {
    const chance = clean((low.bid + low.ask) / 2 - (high.bid + high.ask) / 2);
    const paid = rangePrice(low.ask, high.bid, feeCoef);
    const allIn = rangePrice(low.ask, high.bid, PRODUCTION_TAKER_FEE_COEF);
    quote.pricePaid = paid;
    quote.allInPrice = allIn;

    if (!(chance > 0)) {
      reasons.push({ code: 'no_price', message: 'The two prices leave no chance of finishing in between.' });
    } else if (allIn === null || paid === null) {
      quote.chanceInRange = chance;
      quote.fairPrice = chance;
      reasons.push({ code: 'no_price', message: 'No sensible price exists: the range costs a dollar or more for the dollar it can win.' });
    } else {
      quote.chanceInRange = chance;
      quote.fairPrice = chance;
      quote.cashOutPer100 = rangeCashOutPer100(rangeUnitCost(low.ask, high.bid, feeCoef), low.bid, high.ask, feeCoef);
      quote.cashOutPer100AtProductionFees = rangeCashOutPer100(rangeUnitCost(low.ask, high.bid, PRODUCTION_TAKER_FEE_COEF), low.bid, high.ask, PRODUCTION_TAKER_FEE_COEF);
      if (allIn >= MAX_ALL_IN_PRICE - EPS) {
        reasons.push({ code: 'price_too_high', message: `Costs $${allIn.toFixed(3)} per $1 of payout with fees, at or above the $${MAX_ALL_IN_PRICE.toFixed(2)} limit.` });
      }
      const markup = clean(allIn - chance);
      const markupPct = clean(markup / chance);
      quote.markup = markup;
      quote.markupPct = markupPct;
      if (markup > REFUSE_MARKUP_DOLLARS + EPS || markupPct > REFUSE_MARKUP_FRACTION + EPS) {
        reasons.push({
          code: 'markup_too_high',
          message: `Costs ${cents(markup)} (${pct(markupPct)}) more than the fair price with fees; the limit is ${cents(REFUSE_MARKUP_DOLLARS)} or ${pct(REFUSE_MARKUP_FRACTION)}.`,
        });
      } else if (markup >= WARN_MARKUP_DOLLARS - EPS || markupPct >= WARN_MARKUP_FRACTION - EPS) {
        warnings.push(`Costs ${cents(markup)} (${pct(markupPct)}) more than the fair price with fees.`);
      }
    }
  }

  if (reasons.length > 0) {
    quote.verdict = 'refuse';
    quote.warnings = [];
    quote.overridden = opts.waiveMarkup === true && reasons.every((r) => r.code === 'markup_too_high');
    quote.offerable = quote.overridden;
  } else {
    quote.verdict = warnings.length > 0 ? 'warn' : 'ok';
    quote.offerable = true;
  }
  return quote;
}

export interface RangePlan {
  /** Contracts of each leg. */
  contracts: number;
  /** Dollars spent in all, fees included, if both legs fill at the quoted prices. */
  cost: number;
  /** Dollars that come back whatever happens: one per contract. */
  backAlways: number;
  /** Net result if the price finishes inside the range. */
  ifInRange: number;
  /** Net result if it finishes outside. */
  ifOutside: number;
  /** Taker fees on both orders at Gemini's production rate. */
  feesAtProductionRates: number;
}

/** What `contracts` of each leg cost and pay at the quoted prices. */
export function planRange(contracts: number, askLow: number, bidHigh: number, coef: number): RangePlan {
  const noHigh = clean(1 - bidHigh);
  const cost = clean(contracts * askLow + takerFee(contracts, askLow, coef) + contracts * noHigh + takerFee(contracts, noHigh, coef));
  return {
    contracts,
    cost,
    backAlways: contracts,
    ifInRange: clean(2 * contracts - cost),
    ifOutside: clean(contracts - cost),
    feesAtProductionRates: clean(takerFee(contracts, askLow, PRODUCTION_TAKER_FEE_COEF) + takerFee(contracts, noHigh, PRODUCTION_TAKER_FEE_COEF)),
  };
}

/** How many contracts of each leg a stake buys, never spending more than the stake. */
export function rangeContractsFor(stake: number, askLow: number, bidHigh: number, coef: number): number {
  let q = floorToStep(stake / rangeUnitCost(askLow, bidHigh, coef));
  while (q > 0 && planRange(q, askLow, bidHigh, coef).cost > stake + EPS) q = clean(q - QTY_STEP);
  return q;
}

/**
 * The depth guard for a range. The YES leg buys against the offers on the lower strike and the NO leg against the YES bids
 * on the higher one, and both legs are the same size, so whichever is thinner limits the bet.
 */
export function capRangeToDepth(wanted: number, askSizeLow: number, bidSizeHigh: number): number {
  return floorToStep(Math.max(0, Math.min(wanted, askSizeLow, bidSizeHigh)));
}

/** A lower and a higher strike of one ladder, with the offer rule's verdict on betting on the range between them. */
export interface RangePair {
  eventTicker: string;
  eventTitle: string;
  expiry: string | null;
  low: Rung;
  high: Rung;
  /** Price per $1 of "inside the range" payout, or null if the books cannot support one. */
  price: number | null;
  offer: RangeQuote;
}

export function findRange(event: GeminiEvent, lowSymbol: string, highSymbol: string, feeCoef = 0, waiveMarkup = false): RangePair {
  const rungs = ladder(event);
  const low = rungs.find((r) => r.symbol === lowSymbol);
  const high = rungs.find((r) => r.symbol === highSymbol);
  if (!low || !high || !(high.strike > low.strike)) {
    throw new Error(
      `${lowSymbol} and ${highSymbol} are not a range in ${event.ticker}: both must be "or above" strikes of this event, ` +
        'with the first strike lower than the second.',
    );
  }
  return {
    eventTicker: event.ticker,
    eventTitle: event.title,
    expiry: event.expiryDate ?? null,
    low,
    high,
    price: low.open && high.open ? rangePrice(low.ask, high.bid, feeCoef) : null,
    offer: assessRange(rungs, low, high, { feeCoef, waiveMarkup }),
  };
}
