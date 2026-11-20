import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Direction } from './mirror.ts';
import type { OfferQuote } from './offer.ts';
import type { BreakoutQuote } from './breakout.ts';
import type { RangeQuote } from './range.ts';

/** The kinds of bet the service places. A bet recorded before there was more than one is a parlay. */
export type Product = 'parlay' | 'range' | 'breakout';

/** One order sent to Gemini, identified by the tag we attach (`clientOrderId`). */
export interface LegRecord {
  clientOrderId: string;
  role: 'outcome' | 'hedge' | 'unwind' | 'trigger' | 'cashout';
  symbol: string;
  side: 'buy' | 'sell';
  outcome: 'yes' | 'no';
  limitPrice: number;
  quantityRequested: number;
  quantityFilled: number;
  avgPrice: number | null;
  /** Fee charged on this order, from the fee model in force when it filled. */
  fee: number;
  /**
   * sent -> filled | partial | unfilled | resting | error | unknown
   *   error    the exchange refused the order, or answered twice, 3 seconds apart, that it has no such order
   *   unknown  the answer was lost and the exchange could not say what became of the order: it may have filled, so nothing
   *            else is sent for the bet until `recoverBets` (or a person) has looked
   */
  status: 'sent' | 'filled' | 'partial' | 'unfilled' | 'resting' | 'error' | 'unknown';
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
  /** What kind of bet this is. Absent on bets recorded before ranges existed: those are parlays going up. */
  product?: Product;
  /** Which way a parlay looks: "up" bets that a price reaches a higher level, "down" that it falls to a lower one. */
  direction?: Direction;
  /** Set when the bet was placed as one leg of a basket. */
  basket?: { id: string; name?: string; index: number; size: number };
  /** The "requestId" the person's app sent with the request, so a repeat of that request finds this bet instead of placing another. */
  clientRequestId?: string;
  /** Fingerprint of what the request chose (see `requestKey` in api.ts): a repeat of the id with another choice is refused, not answered with this bet. */
  requestKey?: string;
  /**
   * A parlay's condition is the strike that has to hold first and its target the strike it is really about; for a falling
   * parlay the condition is the HIGHER strike. A range has no condition: its "condition" is the lower strike (the YES leg)
   * and its "target" the higher (the NO leg). A breakout names its strikes the same way and buys the other side of each:
   * NO on the "condition" (lower) and YES on the "target" (higher).
   */
  condition: { symbol: string; label: string; strike: number };
  target: { symbol: string; label: string; strike: number };
  requestedStake: number;
  quotedPrice: number;
  /**
   * open      both legs in place; stake comes back if the condition fails
   * unhedged  the hedge leg could not be completed and unwinding was not requested or failed, or an order has no confirmed
   *            result (a leg is "unknown"): nothing more is sent for the bet and its note says to check the account
   * unwound   the hedge failed, so the position was sold back
   * failed    nothing was bought
   * settled   Gemini has resolved the event with a clean yes/no on both contracts
   * needs_review  Gemini settled the event but NOT as a clean yes/no (void or
   *               fractional). What Gemini reported is in `review`; the payout is
   *               unknown to this service, so the bet is never scored.
   * cashed_out  the user sold both legs back before the event finished; `cashOut` says for how much
   */
  status: 'placing' | 'open' | 'unhedged' | 'unwound' | 'failed' | 'settled' | 'needs_review' | 'cashed_out';
  legs: LegRecord[];
  /** Net dollars spent (buys minus any unwind proceeds). */
  cost: number;
  /**
   * What the bet pays. For a parlay: ifBothHit is the win, ifConditionOnly the loss, ifConditionFails the refund. For a
   * range: ifBothHit and ifInRange are the win, ifConditionOnly and ifOutside the loss, and there is no refund line. For a
   * breakout the same four fields the other way round: ifBothHit and ifOutside are the win, ifConditionOnly and ifInRange
   * the loss. `hedged` means both legs are in place (a range's or a breakout's two legs are matched).
   */
  payoffs?: {
    stake: number;
    ifConditionFails?: number;
    ifBothHit: number;
    ifConditionOnly: number;
    ifInRange?: number;
    ifOutside?: number;
    conditionalPrice: number | null;
    hedged: boolean;
  };
  /** The offer rule's numbers and verdict at the moment the bet was placed. */
  offer?: OfferQuote | RangeQuote | BreakoutQuote;
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
  /**
   * Present only when the second order had to wait for its contract to stop being post-only (GIVEN_SECOND_LEG_WAIT_MS,
   * off by default; see second-leg-wait.ts): how long it waited in all, how many times the event was re-read, and whether
   * the contract was open at the end. `opened: false` means the wait ran out, or the contract closed for good, and the
   * bet then went on exactly as it would have without waiting.
   */
  secondLegWait?: { waitedMs: number; reads: number; opened: boolean };
  /** Present on needs_review bets: exactly what Gemini reported for each contract. */
  review?: {
    reason: string;
    checkedAt: string;
    eventStatus: string | null;
    condition: ReportedSettlement | null;
    target: ReportedSettlement | null;
    /**
     * What Gemini actually paid for this bet, read from the account and recorded by a person (`recordReviewedPayout`).
     * It lets the cash check tie out again. The bet stays needs_review and is still never scored: a payout says what
     * was paid, not whether the call was right.
     */
    resolved?: { payout: number; pnl: number; recordedAt: string; note: string };
  };
  settlement?: {
    conditionResolved: 'yes' | 'no';
    targetResolved: 'yes' | 'no';
    payout: number;
    pnl: number;
    settledAt: string;
    /**
     * The price the ladder finished at: the reference level Gemini settled its contracts against, when it reported one.
     * It is for showing a person where the price ended. The payout never depends on it: that comes from each contract's
     * own yes or no.
     */
    finishedAt?: number;
  };
  /**
   * Present once the user has sold some or all of the bet back (`cashOutBet`). `stake` is what the bet had cost before
   * the first sale, `proceeds` what the sell orders have brought in so far after fees, and `pnl` the difference.
   * `complete` is false while part of the bet is still held; the bet is then still live and settles as usual.
   */
  cashOut?: { at: string; stake: number; proceeds: number; pnl: number; complete: boolean };
  /**
   * How the call turned out, for a bet that was sold back before its market settled. Such a bet holds nothing, so it is
   * never paid and never `settled`; but the call it stood for was still right or wrong, and selling early does not change
   * which. Recorded once the market gives a clean result, in the bet's own terms (as `settlement` reads them), so the call
   * can be revealed and scored like any other. Absent while the market is open, and for good if it settles unclearly.
   */
  called?: { conditionResolved: 'yes' | 'no'; targetResolved: 'yes' | 'no'; at: string; finishedAt?: number };
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

/**
 * A basket placed with a request id, kept so a repeat of that request is answered with this basket and places nothing.
 * Baskets sent without a request id leave no record: the bets carry their basket id and that is all there is.
 */
export interface BasketRecord {
  id: string;
  user: string;
  clientRequestId: string;
  /** As on a bet: the fingerprint of the legs that were asked for, in order. */
  requestKey?: string;
  name?: string;
  size: number;
  createdAt: string;
  /** The leg that could not be completed, and why. Null while the basket is being placed and when every leg went through. */
  failed: { index: number; code: string; message: string } | null;
  /** False until placing has finished. A record still false after a restart is a basket that was interrupted part-way. */
  done: boolean;
}

export interface LedgerData {
  version: 1;
  /** Cash snapshot per user, taken when that user's ledger was started. */
  baselines: Record<string, { cash: number; at: string }>;
  bets: BetRecord[];
  intents: IntentRecord[];
  /** By basket id; only baskets that came with a request id. Absent until there is one. */
  baskets?: Record<string, BasketRecord>;
}

const empty = (): LedgerData => ({ version: 1, baselines: {}, bets: [], intents: [] });

/** The ledger file exists but cannot be trusted. Never swallowed. */
export class LedgerError extends Error {}

function readLedger(path: string): LedgerData | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as Partial<LedgerData> | null;
    return v !== null && typeof v === 'object' && v.version === 1 && Array.isArray(v.bets) ? (v as LedgerData) : null;
  } catch {
    return null;
  }
}

