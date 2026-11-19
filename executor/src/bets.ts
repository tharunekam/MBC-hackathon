import { randomBytes } from 'node:crypto';
import type { Exchange, OrderRequest, OrderResult } from './exchange.ts';
import type { BetRecord, Ledger, LegRecord, ReportedSettlement } from './ledger.ts';
import type { GeminiContract } from './gemini/types.ts';
import { capToDepth, planForQuantity } from './offer.ts';
import type { OfferQuote } from './offer.ts';
import { findPair, toRung } from './pairs.ts';
import { conditionalPrice } from './pricing.ts';
import { PRICE_TICK, clean, feeRate, floorToStep, hedgeQuantity, payoffs, settlementPayout, takerFee } from './pricing.ts';

export interface BetRequest {
  user: string;
  eventTicker: string;
  /** Instrument symbol of the condition (lower strike). */
  conditionSymbol: string;
  /** Instrument symbol of the outcome (higher strike). */
  targetSymbol: string;
  /** Dollars to put at risk. */
  stake: number;
  /** Highest acceptable price per $1 of payout. Defaults to the live quote plus 5 cents. */
  maxPrice?: number;
  /** How far past the best price each order may reach, in cents. Default 2. */
  slippageTicks?: number;
  /** What to do if the hedge leg can't be completed. Default: sell the position back. */
  onHedgeFail?: 'unwind' | 'leave';
}

export interface Deps {
  exchange: Exchange;
  ledger: Ledger;
  now?: () => Date;
  newId?: () => string;
  /** Taker fee coefficient; 0 means the venue charges no fees. */
  feeCoef?: number;
  /**
   * Sandbox demo switch: allow pairs the offer rule refuses ONLY for markup.
   * Every other refusal still applies. Off by default.
   */
  waiveMarkup?: boolean;
}

/**
 * A bet turned down BEFORE any order was sent. `code` says why in one word;
 * `quote` carries the offer rule's numbers when the pair could be priced.
 */
export class BetRefused extends Error {
  readonly code: 'offer_refused' | 'market_closed' | 'no_depth' | 'insufficient_depth' | 'price_above_limit' | 'stake_too_small';
  readonly quote?: OfferQuote;
  constructor(code: BetRefused['code'], message: string, quote?: OfferQuote) {
    super(message);
    this.name = 'BetRefused';
    this.code = code;
    this.quote = quote;
  }
}

/** How long after expiry an unclear settlement is given to turn into a clean yes/no before it is flagged. */
export const REVIEW_GRACE_MS = 60_000;

const MAX_HEDGE_ATTEMPTS = 3;
const defaultId = () => randomBytes(4).toString('hex');
const withinLimit = (price: number | null, max: number) => price !== null && price <= max + 1e-9;

/** Sends one order, recording it in the ledger before and after. */
async function sendLeg(deps: Deps, bet: BetRecord, role: LegRecord['role'], req: OrderRequest): Promise<LegRecord> {
  const now = deps.now ?? (() => new Date());
  const leg: LegRecord = {
    clientOrderId: req.clientOrderId,
    role,
    symbol: req.symbol,
    side: req.side,
    outcome: req.outcome,
    limitPrice: req.limitPrice,
    quantityRequested: req.quantity,
    quantityFilled: 0,
    avgPrice: null,
    fee: 0,
    status: 'sent',
    sentAt: now().toISOString(),
  };
  bet.legs.push(leg);
  deps.ledger.save(); // on disk before the order leaves, so a crash can be reconciled by tag

  let result: OrderResult;
  try {
    result = await deps.exchange.placeOrder(req);
  } catch (err) {
    leg.status = 'error';
    leg.note = err instanceof Error ? err.message : String(err);
    deps.ledger.save();
    return leg;
  }
  applyResult(leg, result, deps.feeCoef ?? 0);
  deps.ledger.save();
  return leg;
}

function applyResult(leg: LegRecord, result: OrderResult, feeCoef: number): void {
  leg.orderId = result.orderId;
  leg.quantityFilled = result.filledQuantity;
  leg.avgPrice = result.avgPrice;
  leg.fee = result.avgPrice === null ? 0 : takerFee(result.filledQuantity, result.avgPrice, feeCoef);
  if (result.open) leg.status = 'resting';
  else if (result.filledQuantity <= 0) leg.status = 'unfilled';
  else if (result.filledQuantity + 1e-9 < leg.quantityRequested) leg.status = 'partial';
  else leg.status = 'filled';
}

