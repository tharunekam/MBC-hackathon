import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OfferQuote } from './offer.ts';

/** One order sent to Gemini, identified by the tag we attach (`clientOrderId`). */
export interface LegRecord {
  clientOrderId: string;
  role: 'outcome' | 'hedge' | 'unwind' | 'trigger';
  symbol: string;
  side: 'buy' | 'sell';
  outcome: 'yes' | 'no';
  limitPrice: number;
  quantityRequested: number;
  quantityFilled: number;
  avgPrice: number | null;
  /** Fee charged on this order, from the fee model in force when it filled. */
  fee: number;
  /** sent -> filled | partial | unfilled | resting | error */
  status: 'sent' | 'filled' | 'partial' | 'unfilled' | 'resting' | 'error';
  orderId?: string;
  sentAt: string;
  note?: string;
}

export interface BetRecord {
  id: string;
  user: string;
  createdAt: string;
  eventTicker: string;
  eventTitle: string;
  expiry: string | null;
  condition: { symbol: string; label: string; strike: number };
  target: { symbol: string; label: string; strike: number };
  requestedStake: number;
  quotedPrice: number;
  /**
   * open      both legs in place; stake comes back if the condition fails
   * unhedged  the hedge leg could not be completed and unwinding was not requested or failed
   * unwound   the hedge failed, so the position was sold back
   * failed    nothing was bought
   * settled   Gemini has resolved the event with a clean yes/no on both contracts
   * needs_review  Gemini settled the event but NOT as a clean yes/no (void or
   *               fractional). What Gemini reported is in `review`; the payout is
   *               unknown to this service, so the bet is never scored.
   */
  status: 'placing' | 'open' | 'unhedged' | 'unwound' | 'failed' | 'settled' | 'needs_review';
  legs: LegRecord[];
  /** Net dollars spent (buys minus any unwind proceeds). */
  cost: number;
  payoffs?: {
    stake: number;
    ifConditionFails: number;
    ifBothHit: number;
    ifConditionOnly: number;
    conditionalPrice: number | null;
    hedged: boolean;
  };
  /** The offer rule's numbers and verdict at the moment the bet was placed. */
  offer?: OfferQuote;
  /** Present when the depth guard shrank the bet so both orders fit at the best price. */
  stakeReduced?: {
    requested: number;
    /** Approximate dollars the smaller bet costs at the quoted price. */
    reducedTo: number;
    /** Contracts resting at the best price when the bet was sized. */
    outcomeAvailable: number;
    conditionAvailable: number;
    reason: string;
  };
  /** Present on needs_review bets: exactly what Gemini reported for each contract. */
  review?: {
    reason: string;
    checkedAt: string;
    eventStatus: string | null;
    condition: ReportedSettlement | null;
    target: ReportedSettlement | null;
  };
  settlement?: {
    conditionResolved: 'yes' | 'no';
    targetResolved: 'yes' | 'no';
    payout: number;
    pnl: number;
    settledAt: string;
  };
  note?: string;
}

/** One contract's settlement fields, copied from Gemini as-is. */
export interface ReportedSettlement {
  symbol: string;
  status: string | null;
  marketState: string | null;
  resolutionSide: string | null;
  /** The reference price Gemini settled against (an index level, not a payout). */
  settlementValue: string | null;
  resolvedAt: string | null;
}

export interface IntentRecord {
  id: string;
  user: string;
  createdAt: string;
  /** What must happen first. */
  trigger:
    | { kind: 'settles'; symbol: string; eventTicker: string; side: 'yes' | 'no' }
    | { kind: 'crosses'; symbol: string; direction: 'above' | 'below'; price: number };
  /** The order to send when it does. */
  action: { symbol: string; outcome: 'yes' | 'no'; limitPrice: number; quantity: number };
  /**
   * armed -> firing -> fired, or -> expired (the trigger can no longer happen) / cancelled.
   * "firing" is written BEFORE the order is sent so a restart can never send it twice.
   */
  status: 'armed' | 'firing' | 'fired' | 'expired' | 'cancelled' | 'error';
  firedAt?: string;
  observed?: string;
  leg?: LegRecord;
  note?: string;
}

export interface LedgerData {
  version: 1;
  /** Cash snapshot per user, taken when that user's ledger was started. */
  baselines: Record<string, { cash: number; at: string }>;
  bets: BetRecord[];
  intents: IntentRecord[];
}

const empty = (): LedgerData => ({ version: 1, baselines: {}, bets: [], intents: [] });

/**
 * The service's own record of what it did, in one JSON file. Gemini positions
 * are netted per account, so per-bet results can only come from here.
 * Every change is written to disk before the next order goes out.
 */
export class Ledger {
  readonly path: string;
  data: LedgerData;

  constructor(path: string) {
    this.path = path;
    this.data = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as LedgerData) : empty();
    this.data.baselines ??= {};
    this.data.bets ??= [];
    this.data.intents ??= [];
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  bet(id: string): BetRecord | undefined {
    return this.data.bets.find((b) => b.id === id);
  }

  intent(id: string): IntentRecord | undefined {
    return this.data.intents.find((i) => i.id === id);
  }

  /** Every order this service has sent for a user, across bets and triggers. */
  legs(user: string): LegRecord[] {
    const fromBets = this.data.bets.filter((b) => b.user === user).flatMap((b) => b.legs);
    const fromIntents = this.data.intents.filter((i) => i.user === user && i.leg).map((i) => i.leg!);
    return [...fromBets, ...fromIntents];
  }
}
