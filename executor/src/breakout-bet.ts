/**
 * Placing a breakout bet: win if a price finishes outside two levels, either way.
 *
 *   1. Buy YES on the higher strike. Only what actually fills is matched.
 *   2. Buy NO on the lower strike, the same number of contracts as filled in step 1. Retried a few times.
 *   3. If the two legs cannot be matched within the price cap, the position is sold back.
 *
 * What the bet is, how it is priced and why it is a bet on a move: see breakout.ts and `breakoutUnitCost` in pricing.ts.
 * The steps are the range's (range-bet.ts) on the other two sides of the same two books.
 */
import { betIdFor } from './bet-id.ts';
import { BetRefused, MAX_HEDGE_ATTEMPTS, defaultId, holdForCheck, holdings, logUnreadableBook, netHolding, refreshTotals, sendLeg, unwind, withinLimit } from './bets.ts';
import type { Deps } from './bets.ts';
import { capBreakoutToDepth, findBreakout, planBreakout, breakoutContractsFor } from './breakout.ts';
import type { BreakoutPair } from './breakout.ts';
import type { BetRecord } from './ledger.ts';
import type { GeminiEvent } from './gemini/types.ts';
import { toRung } from './pairs.ts';
import { PRICE_TICK, breakoutPrice, clean, feeRate } from './pricing.ts';

export interface BreakoutRequest {
  user: string;
  eventTicker: string;
  /** Instrument symbol of the lower strike (the NO leg). */
  lowSymbol: string;
  /** Instrument symbol of the higher strike (the YES leg). */
  highSymbol: string;
  /** Dollars to spend on the two orders together, fees included. */
  stake: number;
  /** Highest acceptable price per $1 of "outside" payout. Defaults to the live quote plus 5 cents. */
  maxPrice?: number;
  /** How far past the best price each order may reach, in cents. Default 2. */
  slippageTicks?: number;
  /** What to do if the two legs cannot be matched. Default: sell the position back. */
  onFail?: 'unwind' | 'leave';
  /** Set when the bet is one leg of a basket. */
  basket?: NonNullable<BetRecord['basket']>;
  /** The request id the app sent; stored on the bet so a repeat of the request can be answered with it. */
  clientRequestId?: string;
  /** A short fingerprint of what the person chose, kept with the bet so a request id reused for something else can be told from a repeat. */
  requestKey?: string;
}

/** Everything read and decided before a breakout's first order. Nothing here sends an order. */
export interface BreakoutBetPlan {
  event: GeminiEvent;
  pair: BreakoutPair;
  price: number;
  maxPrice: number;
  quantity: number;
  slip: number;
  stakeReduced?: BetRecord['stakeReduced'];
}

/**
 * Reads the market and applies every check a breakout must pass: the two strikes are a lower and a higher one of this
 * event, both contracts are open, the offer rule accepts the price, the price is within the limit, and enough rests on the
 * book on BOTH legs. Throws `BetRefused` (before anything is bought) when it does not.
 */