/** Net contracts held and net dollars spent (fees included) on one symbol/outcome within a bet. */
export function netHolding(bet: BetRecord, symbol: string, outcome: 'yes' | 'no'): { quantity: number; spent: number } {
  let quantity = 0;
  let spent = 0;
  for (const leg of bet.legs) {
    if (leg.symbol !== symbol || leg.outcome !== outcome || leg.quantityFilled <= 0 || leg.avgPrice === null) continue;
    const sign = leg.side === 'buy' ? 1 : -1;
    quantity += sign * leg.quantityFilled;
    spent += sign * leg.quantityFilled * leg.avgPrice + (leg.fee ?? 0);
  }
  return { quantity: clean(quantity), spent: clean(spent) };
}

function refreshTotals(bet: BetRecord): void {
  const b = netHolding(bet, bet.target.symbol, 'yes');
  const a = netHolding(bet, bet.condition.symbol, 'no');
  bet.cost = clean(b.spent + a.spent);
  bet.payoffs = payoffs(
    { quantity: b.quantity, avgPrice: b.quantity > 0 ? b.spent / b.quantity : 0 },
    { quantity: a.quantity, avgPrice: a.quantity > 0 ? a.spent / a.quantity : 0 },
  );
}

/**
 * Places a conditional bet "given A, will B?" as two real Gemini orders.
 *
 *   1. Buy YES on B (the outcome). Only what actually fills is hedged.
 *   2. Buy NO on A (the condition), sized from B's real cost so that the
 *      payout if A fails covers the whole stake. Retried a few times.
 *   3. If the hedge can't be completed within the price cap, the position is
 *      sold back (default) or left flagged "unhedged".
 *
 * Always returns a ledger record; it never leaves an unrecorded order behind.
 */
