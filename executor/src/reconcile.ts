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
  /** Baseline, minus buys, plus sells, plus settled payouts. */
  expectedCash: number | null;
  actualCash: number;
  cashDifference: number | null;
  ok: boolean;
}

/** Records the starting cash for a user the first time they are seen. */
export async function ensureBaseline(exchange: Exchange, ledger: Ledger, user: string, now: () => Date = () => new Date()): Promise<void> {
  if (ledger.data.baselines[user]) return;
  ledger.data.baselines[user] = { cash: await exchange.cash(), at: now().toISOString() };
  ledger.save();
}

/**
 * Checks the ledger against Gemini two ways:
 *   1. every order we recorded matches Gemini's record of it (quantity and price), and
 *   2. cash ties out: baseline - buys + sells + payouts = the live balance.
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
    if (leg.status === 'error') continue;
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

  const actualCash = await exchange.cash();
  let expectedCash: number | null = null;
  if (baseline) {
    let cash = baseline.cash + untrackedCashFlow;
    for (const leg of legs) {
      if (leg.quantityFilled <= 0 || leg.avgPrice === null) continue;
      cash += (leg.side === 'buy' ? -1 : 1) * leg.quantityFilled * leg.avgPrice;
    }
    for (const bet of ledger.data.bets) {
      if (bet.user === user && bet.settlement) cash += bet.settlement.payout;
    }
    expectedCash = clean(cash);
  }
  const cashDifference = expectedCash === null ? null : clean(actualCash - expectedCash);

  return {
    user,
    mismatches,
    untrackedOrders: untracked.length,
    untrackedCashFlow,
    baselineCash: baseline?.cash ?? null,
    expectedCash,
    actualCash,
    cashDifference,
    ok: mismatches.length === 0 && (cashDifference === null || Math.abs(cashDifference) < 0.005),
  };
}
