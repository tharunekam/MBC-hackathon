import type { Exchange } from './exchange.ts';
import type { Ledger } from './ledger.ts';
import { clean } from './pricing.ts';

export interface ReconcileReport {
  user: string;
  /** Orders whose recorded fill differs from what Gemini reports. */
  mismatches: Array<{ clientOrderId: string; ledger: string; gemini: string }>;
  /** Filled orders placed on the account since the baseline that this service did not send. */
  untrackedOrders: number;
  /** Net cash those untracked orders moved (negative = spent). Included in expectedCash. */
  untrackedCashFlow: number;
  baselineCash: number | null;
  /**
   * Contracts where open bets hold both YES and NO on the same market. Gemini nets these at once and pays $1 for each
   * pair straight away instead of at settlement (seen on the sandbox 2026-11-18: 1 YES from one bet and 3.52 NO from
   * another left a position of 2.52 NO and $1.00 more cash). Typical cause: one bet's target is another bet's condition.
   */
  nettedContracts: number;
  /** Cash Gemini has already paid for those pairs. Included in expectedCash; the bets' own payouts replace it at settlement. */
  nettedCash: number;
  /** Baseline, minus buys, plus sells, minus modelled fees, plus early netting payouts, plus settled payouts. */
  expectedCash: number | null;
  actualCash: number;
  cashDifference: number | null;
  /**
   * Bets Gemini settled without a clean yes/no and nobody has reviewed yet. Their payout is unknown here,
   * so any cash they paid shows up as a difference until someone records it (`recordReviewedPayout`).
   */
  betsNeedingReview: string[];
  /** Bets of that kind whose payout a person has read off the account and recorded. Counted in expectedCash. */
  betsResolvedByHand: string[];
  ok: boolean;
}

/** Records the starting cash for a user the first time they are seen. */
export async function ensureBaseline(exchange: Exchange, ledger: Ledger, user: string, now: () => Date = () => new Date()): Promise<void> {
  if (ledger.data.baselines[user]) return;
  ledger.data.baselines[user] = { cash: await exchange.cash(), at: now().toISOString() };
  ledger.save();
}

/** What one contract pays when it resolves in the holder's favour, and so what Gemini pays for a netted YES + NO pair. */
const SETTLEMENT_VALUE = 1;

/**
 * Per market, how many contracts the user's unsettled bets hold on BOTH sides. Each bet tracks its own legs, but Gemini
 * keeps one position per market per account and nets YES against NO as soon as both exist, paying $1 a pair. A settled
 * bet is left out: its recorded payout already counts every leg in full, which is the same money (the early $1 plus
 * what the remaining position paid).
 */
export function nettedPairs(ledger: Ledger, user: string): Map<string, number> {
  const held = new Map<string, { yes: number; no: number }>();
  for (const bet of ledger.data.bets) {
    // A bet whose payout was recorded by hand is finished too: that payout covers its legs.
    if (bet.user !== user || bet.settlement || bet.review?.resolved) continue;
    for (const leg of bet.legs) {
      if (leg.quantityFilled <= 0) continue;
      const h = held.get(leg.symbol) ?? { yes: 0, no: 0 };
      h[leg.outcome] += (leg.side === 'buy' ? 1 : -1) * leg.quantityFilled;
      held.set(leg.symbol, h);
    }
  }
  const out = new Map<string, number>();
  for (const [symbol, h] of held) {
    const pairs = clean(Math.min(h.yes, h.no));
    if (pairs > 0) out.set(symbol, pairs);
  }
  return out;
}

/**
 * Checks the ledger against Gemini two ways:
 *   1. every order we recorded matches Gemini's record of it (quantity and price), and
 *   2. cash ties out: baseline - buys + sells + early netting payouts + settled payouts = the live balance.
 * Orders placed outside this service since the baseline are counted in the cash
 * check and reported; positions they leave open will show up as a difference
 * when they settle.
 */
export async function reconcile(exchange: Exchange, ledger: Ledger, user: string): Promise<ReconcileReport> {
  const legs = ledger.legs(user);
  const venue = await exchange.allOrders();
  const byTag = new Map(venue.filter((o) => o.clientOrderId).map((o) => [o.clientOrderId, o]));

  const mismatches: ReconcileReport['mismatches'] = [];
  for (const leg of legs) {
    // An order recorded as an error is checked like any other: an answer that was lost does not mean it did not fill, and a
    // fill the ledger never recorded must be named here, not skipped.
    const seen = byTag.get(leg.clientOrderId);
    const ours = `${leg.quantityFilled} @ ${leg.avgPrice ?? '-'}`;
    if (!seen) {
      if (leg.quantityFilled > 0) mismatches.push({ clientOrderId: leg.clientOrderId, ledger: ours, gemini: 'not found' });
      continue;
    }
    const theirs = `${seen.filledQuantity} @ ${seen.avgPrice ?? '-'}`;
    const qtyOff = Math.abs(seen.filledQuantity - leg.quantityFilled) > 1e-9;
    const pxOff = Math.abs((seen.avgPrice ?? 0) - (leg.avgPrice ?? 0)) > 1e-9;
    if (qtyOff || pxOff) mismatches.push({ clientOrderId: leg.clientOrderId, ledger: ours, gemini: theirs });
  }

  const baseline = ledger.data.baselines[user] ?? null;
  const ourTags = new Set(legs.map((l) => l.clientOrderId));
  const untracked = venue.filter(
    (o) =>
      o.filledQuantity > 0 &&
      o.avgPrice !== null &&
      !ourTags.has(o.clientOrderId) &&
      (!baseline || (o.createdAt !== null && o.createdAt > baseline.at)),
  );
  const untrackedCashFlow = clean(
    untracked.reduce((sum, o) => sum + (o.side === 'buy' ? -1 : 1) * o.filledQuantity * (o.avgPrice ?? 0), 0),
  );

  const netted = nettedPairs(ledger, user);
  const nettedContracts = clean([...netted.values()].reduce((sum, q) => sum + q, 0));
  const nettedCash = clean(nettedContracts * SETTLEMENT_VALUE);

  const actualCash = await exchange.cash();
  let expectedCash: number | null = null;
  if (baseline) {
    let cash = baseline.cash + untrackedCashFlow + nettedCash;
    for (const leg of legs) {
      if (leg.quantityFilled <= 0 || leg.avgPrice === null) continue;
      cash += (leg.side === 'buy' ? -1 : 1) * leg.quantityFilled * leg.avgPrice - (leg.fee ?? 0);
    }
    for (const bet of ledger.data.bets) {
      if (bet.user !== user) continue;
      if (bet.settlement) cash += bet.settlement.payout;
      else if (bet.review?.resolved) cash += bet.review.resolved.payout;
    }
    expectedCash = clean(cash);
  }
  const cashDifference = expectedCash === null ? null : clean(actualCash - expectedCash);

  return {
    user,
    mismatches,
    untrackedOrders: untracked.length,
    untrackedCashFlow,
    nettedContracts,
    nettedCash,
    baselineCash: baseline?.cash ?? null,
    expectedCash,
    actualCash,
    cashDifference,
    betsNeedingReview: ledger.data.bets.filter((b) => b.user === user && b.status === 'needs_review' && !b.review?.resolved).map((b) => b.id),
    betsResolvedByHand: ledger.data.bets.filter((b) => b.user === user && b.status === 'needs_review' && b.review?.resolved).map((b) => b.id),
    ok: mismatches.length === 0 && (cashDifference === null || Math.abs(cashDifference) < 0.005),
  };
}