export async function placeConditionalBet(deps: Deps, req: BetRequest): Promise<BetRecord> {
  const now = deps.now ?? (() => new Date());
  const slip = (req.slippageTicks ?? 2) * PRICE_TICK;
  if (!(req.stake > 0)) throw new Error('Stake must be a positive dollar amount.');
  if (req.maxPrice !== undefined && !(req.maxPrice > 0 && req.maxPrice < 1)) {
    throw new Error('maxPrice must be between 0 and 1.');
  }

  const feeCoef = deps.feeCoef ?? 0;
  // First read: confirms the two contracts really are a linked pair of this event.
  const first = await deps.exchange.getEvent(req.eventTicker);
  const named = findPair(first, req.conditionSymbol, req.targetSymbol, feeCoef, deps.waiveMarkup);

  // Immediately before trading: the resting size on both legs, and a fresh read
  // of the event for prices and market state. Nothing is sent if any of it fails.
  const [depthA, depthB, event] = await Promise.all([
    deps.exchange.topOfBook(named.a.symbol),
    deps.exchange.topOfBook(named.b.symbol),
    deps.exchange.getEvent(req.eventTicker),
  ]).catch((err: unknown) => {
    throw new BetRefused(
      'no_depth',
      `Could not read the live order book, so no order was sent (${err instanceof Error ? err.message : String(err)}).`,
    );
  });
  const pair = findPair(event, req.conditionSymbol, req.targetSymbol, feeCoef, deps.waiveMarkup);

  if (!pair.a.open || !pair.b.open) {
    const closed = [pair.a, pair.b].filter((r) => !r.open).map((r) => `"${r.label}" is ${r.state}`);
    throw new BetRefused('market_closed', `${event.ticker} is not open for trading right now: ${closed.join(', ')}. No order was sent.`, pair.offer);
  }
  if (!pair.offer.offerable) {
    throw new BetRefused(
      'offer_refused',
      `This bet is not offered: ${pair.offer.reasons.map((r) => r.message).join(' ')} No order was sent.`,
      pair.offer,
    );
  }
  const quote = pair.conditionalPrice;
  if (quote === null || pair.a.bid === null || pair.b.ask === null) {
    throw new BetRefused(
      'offer_refused',
      'No conditional price is available: the book is empty or the outcome costs as much as the condition.',
      pair.offer,
    );
  }
  const maxPrice = req.maxPrice ?? Math.min(0.99, clean(quote + 0.05));
  if (quote > maxPrice) {
    throw new BetRefused(
      'price_above_limit',
      `The live price is ${quote.toFixed(3)} per $1, above your limit of ${maxPrice.toFixed(3)}.`,
      pair.offer,
    );
  }

  const wanted = floorToStep(req.stake / quote);
  if (wanted < 0.01) throw new BetRefused('stake_too_small', `A $${req.stake} stake is too small at a price of ${quote.toFixed(3)}.`, pair.offer);

  // Depth guard: an immediate-or-cancel order only fills what rests at the best
  // price, so size the bet to what is really there on BOTH legs. Size only
  // counts if it sits at the quoted price or better.
  const outcomeAvailable = depthB.ask !== null && depthB.ask <= pair.b.ask + 1e-9 ? (depthB.askSize ?? 0) : 0;
  const conditionAvailable = depthA.bid !== null && depthA.bid >= pair.a.bid - 1e-9 ? (depthA.bidSize ?? 0) : 0;
  const quantity = capToDepth(wanted, pair.b.ask, pair.a.bid, feeCoef, outcomeAvailable, conditionAvailable);
  if (quantity < 0.01) {
    throw new BetRefused(
      'insufficient_depth',
      `Not enough is on offer at the quoted price right now (${outcomeAvailable} contracts on "${pair.b.label}", ` +
        `${conditionAvailable} on "${pair.a.label}"). No order was sent; try again in a moment.`,
      pair.offer,
    );
  }
  let stakeReduced: BetRecord['stakeReduced'];
  if (quantity < wanted - 1e-9) {
    const reducedTo = Math.round(planForQuantity(quantity, pair.b.ask, pair.a.bid, feeCoef).cost * 100) / 100;
    stakeReduced = {
      requested: req.stake,
      reducedTo,
      outcomeAvailable,
      conditionAvailable,
      reason:
        `Only ${outcomeAvailable} contracts were on offer on "${pair.b.label}" and ${conditionAvailable} on "${pair.a.label}" ` +
        `at the best price, so the bet was reduced from $${req.stake.toFixed(2)} to about $${reducedTo.toFixed(2)}.`,
    };
  }

  const id = (deps.newId ?? defaultId)();
  const bet: BetRecord = {
    id,
    user: req.user,
    createdAt: now().toISOString(),
    eventTicker: event.ticker,
    eventTitle: event.title,
    expiry: event.expiryDate ?? null,
    condition: { symbol: pair.a.symbol, label: pair.a.label, strike: pair.a.strike },
    target: { symbol: pair.b.symbol, label: pair.b.label, strike: pair.b.strike },
    requestedStake: req.stake,
    quotedPrice: quote,
    status: 'placing',
    legs: [],
    cost: 0,
    offer: pair.offer,
    ...(stakeReduced ? { stakeReduced } : {}),
  };
  deps.ledger.data.bets.push(bet);
  deps.ledger.save();

  // Leg 1: the outcome. Never pay so much that the bet could exceed maxPrice even with a perfect hedge.
  let bLimit = Math.min(clean(pair.b.ask + slip), 0.99);
  while (bLimit > pair.b.ask + 1e-9 && !withinLimit(conditionalPrice(bLimit, pair.a.bid, feeCoef), maxPrice)) {
    bLimit = clean(bLimit - PRICE_TICK);
  }
  const bLeg = await sendLeg(deps, bet, 'outcome', {
    symbol: pair.b.symbol,
    side: 'buy',
    outcome: 'yes',
    limitPrice: bLimit,
    quantity,
    tif: 'IOC',
    clientOrderId: `gv-${id}-b`,
  });
  if (bLeg.status === 'error' || bLeg.quantityFilled <= 0) {
    bet.status = 'failed';
    bet.note = bLeg.status === 'error' ? `Outcome order failed: ${bLeg.note}` : 'Nothing was available at the quoted price, so no bet was placed.';
    refreshTotals(bet);
    deps.ledger.save();
    return bet;
  }

  // Leg 2: the hedge, sized from what leg 1 really cost.
  await hedge(deps, bet, maxPrice, slip);
  refreshTotals(bet);

  if (bet.payoffs?.hedged) {
    bet.status = 'open';
  } else if ((req.onHedgeFail ?? 'unwind') === 'unwind') {
    await unwind(deps, bet, slip);
  } else {
    bet.status = 'unhedged';
    bet.note = 'The hedge leg could not be completed within the price limit; the stake is NOT fully protected if the condition fails.';
  }
  refreshTotals(bet);
  deps.ledger.save();
  return bet;
}