/**
 * The service's own record of what it did, in one JSON file. Gemini positions
 * are netted per account, so per-bet results can only come from here.
 * Every change is written to disk before the next order goes out.
 */
export class Ledger {
  readonly path: string;
  data: LedgerData;

  constructor(path: string, warn: (line: string) => void = (l) => console.error(l)) {
    this.path = path;
    const bak = `${path}.bak`;
    let loaded: LedgerData | null = null;
    if (existsSync(path)) {
      loaded = readLedger(path);
      if (!loaded) {
        loaded = existsSync(bak) ? readLedger(bak) : null;
        if (!loaded) throw new LedgerError(`${path} exists but is not a valid ledger, and there is no usable backup. Refusing to start: an empty ledger would forget every order sent, and the next reconcile would call them mismatches. Restore it from a copy, or move it aside if you really want to begin again.`);
        warn(`[executor] ${path} was damaged; restored the previous copy (${bak}). Orders sent since that copy was written are NOT in it: run /reconcile before trading.`);
      }
    } else if (existsSync(bak)) {
      loaded = readLedger(bak);
      if (!loaded) throw new LedgerError(`${path} is missing and ${bak} is not a valid ledger. Refusing to start empty.`);
      warn(`[executor] ${path} was missing; restored ${bak}. Run /reconcile before trading.`);
    }
    this.data = loaded ?? empty();
    this.data.baselines ??= {};
    this.data.bets ??= [];
    this.data.intents ??= [];
  }

  /** Durable: temp file fsynced, the previous good copy kept as .bak, then renamed into place and the directory synced. */
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(this.data, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (existsSync(this.path) && readLedger(this.path)) copyFileSync(this.path, `${this.path}.bak`); // never replace a good backup with a bad file
    renameSync(tmp, this.path);
    const dir = openSync(dirname(this.path), 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
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