export async function planBreakoutBet(deps: Deps, req: BreakoutRequest): Promise<BreakoutBetPlan> {
  const slip = (req.slippageTicks ?? 2) * PRICE_TICK;
  if (!(req.stake > 0)) throw new Error('Stake must be a positive dollar amount.');
  if (req.maxPrice !== undefined && !(req.maxPrice > 0 && req.maxPrice < 1)) throw new Error('maxPrice must be between 0 and 1.');

  const feeCoef = deps.feeCoef ?? 0;
  // First read: confirms the two strikes really are a lower and a higher strike of this event.
  const first = await deps.exchange.getEvent(req.eventTicker);
  const named = findBreakout(first, req.lowSymbol, req.highSymbol, feeCoef, deps.waiveMarkup);

  // Immediately before trading: the resting size on both legs and a fresh read of prices and market state.
  const [depthLow, depthHigh, event] = await Promise.all([
    deps.exchange.topOfBook(named.low.symbol),
    deps.exchange.topOfBook(named.high.symbol),
    deps.exchange.getEvent(req.eventTicker),
  ]).catch((err: unknown) => {
    logUnreadableBook(err);
    throw new BetRefused('no_depth', 'Could not read the live order book, so no order was sent.');
  });
  const pair = findBreakout(event, req.lowSymbol, req.highSymbol, feeCoef, deps.waiveMarkup);

  if (!pair.low.open || !pair.high.open) {
    const closed = [pair.low, pair.high].filter((r) => !r.open).map((r) => `"${r.label}" is ${r.state}`);
    throw new BetRefused('market_closed', `${event.ticker} is not open for trading right now: ${closed.join(', ')}. No order was sent.`, pair.offer);
  }
  if (!pair.offer.offerable) {
    throw new BetRefused('offer_refused', `This bet is not offered: ${pair.offer.reasons.map((r) => r.message).join(' ')} No order was sent.`, pair.offer);
  }
  const price = pair.price;
  if (price === null || pair.low.bid === null || pair.high.ask === null) {
    throw new BetRefused('offer_refused', 'No breakout price is available: the books are empty or the pair costs more than it can win.', pair.offer);
  }
  const maxPrice = req.maxPrice ?? Math.min(0.99, clean(price + 0.05));
  if (price > maxPrice) {
    throw new BetRefused('price_above_limit', `The live price is ${price.toFixed(3)} per $1, above your limit of ${maxPrice.toFixed(3)}.`, pair.offer);
  }

  const wanted = breakoutContractsFor(req.stake, pair.low.bid, pair.high.ask, feeCoef);
  if (wanted < 0.01) throw new BetRefused('stake_too_small', `A $${req.stake} stake is too small at these prices.`, pair.offer);

  // Depth guard: an immediate-or-cancel order only fills what rests at the best price, so size the bet to what is really
  // there on BOTH legs. Size only counts if it sits at the quoted price or better. The YES on the higher strike buys from
  // that book's offers; the NO on the lower strike buys from that book's YES bids.
  const highAvailable = depthHigh.ask !== null && depthHigh.ask <= pair.high.ask + 1e-9 ? (depthHigh.askSize ?? 0) : 0;
  const lowAvailable = depthLow.bid !== null && depthLow.bid >= pair.low.bid - 1e-9 ? (depthLow.bidSize ?? 0) : 0;
  const quantity = capBreakoutToDepth(wanted, highAvailable, lowAvailable);
  if (quantity < 0.01) {
    throw new BetRefused(
      'insufficient_depth',
      `Not enough is on offer at the quoted price right now (${highAvailable} contracts on "${pair.high.label}", ${lowAvailable} on "${pair.low.label}"). ` +
        'No order was sent; try again in a moment.',
      pair.offer,
    );
  }
  let stakeReduced: BetRecord['stakeReduced'];
  if (quantity < wanted - 1e-9) {
    const reducedTo = Math.round(planBreakout(quantity, pair.low.bid, pair.high.ask, feeCoef).cost * 100) / 100;
    stakeReduced = {
      requested: req.stake,
      reducedTo,
      outcomeAvailable: highAvailable,
      conditionAvailable: lowAvailable,
      reason:
        `Only ${highAvailable} contracts were on offer on "${pair.high.label}" and ${lowAvailable} on "${pair.low.label}" ` +
        `at the best price, so the bet was reduced from $${req.stake.toFixed(2)} to about $${reducedTo.toFixed(2)}.`,
    };
  }
  return { event, pair, price, maxPrice, quantity, slip, ...(stakeReduced ? { stakeReduced } : {}) };
}