async function hedge(deps: Deps, bet: BetRecord, maxPrice: number, slip: number): Promise<void> {
  for (let attempt = 1; attempt <= MAX_HEDGE_ATTEMPTS; attempt++) {
    const b = netHolding(bet, bet.target.symbol, 'yes');
    const a = netHolding(bet, bet.condition.symbol, 'no');
    if (b.quantity <= 0) return;

    // Fresh book for the condition each attempt.
    const event = await deps.exchange.getEvent(bet.eventTicker);
    const contract = event.contracts.find((c) => c.instrumentSymbol === bet.condition.symbol);
    const rung = contract ? toRung(contract) : null;
    if (!rung || !rung.open || rung.bid === null) return;

    const feeCoef = deps.feeCoef ?? 0;
    const noAsk = clean(1 - rung.bid);
    // Highest NO price, from the best offer upward, that keeps the whole bet at or under maxPrice.
    const allIn = (noPrice: number) => {
      const refundPerHedge = 1 - noPrice - feeRate(noPrice, feeCoef);
      return refundPerHedge > 0 ? b.spent / b.quantity / refundPerHedge : Infinity;
    };
    let limit = Math.min(clean(noAsk + slip), 0.99);
    while (limit > noAsk + 1e-9 && allIn(limit) > maxPrice + 1e-9) limit = clean(limit - PRICE_TICK);
    if (limit < noAsk - 1e-9 || allIn(limit) > maxPrice + 1e-9) return; // hedging now would break the price limit

    const need = hedgeQuantity(b.spent, limit, a.quantity, a.spent, feeCoef);
    if (need <= 0) return;

    const leg = await sendLeg(deps, bet, 'hedge', {
      symbol: bet.condition.symbol,
      side: 'buy',
      outcome: 'no',
      limitPrice: limit,
      quantity: need,
      tif: 'IOC',
      clientOrderId: `gv-${bet.id}-a${attempt}`,
    });
    if (leg.status === 'filled') return;
  }
}

/** Sells back whatever the bet holds, because the hedge could not be completed. */
async function unwind(deps: Deps, bet: BetRecord, slip: number): Promise<void> {
  const event = await deps.exchange.getEvent(bet.eventTicker);
  const book = (symbol: string) => {
    const c = event.contracts.find((x) => x.instrumentSymbol === symbol);
    return c ? toRung(c) : null;
  };

  const b = netHolding(bet, bet.target.symbol, 'yes');
  const bBook = book(bet.target.symbol);
  if (b.quantity > 0 && bBook?.bid != null) {
    await sendLeg(deps, bet, 'unwind', {
      symbol: bet.target.symbol,
      side: 'sell',
      outcome: 'yes',
      limitPrice: Math.max(PRICE_TICK, clean(bBook.bid - slip)),
      quantity: b.quantity,
      tif: 'IOC',
      clientOrderId: `gv-${bet.id}-ub`,
    });
  }

  const a = netHolding(bet, bet.condition.symbol, 'no');
  const aBook = book(bet.condition.symbol);
  if (a.quantity > 0 && aBook?.ask != null) {
    // The NO bid is 1 minus the YES ask.
    await sendLeg(deps, bet, 'unwind', {
      symbol: bet.condition.symbol,
      side: 'sell',
      outcome: 'no',
      limitPrice: Math.max(PRICE_TICK, clean(1 - aBook.ask - slip)),
      quantity: a.quantity,
      tif: 'IOC',
      clientOrderId: `gv-${bet.id}-ua`,
    });
  }

  const left = netHolding(bet, bet.target.symbol, 'yes').quantity + netHolding(bet, bet.condition.symbol, 'no').quantity;
  if (left <= 1e-9) {
    bet.status = 'unwound';
    bet.note = 'The hedge leg could not be completed within the price limit, so the position was sold back.';
  } else {
    bet.status = 'unhedged';
    bet.note = 'The hedge leg could not be completed and the position could not be fully sold back; the stake is NOT fully protected.';
  }
}

/**
 * Fills in any order that was sent but whose result was never recorded
 * (for example, the process stopped mid-bet). Looks each one up by its tag.
 */
