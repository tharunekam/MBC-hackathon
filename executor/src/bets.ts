import { randomBytes } from 'node:crypto';
import { OrderNotSent, OrderUnconfirmed } from './exchange.ts';
import type { Exchange, OrderRequest, OrderResult } from './exchange.ts';
import type { BetRecord, Ledger, LegRecord, ReportedSettlement } from './ledger.ts';
import type { GeminiContract, GeminiEvent } from './gemini/types.ts';
import { flipOutcome, realStrike, viewFor } from './mirror.ts';
import type { Direction } from './mirror.ts';
import { betIdFor } from './bet-id.ts';
import { DEFAULT_SLIP, capToDepth, contractsForStake, planForQuantity } from './offer.ts';
import type { OfferQuote } from './offer.ts';
import { findPair, toRung } from './pairs.ts';
import type { LinkedPair } from './pairs.ts';
import { conditionalPrice } from './pricing.ts';
import type { BreakoutQuote } from './breakout.ts';
import type { RangeQuote } from './range.ts';
import { PRICE_TICK, clean, feeRate, floorToStep, hedgeQuantity, settlementPayout, takerFee } from './pricing.ts';

export interface BetRequest {
  user: string;
  eventTicker: string;
  /** Instrument symbol of the condition: the lower strike for a rising bet, the higher strike for a falling one. */
  conditionSymbol: string;
  /** Instrument symbol of the outcome: the higher strike for a rising bet, the lower strike for a falling one. */
  targetSymbol: string;
  /** Which way the bet looks. Default "up": the price reaches a higher level. "down": it falls to a lower one. */
  direction?: Direction;
  /** Dollars to put at risk. */
  stake: number;
  /** Highest acceptable price per $1 of payout. Defaults to the live quote plus 5 cents. */
  maxPrice?: number;
  /** How far past the best price each order may reach, in cents. Default 2. */
  slippageTicks?: number;
  /** What to do if the hedge leg can't be completed. Default: sell the position back. */
  onHedgeFail?: 'unwind' | 'leave';
  /** Set when the bet is one leg of a basket. */
  basket?: NonNullable<BetRecord['basket']>;
  /** The request id the app sent; stored on the bet so a repeat of the request can be answered with it. */
  clientRequestId?: string;
  /** A short fingerprint of what the person chose, kept with the bet so a request id reused for something else can be told from a repeat. */
  requestKey?: string;
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
  /** Milliseconds to wait before each look-up of an order whose answer was lost. Default LOOKUP_WAITS_MS; tests shorten it. */
  lookupWaitsMs?: number[];
}

/**
 * A bet turned down BEFORE any order was sent. `code` says why in one word;
 * `quote` carries the offer rule's numbers when the pair could be priced.
 */
export class BetRefused extends Error {
  readonly code: 'offer_refused' | 'market_closed' | 'no_depth' | 'insufficient_depth' | 'price_above_limit' | 'stake_too_small';
  readonly quote?: OfferQuote | RangeQuote | BreakoutQuote;
  constructor(code: BetRefused['code'], message: string, quote?: OfferQuote | RangeQuote | BreakoutQuote) {
    super(message);
    this.name = 'BetRefused';
    this.code = code;
    this.quote = quote;
  }
}

/** How long after expiry an unclear settlement is given to turn into a clean yes/no before it is flagged. */
export const REVIEW_GRACE_MS = 60_000;

export const MAX_HEDGE_ATTEMPTS = 3;
export const defaultId = (): string => randomBytes(4).toString('hex');
/** The exchange's own words about an order book it could not give go to the log; the person is told only that it could not be read. */
export const logUnreadableBook = (err: unknown): void => console.error(`[executor] the order book could not be read: ${err instanceof Error ? err.message : String(err)}`);
export const withinLimit = (price: number | null, max: number): boolean => price !== null && price <= max + 1e-9;

// ------------------------------------------------------------------ which leg is which

/**
 * The two legs of any bet, named by what they do. In the bet's own view of the ladder the outcome leg is always a YES and
 * the hedge leg always a NO; `side` is what the order really is on Gemini.
 *
 *   parlay, going up      outcome: YES on the target (higher strike)   hedge: NO on the condition (lower strike)
 *   parlay, going down    outcome: NO on the target (lower strike)     hedge: YES on the condition (higher strike)
 *   range                 outcome: YES on the lower strike             hedge: NO on the higher strike
 *   breakout              outcome: YES on the higher strike            hedge: NO on the lower strike
 *
 * A breakout's two orders are the ones a rising parlay sends (YES on its "target", NO on its "condition"), in equal size
 * instead of refund size, so it needs no case of its own here.
 */