/** Always returns a ledger record; it never leaves an unrecorded order behind. */
export async function placeBreakoutBet(deps: Deps, req: BreakoutRequest): Promise<BetRecord> {
  const now = deps.now ?? (() => new Date());
  const feeCoef = deps.feeCoef ?? 0;
  const { event, pair, price, maxPrice, quantity, slip, stakeReduced } = await planBreakoutBet(deps, req);

  const id = betIdFor('breakout', undefined, (deps.newId ?? defaultId)());
  const bet: BetRecord = {
    id,
    user: req.user,
    createdAt: now().toISOString(),
    eventTicker: event.ticker,
    eventTitle: event.title,
    expiry: event.expiryDate ?? null,
    product: 'breakout',
    ...(req.basket ? { basket: req.basket } : {}),
    ...(req.clientRequestId ? { clientRequestId: req.clientRequestId } : {}),
    ...(req.requestKey ? { requestKey: req.requestKey } : {}),
    condition: { symbol: pair.low.symbol, label: pair.low.label, strike: pair.low.strike },
    target: { symbol: pair.high.symbol, label: pair.high.label, strike: pair.high.strike },
    requestedStake: req.stake,
    quotedPrice: price,
    status: 'placing',
    legs: [],
    cost: 0,
    offer: pair.offer,
    ...(stakeReduced ? { stakeReduced } : {}),
  };
  deps.ledger.data.bets.push(bet);
  deps.ledger.save();

  // Leg 1: YES on the higher strike. Never pay so much that the bet could exceed maxPrice even with a perfect second leg.
  const bidLow = pair.low.bid!;
  const askHigh = pair.high.ask!;
  let limit = Math.min(clean(askHigh + slip), 0.99);
  while (limit > askHigh + 1e-9 && !withinLimit(breakoutPrice(bidLow, limit, feeCoef), maxPrice)) limit = clean(limit - PRICE_TICK);
  const first = await sendLeg(deps, bet, 'outcome', {
    symbol: pair.high.symbol,
    side: 'buy',
    outcome: 'yes',
    limitPrice: limit,
    quantity,
    tif: 'IOC',
    clientOrderId: `gv-${id}-b`,
  });
  if (first.status === 'unknown') return holdForCheck(deps, bet);
  if (first.status === 'error' || first.quantityFilled <= 0) {
    bet.status = 'failed';
    bet.note = first.status === 'error' ? `First order failed: ${first.note}` : 'Nothing was available at the quoted price, so no bet was placed.';
    refreshTotals(bet);
    deps.ledger.save();
    return bet;
  }

  // Leg 2: NO on the lower strike, the same size as what filled.
  await matchSecondLeg(deps, bet, maxPrice, slip);
  if (bet.legs.some((l) => l.status === 'unknown')) return holdForCheck(deps, bet); // never unwind or re-send around an order that may have filled
  refreshTotals(bet);

  if (bet.payoffs?.hedged) {
    bet.status = 'open';
  } else if ((req.onFail ?? 'unwind') === 'unwind') {
    await unwind(deps, bet, slip);
  } else {
    bet.status = 'unhedged';
    bet.note = 'The second order could not be completed within the price limit; the two legs are not matched.';
  }
  refreshTotals(bet);
  deps.ledger.save();
  return bet;
}

/** Buys NO on the lower strike until it matches the YES held on the higher one, within the price cap. */
async function matchSecondLeg(deps: Deps, bet: BetRecord, maxPrice: number, slip: number): Promise<void> {
  const feeCoef = deps.feeCoef ?? 0;
  for (let attempt = 1; attempt <= MAX_HEDGE_ATTEMPTS; attempt++) {
    const yes = holdings(bet).outcome;
    const no = netHolding(bet, bet.condition.symbol, 'no');
    const need = clean(yes.quantity - no.quantity);
    if (yes.quantity <= 0 || need <= 0) return;

    // Fresh book for the lower strike each attempt.
    const event = await deps.exchange.getEvent(bet.eventTicker);
    const contract = event.contracts.find((c) => c.instrumentSymbol === bet.condition.symbol);
    const rung = contract ? toRung(contract) : null;
    if (!rung || !rung.open || rung.bid === null) return;

    const noAsk = clean(1 - rung.bid);
    const yesAvg = yes.spent / yes.quantity; // what the first leg really cost per contract, fee included
    // Highest NO price, from the best offer upward, that keeps the whole bet at or under maxPrice.
    const priceAt = (noPrice: number) => {
      const price = clean(yesAvg + noPrice + feeRate(noPrice, feeCoef));
      return price > 0 && price < 1 ? price : null;
    };
    let limit = Math.min(clean(noAsk + slip), 0.99);
    while (limit > noAsk + 1e-9 && !withinLimit(priceAt(limit), maxPrice)) limit = clean(limit - PRICE_TICK);
    if (limit < noAsk - 1e-9 || !withinLimit(priceAt(limit), maxPrice)) return; // matching now would break the price limit

    const leg = await sendLeg(deps, bet, 'hedge', {
      symbol: bet.condition.symbol,
      side: 'buy',
      outcome: 'no',
      limitPrice: limit,
      quantity: need,
      tif: 'IOC',
      clientOrderId: `gv-${bet.id}-a${attempt}`,
    });
    if (leg.status === 'filled' || leg.status === 'unknown') return;
  }
}