export async function recoverBets(deps: Deps, user?: string): Promise<number> {
  let fixed = 0;
  // A copy of the list: bets placed while this runs are in flight, not interrupted, and must not be touched.
  for (const bet of [...deps.ledger.data.bets]) {
    // Orders can only be looked up on the account that sent them.
    if (user !== undefined && bet.user !== user) continue;
    const pending = bet.legs.filter((l) => l.status === 'sent');
    if (pending.length === 0 && bet.status !== 'placing') continue;
    for (const leg of pending) {
      const found = await deps.exchange.findOrder(leg.clientOrderId);
      if (found) applyResult(leg, found, deps.feeCoef ?? 0);
      else {
        leg.status = 'unfilled';
        leg.note = 'Gemini has no order with this tag; it was never received.';
      }
      fixed++;
    }
    refreshTotals(bet);
    if (bet.status === 'placing') {
      const held = netHolding(bet, bet.target.symbol, 'yes').quantity;
      bet.status = held <= 0 ? 'failed' : bet.payoffs?.hedged ? 'open' : 'unhedged';
      if (bet.status === 'unhedged') bet.note = 'Recovered after an interruption: the hedge leg is incomplete.';
    }
  }
  if (fixed > 0) deps.ledger.save();
  return fixed;
}

const isClean = (side: string | null | undefined): side is 'yes' | 'no' => side === 'yes' || side === 'no';
const isSettled = (c: GeminiContract | undefined): boolean => c !== undefined && (c.status === 'settled' || Boolean(c.resolvedAt));

function reported(c: GeminiContract | undefined, symbol: string): ReportedSettlement | null {
  if (!c) return null;
  return {
    symbol,
    status: c.status ?? null,
    marketState: c.marketState ?? null,
    resolutionSide: c.resolutionSide ?? null,
    settlementValue: c.settlementValue ?? null,
    resolvedAt: c.resolvedAt ?? null,
  };
}

export interface SettleResult {
  /** Bets that settled cleanly on this pass. */
  settled: BetRecord[];
  /** Bets newly flagged because Gemini settled them without a clean yes/no. */
  needsReview: BetRecord[];
}

/** True when a bet's result may be used for scoring: settled with a clean yes/no on both contracts. */
export const isScorable = (bet: BetRecord): boolean => bet.status === 'settled' && bet.settlement !== undefined;

/** Why a payout could not be recorded by hand. */
export class ReviewError extends Error {
  readonly code: 'unknown_bet' | 'not_in_review' | 'bad_payout' | 'bad_note';
  constructor(code: ReviewError['code'], message: string) {
    super(message);
    this.name = 'ReviewError';
    this.code = code;
  }
}

/** The most a bet's two legs could ever pay: every contract it holds, at a dollar each. */
export function maxPayout(bet: BetRecord): number {
  const yes = netHolding(bet, bet.target.symbol, 'yes').quantity;
  const no = netHolding(bet, bet.condition.symbol, 'no').quantity;
  return clean(Math.max(0, yes) + Math.max(0, no));
}

/**
 * Records, by hand, what Gemini actually paid for a bet it settled WITHOUT a clean yes/no (a void or fractional
 * settlement). This service cannot work that payout out, so until someone reads it off the account the cash check is off
 * by exactly that amount. Only a bet in needs_review can be given one; the note says where the number came from.
 *
 * It does not make the bet scorable: it stays needs_review, has no `settlement`, and no call is ever revealed for it.
 * If Gemini later reports a clean result, settleBets replaces this with the computed payout.
 */
export function recordReviewedPayout(ledger: Ledger, betId: string, payout: number, note: string, now: () => Date = () => new Date()): BetRecord {
  const bet = ledger.data.bets.find((b) => b.id === betId);
  if (!bet) throw new ReviewError('unknown_bet', `No bet ${betId}.`);
  if (bet.status !== 'needs_review' || !bet.review) throw new ReviewError('not_in_review', `Bet ${betId} is "${bet.status}". Only a bet Gemini settled without a clean result can be given a payout by hand.`);
  if (typeof payout !== 'number' || !Number.isFinite(payout) || payout < 0) throw new ReviewError('bad_payout', 'The payout must be a dollar amount of zero or more.');
  const most = maxPayout(bet);
  if (payout > most + 0.005) throw new ReviewError('bad_payout', `This bet holds ${most} contracts in all, so it cannot have paid more than $${most.toFixed(2)}. Check the amount.`);
  const text = typeof note === 'string' ? note.trim() : '';
  if (text.length < 5 || text.length > 300) throw new ReviewError('bad_note', 'Say where the amount came from (5 to 300 characters), for whoever checks this later.');
  const paid = clean(Math.round(payout * 100) / 100);
  bet.review.resolved = { payout: paid, pnl: clean(paid - bet.cost), recordedAt: now().toISOString(), note: text };
  ledger.save();
  return bet;
}

