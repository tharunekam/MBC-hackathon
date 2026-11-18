/**
 * "Flow to Gemini": what Given's bets have sent to Gemini's order book, added
 * up from Given's own ledger. Fees are shown at Gemini's published production
 * rate even on the sandbox, which charges nothing, so the number is what the
 * same orders would have paid for real.
 */
import type { BetRecord, LegRecord, Ledger } from './ledger.ts';
import { PRODUCTION_TAKER_FEE_COEF } from './offer.ts';
import { clean, takerFee } from './pricing.ts';

export interface FlowTotals {
  /** Bets with at least one filled order. */
  bets: number;
  /** Orders sent to Gemini, filled or not. */
  ordersSent: number;
  /** Orders that traded at least partly. */
  ordersFilled: number;
  /** Contracts traded, both legs, buys and sells. */
  contracts: number;
  /** Dollars of contracts traded (contracts x price), before fees. */
  premium: number;
  /** Taker fees those fills would pay at Gemini's production rate, rounded up to the cent per order. */
  feesAtProductionRates: number;
  /** Fees this venue actually charged (0 on the sandbox). */
  feesCharged: number;
}

const zero = (): FlowTotals => ({
  bets: 0,
  ordersSent: 0,
  ordersFilled: 0,
  contracts: 0,
  premium: 0,
  feesAtProductionRates: 0,
  feesCharged: 0,
});

function addLeg(t: FlowTotals, leg: LegRecord): void {
  t.ordersSent++;
  if (leg.quantityFilled <= 0 || leg.avgPrice === null) return;
  t.ordersFilled++;
  t.contracts = clean(t.contracts + leg.quantityFilled);
  t.premium = clean(t.premium + leg.quantityFilled * leg.avgPrice);
  t.feesAtProductionRates = clean(t.feesAtProductionRates + takerFee(leg.quantityFilled, leg.avgPrice, PRODUCTION_TAKER_FEE_COEF));
  t.feesCharged = clean(t.feesCharged + (leg.fee ?? 0));
}

/** Flow from one bet. */
export function betFlow(bet: BetRecord): FlowTotals {
  const t = zero();
  for (const leg of bet.legs) addLeg(t, leg);
  t.bets = t.ordersFilled > 0 ? 1 : 0;
  return t;
}

/** Flow from every bet in the ledger, or one user's. */
export function flowTotals(ledger: Ledger, user?: string): FlowTotals {
  const t = zero();
  for (const bet of ledger.data.bets) {
    if (user !== undefined && bet.user !== user) continue;
    const one = betFlow(bet);
    t.bets += one.bets;
    t.ordersSent += one.ordersSent;
    t.ordersFilled += one.ordersFilled;
    t.contracts = clean(t.contracts + one.contracts);
    t.premium = clean(t.premium + one.premium);
    t.feesAtProductionRates = clean(t.feesAtProductionRates + one.feesAtProductionRates);
    t.feesCharged = clean(t.feesCharged + one.feesCharged);
  }
  return t;
}