export function legMap(bet: Pick<BetRecord, 'product' | 'direction' | 'condition' | 'target'>): {
  outcome: { symbol: string; side: 'yes' | 'no' };
  hedge: { symbol: string; side: 'yes' | 'no' };
} {
  if (bet.product === 'range') {
    return { outcome: { symbol: bet.condition.symbol, side: 'yes' }, hedge: { symbol: bet.target.symbol, side: 'no' } };
  }
  const down = bet.direction === 'down';
  return {
    outcome: { symbol: bet.target.symbol, side: down ? 'no' : 'yes' },
    hedge: { symbol: bet.condition.symbol, side: down ? 'yes' : 'no' },
  };
}

/**
 * When an order's answer is lost, how long to wait before each look-up of it by its tag. The exchange's order history can
 * trail a fresh order by a second or two, so an order that is "not there" at once may simply not be listed yet.
 */
export const LOOKUP_WAITS_MS = [0, 500, 1500, 3000];
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Asks the exchange for an order by its tag, a few times. `order` is what it says when it has the order. `absent` is true
 * only when its last two answers were both "no such order" (so it was asked, twice, seconds apart, and could answer):
 * an exchange that errors, or is silent, has told us nothing.
 */
async function lookUpOrder(deps: Deps, req: OrderRequest): Promise<{ order: OrderResult | null; absent: boolean }> {
  const waits = deps.lookupWaitsMs ?? LOOKUP_WAITS_MS;
  let noSuchOrder = 0;
  for (const [i, wait] of waits.entries()) {
    if (wait > 0) await pause(wait);
    try {
      // The order was sent moments ago, so the newest orders are enough; only the last look reads the whole history.
      const found = await deps.exchange.findOrder(req.clientOrderId, { recent: i < waits.length - 1 });
      // An immediate-or-cancel order that still reads as open is not finished yet; ask again.
      if (found && (req.tif === 'GTC' || !found.open)) return { order: found, absent: false };
      noSuchOrder = found ? 0 : noSuchOrder + 1;
    } catch {
      noSuchOrder = 0;
    }
  }
  return { order: null, absent: noSuchOrder >= 2 };
}

/**
 * Sends one order, recording it in the ledger before and after.
 *
 * If the answer is lost (a timeout, a socket that closed mid-request) the order may still have reached the exchange and
 * filled, so it is looked up by its tag before anything is concluded: found, it is recorded as the exchange says; the
 * exchange saying twice that it has no such order is an "error" leg, as for a refusal; and when the exchange cannot say, the
 * leg is "unknown" and the caller must send nothing further for the bet. An order the exchange refused is "error" at once.
 */
export async function sendLeg(deps: Deps, bet: BetRecord, role: LegRecord['role'], req: OrderRequest): Promise<LegRecord> {
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
    const message = err instanceof Error ? err.message : String(err);
    leg.note = message;
    if (err instanceof OrderNotSent) {
      leg.status = 'error';
    } else {
      const looked = await lookUpOrder(deps, req);
      if (looked.order) {
        applyResult(leg, looked.order, deps.feeCoef ?? 0);
        leg.note = `${message}; the order was then found on the exchange by its tag.`;
      } else if (looked.absent && !(err instanceof OrderUnconfirmed)) {
        leg.status = 'error';
      } else {
        leg.status = 'unknown';
        leg.note = `${message}; the exchange could not confirm what became of the order.`;
      }
    }
    deps.ledger.save();
    return leg;
  }
  applyResult(leg, result, deps.feeCoef ?? 0);
  deps.ledger.save();
  return leg;
}

/** What a bet says while one of its orders has no confirmed result. */
export const UNKNOWN_NOTE =
  'Gemini did not confirm one of this bet\'s orders, so the bet may be partly or fully in place. Nothing more was sent. Check your Gemini account.';

/** True while an order of the bet has been sent but its result is not recorded: the bet's figures are not final. */
export const hasUnresolvedLeg = (bet: Pick<BetRecord, 'legs'>): boolean => bet.legs.some((l) => l.status === 'sent' || l.status === 'unknown');

/** Ends a bet that has an unconfirmed order: it sends nothing further, and says so rather than "placed" or "failed". */
export function holdForCheck(deps: Deps, bet: BetRecord): BetRecord {
  refreshTotals(bet);
  bet.status = 'unhedged';
  bet.note = UNKNOWN_NOTE;
  deps.ledger.save();
  return bet;
}