/**
 * Records results once Gemini has resolved both contracts.
 *
 *   clean yes/no on both      -> "settled", with payout and profit
 *   settled, but not clean    -> "needs_review": what Gemini reported is saved,
 *                                no payout is guessed, the bet is never scored
 *   not settled yet           -> left alone
 *
 * A bet can therefore never sit "open" forever after its event has settled.
 * Bets in needs_review are re-checked each pass and promoted to "settled" if
 * Gemini later reports a clean result.
 */
export async function settleBets(deps: Deps): Promise<SettleResult> {
  const now = deps.now ?? (() => new Date());
  const result: SettleResult = { settled: [], needsReview: [] };
  const events = new Map<string, Awaited<ReturnType<Exchange['getEvent']>>>();

  for (const bet of deps.ledger.data.bets) {
    if (bet.status !== 'open' && bet.status !== 'unhedged' && bet.status !== 'needs_review') continue;
    if (!events.has(bet.eventTicker)) events.set(bet.eventTicker, await deps.exchange.getEvent(bet.eventTicker));
    const event = events.get(bet.eventTicker)!;
    const aContract = event.contracts.find((c) => c.instrumentSymbol === bet.condition.symbol);
    const bContract = event.contracts.find((c) => c.instrumentSymbol === bet.target.symbol);
    const aSide = aContract?.resolutionSide;
    const bSide = bContract?.resolutionSide;

    if (isClean(aSide) && isClean(bSide)) {
      const b = netHolding(bet, bet.target.symbol, 'yes');
      const a = netHolding(bet, bet.condition.symbol, 'no');
      const payout = settlementPayout({ quantity: b.quantity, avgPrice: 0 }, { quantity: a.quantity, avgPrice: 0 }, aSide, bSide);
      bet.settlement = {
        conditionResolved: aSide,
        targetResolved: bSide,
        payout,
        pnl: clean(payout - bet.cost),
        settledAt: now().toISOString(),
      };
      if (bet.status === 'needs_review') {
        bet.note = 'Gemini reported a clean result after this bet had been flagged for review.';
        // A payout recorded by hand gives way to the computed one. It is never counted beside it.
        if (bet.review?.resolved) {
          bet.note += ` It replaced a payout of $${bet.review.resolved.payout.toFixed(2)} recorded by hand.`;
          bet.review.resolved = undefined;
        }
      }
      bet.status = 'settled';
      result.settled.push(bet);
      continue;
    }

    if (bet.status === 'needs_review') continue; // already flagged; still no clean result

    // Settled, but not as a clean yes/no? Either the event itself is marked settled (whatever each
    // contract says: a voided contract may carry some other status, or be gone), or both contracts are.
    const eventSettled = event.status === 'settled';
    const aDone = eventSettled || isSettled(aContract);
    const bDone = eventSettled || isSettled(bContract);
    if (!aDone || !bDone) continue; // not settled yet
    // The result can trail the "settled" flag by a few seconds; give it a minute past expiry.
    const expiry = bet.expiry ? Date.parse(bet.expiry) : NaN;
    if (Number.isFinite(expiry) && now().getTime() - expiry < REVIEW_GRACE_MS) continue;

    const unclear = [
      isClean(aSide) ? null : `condition reported "${aSide ?? 'nothing'}"`,
      isClean(bSide) ? null : `outcome reported "${bSide ?? 'nothing'}"`,
    ].filter((x) => x !== null);
    bet.review = {
      reason: `Gemini settled this event without a clean yes/no result (${unclear.join(', ')}). The payout is not known to Given; check the account.`,
      checkedAt: now().toISOString(),
      eventStatus: event.status ?? null,
      condition: reported(aContract, bet.condition.symbol),
      target: reported(bContract, bet.target.symbol),
    };
    bet.status = 'needs_review';
    result.needsReview.push(bet);
  }
  if (result.settled.length > 0 || result.needsReview.length > 0) deps.ledger.save();
  return result;
}