export function applyResult(leg: LegRecord, result: OrderResult, feeCoef: number): void {
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

/** What a bet holds on each of its two legs. */
export function holdings(bet: BetRecord): { outcome: { quantity: number; spent: number }; hedge: { quantity: number; spent: number } } {
  const m = legMap(bet);
  return { outcome: netHolding(bet, m.outcome.symbol, m.outcome.side), hedge: netHolding(bet, m.hedge.symbol, m.hedge.side) };
}

export function refreshTotals(bet: BetRecord): void {
  const h = holdings(bet);
  bet.cost = clean(h.outcome.spent + h.hedge.spent);
  if (bet.product === 'range') {
    const both = Math.min(h.outcome.quantity, h.hedge.quantity);
    const ifInRange = clean(h.outcome.quantity + h.hedge.quantity - bet.cost);
    const ifOutside = clean(both - bet.cost);
    bet.payoffs = {
      stake: bet.cost,
      ifBothHit: ifInRange,
      ifConditionOnly: ifOutside,
      ifInRange,
      ifOutside,
      conditionalPrice: both > 0 ? clean((bet.cost - both) / both) : null,
      hedged: both > 0 && Math.abs(h.outcome.quantity - h.hedge.quantity) < 1e-9,
    };
    return;
  }
  if (bet.product === 'breakout') {
    // One leg pays a dollar a contract when the price ends outside, whichever side; the smaller leg is what is certain.
    const both = Math.min(h.outcome.quantity, h.hedge.quantity);
    const ifOutside = clean(both - bet.cost);
    const ifInRange = clean(-bet.cost);
    bet.payoffs = {
      stake: bet.cost,
      ifBothHit: ifOutside,
      ifConditionOnly: ifInRange,
      ifInRange,
      ifOutside,
      conditionalPrice: both > 0 ? clean(bet.cost / both) : null,
      hedged: both > 0 && Math.abs(h.outcome.quantity - h.hedge.quantity) < 1e-9,
    };
    return;
  }
  // What the bet has cost is bet.cost, net of anything sold back. It cannot be rebuilt from each leg's average price: a leg
  // that was sold back (an unwound bet, or one part-way through a cash-out) holds nothing now, yet what it lost is real.
  const ifConditionFails = clean(h.hedge.quantity - bet.cost);
  bet.payoffs = {
    stake: bet.cost,
    ifConditionFails,
    ifBothHit: clean(h.outcome.quantity - bet.cost),
    ifConditionOnly: clean(-bet.cost),
    conditionalPrice: h.outcome.quantity > 0 ? clean(bet.cost / h.outcome.quantity) : null,
    hedged: h.outcome.quantity > 0 && ifConditionFails >= -0.005,
  };
}

/**
 * Brings a bet's cash-out record in line with the sell orders it has actually had filled. `cashOutBet` writes the record
 * (with what the bet cost) before its first order leaves, so this can rebuild the rest from the legs alone: after each
 * sale, and after `recoverBets` has filled in a sale that was interrupted.
 *
 *   nothing sold yet     the record is dropped; the bet is as it was
 *   everything sold      "cashed_out"
 *   part sold            the bet stays live on what it still holds, and says so
 */
export function refreshCashOut(bet: BetRecord): void {
  if (!bet.cashOut) return;
  const sells = bet.legs.filter((l) => l.role === 'cashout' && l.quantityFilled > 0 && l.avgPrice !== null);
  if (sells.length === 0) {
    bet.cashOut = undefined;
    return;
  }
  if (bet.status !== 'open' && bet.status !== 'unhedged' && bet.status !== 'cashed_out') return;
  const proceeds = clean(sells.reduce((sum, l) => sum + l.quantityFilled * l.avgPrice! - (l.fee ?? 0), 0));
  const h = holdings(bet);
  const complete = clean(Math.max(0, h.outcome.quantity) + Math.max(0, h.hedge.quantity)) <= 1e-9;
  bet.cashOut = { at: bet.cashOut.at, stake: bet.cashOut.stake, proceeds, pnl: clean(proceeds - bet.cashOut.stake), complete };
  if (complete) {
    bet.status = 'cashed_out';
    bet.note = undefined;
  } else {
    bet.status = bet.payoffs?.hedged ? 'open' : 'unhedged';
    bet.note =
      h.outcome.quantity > 1e-9
        ? 'Only part of this bet could be sold back. The rest is still in place and can be cashed out again.'
        : 'The first half of this bet was sold. What is left pays the stake back if the condition fails, and can be sold again.';
  }
}

// ------------------------------------------------------------------ parlays

/** Everything read and decided before a parlay's first order. Nothing here sends an order. */
export interface ConditionalPlan {
  direction: Direction;
  /** The ticker's event as read just before trading (the real one, not the mirror). */
  event: GeminiEvent;
  /** The pair as the bet sees it: for a falling bet this is on the mirror of the ladder. */
  pair: LinkedPair;
  quote: number;
  maxPrice: number;
  quantity: number;
  slip: number;
  stakeReduced?: BetRecord['stakeReduced'];
}

/**
 * Reads the market and applies every check a parlay must pass: the pair is real, both contracts are open, the offer rule
 * accepts the price, the price is within the limit, and enough rests on the book on BOTH legs. Throws `BetRefused` (before
 * anything is bought) when it does not. Used by `placeConditionalBet` and, for a basket, to check every leg before the first
 * one is placed.
 */
export async function planConditionalBet(deps: Deps, req: BetRequest): Promise<ConditionalPlan> {
  const direction = req.direction ?? 'up';
  const slip = req.slippageTicks === undefined ? DEFAULT_SLIP : req.slippageTicks * PRICE_TICK;
  if (!(req.stake > 0)) throw new Error('Stake must be a positive dollar amount.');
  if (req.maxPrice !== undefined && !(req.maxPrice > 0 && req.maxPrice < 1)) {
    throw new Error('maxPrice must be between 0 and 1.');
  }

  const feeCoef = deps.feeCoef ?? 0;
  const view = viewFor(deps.exchange, direction);
  // First read: confirms the two contracts really are a linked pair of this event.
  const first = await deps.exchange.getEvent(req.eventTicker);
  const named = findPair(first, req.conditionSymbol, req.targetSymbol, feeCoef, deps.waiveMarkup, direction);

  // Immediately before trading: the resting size on both legs, and a fresh read
  // of the event for prices and market state. Nothing is sent if any of it fails.
  const [depthA, depthB, event] = await Promise.all([
    view.topOfBook(named.a.symbol),
    view.topOfBook(named.b.symbol),
    deps.exchange.getEvent(req.eventTicker),
  ]).catch((err: unknown) => {
    logUnreadableBook(err);
    throw new BetRefused('no_depth', 'Could not read the live order book, so no order was sent.');
  });
  const pair = findPair(event, req.conditionSymbol, req.targetSymbol, feeCoef, deps.waiveMarkup, direction);

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

  // Sized as the two orders will really be sent, so the bet never costs more than the stake that was asked for.
  const wanted = contractsForStake(req.stake, pair.b.ask, pair.a.bid, feeCoef, slip);
  if (wanted < 0.01) throw new BetRefused('stake_too_small', `A $${req.stake} stake is too small at a price of ${quote.toFixed(3)}.`, pair.offer);

  // Depth guard: an immediate-or-cancel order only fills what rests at the best
  // price, so size the bet to what is really there on BOTH legs. Size only
  // counts if it sits at the quoted price or better.
  const outcomeAvailable = depthB.ask !== null && depthB.ask <= pair.b.ask + 1e-9 ? (depthB.askSize ?? 0) : 0;
  const conditionAvailable = depthA.bid !== null && depthA.bid >= pair.a.bid - 1e-9 ? (depthA.bidSize ?? 0) : 0;
  const quantity = capToDepth(wanted, pair.b.ask, pair.a.bid, feeCoef, outcomeAvailable, conditionAvailable, slip);
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
    const reducedTo = Math.round(planForQuantity(quantity, pair.b.ask, pair.a.bid, feeCoef, slip).cost * 100) / 100;
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
  return { direction, event, pair, quote, maxPrice, quantity, slip, ...(stakeReduced ? { stakeReduced } : {}) };
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
 * A falling bet is the same thing on the mirror of the ladder: the outcome is a NO on the lower strike and the hedge a YES on
 * the higher one (see mirror.ts). Always returns a ledger record; it never leaves an unrecorded order behind.
 */
export async function placeConditionalBet(deps: Deps, req: BetRequest): Promise<BetRecord> {
  const now = deps.now ?? (() => new Date());
  const feeCoef = deps.feeCoef ?? 0;
  const plan = await planConditionalBet(deps, req);
  const { direction, event, pair, quote, maxPrice, quantity, slip, stakeReduced } = plan;

  const id = betIdFor('parlay', direction, (deps.newId ?? defaultId)());
  const bet: BetRecord = {
    id,
    user: req.user,
    createdAt: now().toISOString(),
    eventTicker: event.ticker,
    eventTitle: event.title,
    expiry: event.expiryDate ?? null,
    product: 'parlay',
    ...(direction === 'down' ? { direction } : {}),
    ...(req.basket ? { basket: req.basket } : {}),
    ...(req.clientRequestId ? { clientRequestId: req.clientRequestId } : {}),
    ...(req.requestKey ? { requestKey: req.requestKey } : {}),
    condition: { symbol: pair.a.symbol, label: pair.a.label, strike: realStrike(direction, pair.a.strike) },
    target: { symbol: pair.b.symbol, label: pair.b.label, strike: realStrike(direction, pair.b.strike) },
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
  const m = legMap(bet);
  const view: Deps = { ...deps, exchange: viewFor(deps.exchange, direction) };

  // Leg 1: the outcome. Never pay so much that the bet could exceed maxPrice even with a perfect hedge.
  let bLimit = Math.min(clean(pair.b.ask! + slip), 0.99);
  while (bLimit > pair.b.ask! + 1e-9 && !withinLimit(conditionalPrice(bLimit, pair.a.bid, feeCoef), maxPrice)) {
    bLimit = clean(bLimit - PRICE_TICK);
  }
  const bLeg = await sendLeg(deps, bet, 'outcome', {
    symbol: m.outcome.symbol,
    side: 'buy',
    outcome: m.outcome.side,
    limitPrice: bLimit,
    quantity,
    tif: 'IOC',
    clientOrderId: `gv-${id}-b`,
  });
  if (bLeg.status === 'unknown') return holdForCheck(deps, bet);
  if (bLeg.status === 'error' || bLeg.quantityFilled <= 0) {
    bet.status = 'failed';
    bet.note = bLeg.status === 'error' ? `Outcome order failed: ${bLeg.note}` : 'Nothing was available at the quoted price, so no bet was placed.';
    refreshTotals(bet);
    deps.ledger.save();
    return bet;
  }

  // Leg 2: the hedge, sized from what leg 1 really cost.
  await hedge(view, bet, maxPrice, slip);
  if (bet.legs.some((l) => l.status === 'unknown')) return holdForCheck(deps, bet); // never unwind or re-hedge around an order that may have filled
  refreshTotals(bet);

  if (bet.payoffs?.hedged) {
    bet.status = 'open';
  } else if ((req.onHedgeFail ?? 'unwind') === 'unwind') {
    await unwind(view, bet, slip);
  } else {
    bet.status = 'unhedged';
    bet.note = 'The hedge leg could not be completed within the price limit; the stake is NOT fully protected if the condition fails.';
  }
  refreshTotals(bet);
  deps.ledger.save();
  return bet;
}

/** `deps.exchange` is the bet's own view of the ladder (the mirror for a falling bet), so every price read here is in the bet's terms. */
async function hedge(deps: Deps, bet: BetRecord, maxPrice: number, slip: number): Promise<void> {
  const m = legMap(bet);
  for (let attempt = 1; attempt <= MAX_HEDGE_ATTEMPTS; attempt++) {
    const b = netHolding(bet, m.outcome.symbol, m.outcome.side);
    const a = netHolding(bet, m.hedge.symbol, m.hedge.side);
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
      symbol: m.hedge.symbol,
      side: 'buy',
      outcome: m.hedge.side,
      limitPrice: limit,
      quantity: need,
      tif: 'IOC',
      clientOrderId: `gv-${bet.id}-a${attempt}`,
    });
    if (leg.status === 'filled' || leg.status === 'unknown') return;
  }
}

/**
 * Sells back whatever the bet holds, because the hedge could not be completed. `deps.exchange` is the bet's own view of the
 * ladder: in it the outcome leg is always a YES (sold at the bid) and the hedge leg a NO (sold at 1 minus the ask).
 */
export async function unwind(deps: Deps, bet: BetRecord, slip: number): Promise<void> {
  const m = legMap(bet);
  const event = await deps.exchange.getEvent(bet.eventTicker);
  const book = (symbol: string) => {
    const c = event.contracts.find((x) => x.instrumentSymbol === symbol);
    return c ? toRung(c) : null;
  };

  const b = netHolding(bet, m.outcome.symbol, m.outcome.side);
  const bBook = book(m.outcome.symbol);
  if (b.quantity > 0 && bBook?.bid != null) {
    await sendLeg(deps, bet, 'unwind', {
      symbol: m.outcome.symbol,
      side: 'sell',
      outcome: m.outcome.side,
      limitPrice: Math.max(PRICE_TICK, clean(bBook.bid - slip)),
      quantity: b.quantity,
      tif: 'IOC',
      clientOrderId: `gv-${bet.id}-ub`,
    });
  }

  const a = netHolding(bet, m.hedge.symbol, m.hedge.side);
  const aBook = book(m.hedge.symbol);
  if (a.quantity > 0 && aBook?.ask != null) {
    // The NO bid is 1 minus the YES ask.
    await sendLeg(deps, bet, 'unwind', {
      symbol: m.hedge.symbol,
      side: 'sell',
      outcome: m.hedge.side,
      limitPrice: Math.max(PRICE_TICK, clean(1 - aBook.ask - slip)),
      quantity: a.quantity,
      tif: 'IOC',
      clientOrderId: `gv-${bet.id}-ua`,
    });
  }

  const left = netHolding(bet, m.outcome.symbol, m.outcome.side).quantity + netHolding(bet, m.hedge.symbol, m.hedge.side).quantity;
  if (left <= 1e-9 && !hasUnresolvedLeg(bet)) {
    bet.status = 'unwound';
    bet.note = 'The second order could not be completed within the price limit, so the position was sold back.';
  } else {
    bet.status = 'unhedged';
    bet.note = hasUnresolvedLeg(bet)
      ? UNKNOWN_NOTE
      : 'The second order could not be completed and the position could not be fully sold back; the bet is NOT fully in place.';
  }
}

export interface RecoverOptions {
  /** Look at only these bets (the periodic re-check hands over the ones that are due). Default: every bet. */
  bets?: BetRecord[];
  /** Look up only the orders whose result is not recorded, one by one by tag; never read the account's whole order list. */
  pendingOnly?: boolean;
}

/**
 * Fills in any order that was sent but whose result was never recorded
 * (for example, the process stopped mid-bet). Looks each one up by its tag.
 * An order recorded as an "error" or "unknown" is looked up too: an answer that was lost does not mean the order did not fill.
 * An order that cannot be looked up now is left as it is, and so is the rest of its bet.
 */
export async function recoverBets(deps: Deps, user?: string, opts: RecoverOptions = {}): Promise<number> {
  let fixed = 0;
  // The exchange's own list of orders, read once and only if some leg needs it: an "error" leg is not looked up one by one,
  // because asking for an order that is not there walks the whole order history.
  let venue: Map<string, OrderResult> | null | undefined;
  const venueOrder = async (tag: string): Promise<OrderResult | null> => {
    if (venue === undefined) {
      try {
        venue = new Map((await deps.exchange.allOrders()).filter((o) => o.clientOrderId).map((o) => [o.clientOrderId, o]));
      } catch {
        venue = null; // it cannot be asked now; the leg stays as it is and /reconcile will name any difference
      }
    }
    return venue?.get(tag) ?? null;
  };
  // A copy of the list: bets placed while this runs are in flight, not interrupted, and must not be touched.
  for (const bet of [...(opts.bets ?? deps.ledger.data.bets)]) {
    // Orders can only be looked up on the account that sent them.
    if (user !== undefined && bet.user !== user) continue;
    const pending = bet.legs.filter((l) => l.status === 'sent' || l.status === 'unknown');
    const doubtful = opts.pendingOnly ? [] : bet.legs.filter((l) => l.status === 'error' && l.quantityFilled <= 0);
    if (pending.length === 0 && doubtful.length === 0 && (opts.pendingOnly || bet.status !== 'placing')) continue;
    let repaired = false;
    let lookupFailed = false;
    for (const leg of pending) {
      let found: OrderResult | null;
      try {
        found = await deps.exchange.findOrder(leg.clientOrderId);
      } catch (err) {
        // The exchange cannot say now. The leg stays as it is, and so does the bet's status: it is looked at again later.
        console.error(`[executor] could not look up order ${leg.clientOrderId}: ${err instanceof Error ? err.message : String(err)}`);
        lookupFailed = true;
        break;
      }
      if (found) applyResult(leg, found, deps.feeCoef ?? 0);
      else {
        leg.status = 'unfilled';
        leg.note = 'Gemini has no order with this tag; it was never received.';
      }
      repaired = true;
      fixed++;
    }
    if (lookupFailed) {
      if (repaired) refreshTotals(bet);
      continue;
    }
    for (const leg of doubtful) {
      const found = await venueOrder(leg.clientOrderId);
      if (!found || found.filledQuantity <= 0) continue; // the exchange agrees nothing filled: it stays as it was
      applyResult(leg, found, deps.feeCoef ?? 0);
      leg.note = `${leg.note ?? 'No answer came back'}; the order was then found on the exchange by its tag.`;
      repaired = true;
      fixed++;
    }
    refreshTotals(bet);
    refreshCashOut(bet); // a sale that was interrupted: what it really sold is now known
    // A bet that was left "placing", or was marked failed or "check the account" for want of an answer, is read again from what it holds.
    if (bet.status === 'placing' || (repaired && (bet.status === 'failed' || bet.note === UNKNOWN_NOTE))) {
      const h = holdings(bet);
      const held = clean(Math.max(0, h.outcome.quantity) + Math.max(0, h.hedge.quantity));
      bet.status =
        held <= 1e-9 ? (bet.legs.some((l) => l.role === 'unwind' && l.quantityFilled > 0) ? 'unwound' : 'failed') : bet.payoffs?.hedged ? 'open' : 'unhedged';
      if (bet.status === 'unhedged') bet.note = 'Recovered after an interruption: the second order is incomplete.';
      else if (bet.note === UNKNOWN_NOTE) {
        bet.note =
          bet.status === 'failed'
            ? 'Gemini has no record of this bet\'s order, so nothing was bought.'
            : bet.status === 'unwound'
              ? 'The second order could not be completed within the price limit, so the position was sold back.'
              : undefined;
      }
    }
  }
  if (fixed > 0) deps.ledger.save();
  return fixed;
}

/** An order whose result is still not recorded is looked up again once it is this old (ms): a history trails an order by seconds, not by a minute. */
export const RECHECK_AFTER_MS = 60_000;
/** ...and one bet is looked at again no sooner than this (ms) after the last look. */
export const RECHECK_EVERY_MS = 300_000;

/**
 * The part of recovery that runs while the server is up: a bet with an order whose result is not recorded (the answer was
 * lost and the exchange could not say what became of it) is looked up again by tag, so it does not wait for a restart.
 * `checkedAt` is the caller's memory of when each bet was last looked at. An order sent less than a minute ago may still
 * be in flight and is left alone; a bet is looked at once every five minutes; only the orders named are read, never the
 * account's whole order list. Run it where no bet of this user is being placed (the API queues it with them).
 */
export async function recheckUnresolved(deps: Deps, user: string, checkedAt: Map<string, number>): Promise<number> {
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const due = deps.ledger.data.bets.filter((bet) => {
    if (bet.user !== user) return false;
    // `!(x < y)` rather than `x >= y`: a time that cannot be read counts as old, a bet never looked at as due.
    const old = bet.legs.some((l) => (l.status === 'sent' || l.status === 'unknown') && !(nowMs - Date.parse(l.sentAt) < RECHECK_AFTER_MS));
    return old && !(nowMs - (checkedAt.get(bet.id) ?? -Infinity) < RECHECK_EVERY_MS);
  });
  for (const bet of due) checkedAt.set(bet.id, nowMs);
  return due.length === 0 ? 0 : recoverBets(deps, user, { bets: due, pendingOnly: true });
}

/**
 * Puts right a bet an error left "placing" for good (a ledger write that failed once an order had gone out, say): nothing
 * else would ever move it, and a repeat of its request would be answered "placing" for ever. With no order sent it failed;
 * with one sent, what became of it is not known, so it is held like any bet with an unconfirmed order. The disk may be what
 * failed, so a failure to save here is not raised again: the next save that works writes it.
 */
export function holdInterrupted(deps: Deps, bets: BetRecord[]): void {
  for (const bet of bets) {
    if (bet.status !== 'placing') continue;
    if (bet.legs.length === 0) {
      bet.status = 'failed';
      bet.note = 'This bet could not be recorded, so no order was sent.';
    } else {
      refreshTotals(bet);
      bet.status = 'unhedged';
      bet.note = UNKNOWN_NOTE;
    }
  }
  try {
    deps.ledger.save();
  } catch (err) {
    console.error(`[executor] could not save the ledger after an interrupted bet: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  /** Bets sold back earlier whose market has now given a clean result: how the call turned out is recorded, nothing is paid. */
  called: BetRecord[];
  /** Events that could not be read this pass. Their bets were left exactly as they were and are tried again next time. */
  unreadable: string[];
}

/** True when a bet's result may be used for scoring: settled with a clean yes/no on both contracts. */
/** A bet whose call has a clean result: settled, or sold back and its market has since resolved (`called`). */
export const isScorable = (bet: BetRecord): boolean => (bet.status === 'settled' && bet.settlement !== undefined) || (bet.status === 'cashed_out' && bet.called !== undefined);

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
  const h = holdings(bet);
  return clean(Math.max(0, h.outcome.quantity) + Math.max(0, h.hedge.quantity));
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
 * What a bet paid, and how it resolved in the bet's own terms, once both of its contracts have a clean result.
 * `conditionReal` and `targetReal` are what Gemini reported for the bet's condition and target contracts.
 *
 *   parlay    the results are read in the bet's own view of the ladder (flipped for a falling bet), so "condition: no"
 *             always means the first half failed and the stake came back
 *   range     the condition is the lower strike and the target the higher; the bet is never refunded, and "target: yes"
 *             means the price finished inside the range
 *   breakout  the same two strikes; never refunded either, and "target: yes" means the price finished OUTSIDE them
 */
function resolveBet(bet: BetRecord, conditionReal: 'yes' | 'no', targetReal: 'yes' | 'no'): { conditionResolved: 'yes' | 'no'; targetResolved: 'yes' | 'no'; payout: number } {
  const h = holdings(bet);
  const outcome = { quantity: h.outcome.quantity, avgPrice: 0 };
  const hedgeLeg = { quantity: h.hedge.quantity, avgPrice: 0 };
  if (bet.product === 'range') {
    const inRange = conditionReal === 'yes' && targetReal === 'no';
    return {
      conditionResolved: 'yes',
      targetResolved: inRange ? 'yes' : 'no',
      payout: settlementPayout(outcome, hedgeLeg, targetReal, conditionReal),
    };
  }
  if (bet.product === 'breakout') {
    // The YES on the higher strike pays if that strike resolved yes; the NO on the lower strike pays if that one resolved no.
    const outside = conditionReal === 'no' || targetReal === 'yes';
    return {
      conditionResolved: 'yes',
      targetResolved: outside ? 'yes' : 'no',
      payout: settlementPayout(outcome, hedgeLeg, conditionReal, targetReal),
    };
  }
  const down = bet.direction === 'down';
  const a = down ? flipOutcome(conditionReal) : conditionReal;
  const b = down ? flipOutcome(targetReal) : targetReal;
  return { conditionResolved: a, targetResolved: b, payout: settlementPayout(outcome, hedgeLeg, a, b) };
}

/**
 * Where the ladder finished, from the reference price Gemini reports on a settled contract. Every contract of one ladder
 * settles against the same price, so the first that carries a usable number will do. Null when neither does.
 */
function finishPrice(...reported: (string | null | undefined)[]): number | null {
  for (const text of reported) {
    const n = text === null || text === undefined || text === '' ? NaN : Number(text);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
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
  const result: SettleResult = { settled: [], needsReview: [], called: [], unreadable: [] };
  try {
    await settlePass(deps, result);
  } finally {
    // Whatever was settled before anything went wrong is kept: the next pass would otherwise find the memory and the disk disagreeing.
    if (result.settled.length > 0 || result.needsReview.length > 0 || result.called.length > 0) deps.ledger.save();
  }
  return result;
}

async function settlePass(deps: Deps, result: SettleResult): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const events = new Map<string, Awaited<ReturnType<Exchange['getEvent']>>>();

  for (const bet of deps.ledger.data.bets) {
    const soldBack = bet.status === 'cashed_out' && !bet.called;
    if (!soldBack && bet.status !== 'open' && bet.status !== 'unhedged' && bet.status !== 'needs_review') continue;
    // What it paid cannot be worked out while an order's result is not known; recoverBets (or a person) settles that first.
    if (hasUnresolvedLeg(bet)) continue;
    // One event that cannot be read (retired, an error, a timeout) must not stop the bets on every other event.
    if (result.unreadable.includes(bet.eventTicker)) continue;
    if (!events.has(bet.eventTicker)) {
      try {
        events.set(bet.eventTicker, await deps.exchange.getEvent(bet.eventTicker));
      } catch (err) {
        result.unreadable.push(bet.eventTicker);
        console.error(`[executor] settle: could not read event ${bet.eventTicker}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }
    const event = events.get(bet.eventTicker)!;
    const aContract = event.contracts.find((c) => c.instrumentSymbol === bet.condition.symbol);
    const bContract = event.contracts.find((c) => c.instrumentSymbol === bet.target.symbol);
    const aSide = aContract?.resolutionSide;
    const bSide = bContract?.resolutionSide;

    if (soldBack) {
      // Nothing is held, so nothing is paid and the bet stays "cashed_out". Only how the call turned out is written
      // down, and only from a clean result: an unclear one leaves the call unscored, as it would for a bet still held.
      if (isClean(aSide) && isClean(bSide)) {
        const resolved = resolveBet(bet, aSide, bSide);
        const finishedAt = finishPrice(aContract?.settlementValue, bContract?.settlementValue);
        bet.called = { conditionResolved: resolved.conditionResolved, targetResolved: resolved.targetResolved, at: now().toISOString(), ...(finishedAt !== null ? { finishedAt } : {}) };
        result.called.push(bet);
      }
      continue;
    }

    if (isClean(aSide) && isClean(bSide)) {
      const resolved = resolveBet(bet, aSide, bSide);
      const finishedAt = finishPrice(aContract?.settlementValue, bContract?.settlementValue);
      bet.settlement = {
        conditionResolved: resolved.conditionResolved,
        targetResolved: resolved.targetResolved,
        payout: resolved.payout,
        pnl: clean(resolved.payout - bet.cost),
        settledAt: now().toISOString(),
        ...(finishedAt !== null ? { finishedAt } : {}),
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
      isClean(aSide) ? null : `${bet.product === 'range' || bet.product === 'breakout' ? 'lower strike' : 'condition'} reported "${aSide ?? 'nothing'}"`,
      isClean(bSide) ? null : `${bet.product === 'range' || bet.product === 'breakout' ? 'higher strike' : 'outcome'} reported "${bSide ?? 'nothing'}"`,
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
}
