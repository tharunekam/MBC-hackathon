/**
 * Placing a range bet: win if a price finishes between two levels.
 *
 *   1. Buy YES on the lower strike. Only what actually fills is matched.
 *   2. Buy NO on the higher strike, the same number of contracts as filled in step 1. Retried a few times.
 *   3. If the two legs cannot be matched within the price cap, the position is sold back.
 *
 * What the bet is, how it is priced and why it is a bet on the range: see range.ts and `rangeUnitCost` in pricing.ts.
 */
import { betIdFor } from './bet-id.ts';
import { BetRefused, MAX_HEDGE_ATTEMPTS, defaultId, holdings, netHolding, refreshTotals, sendLeg, unwind, withinLimit } from './bets.ts';
import type { Deps } from './bets.ts';
import type { BetRecord } from './ledger.ts';
import type { GeminiEvent } from './gemini/types.ts';
import { toRung } from './pairs.ts';
import { PRICE_TICK, clean, feeRate, rangePrice } from './pricing.ts';
import { capRangeToDepth, findRange, planRange, rangeContractsFor } from './range.ts';
import type { RangePair } from './range.ts';

export interface RangeRequest {
  user: string;
  eventTicker: string;
  /** Instrument symbol of the lower strike (the YES leg). */
  lowSymbol: string;
  /** Instrument symbol of the higher strike (the NO leg). */
  highSymbol: string;
  /** Dollars to spend on the two orders together, fees included. */
  stake: number;
  /** Highest acceptable price per $1 of "inside the range" payout. Defaults to the live quote plus 5 cents. */
  maxPrice?: number;
  /** How far past the best price each order may reach, in cents. Default 2. */
  slippageTicks?: number;
  /** What to do if the two legs cannot be matched. Default: sell the position back. */
  onFail?: 'unwind' | 'leave';
  /** Set when the bet is one leg of a basket. */
  basket?: NonNullable<BetRecord['basket']>;
}

/** Everything read and decided before a range bet's first order. Nothing here sends an order. */
export interface RangeBetPlan {
  event: GeminiEvent;
  pair: RangePair;
  price: number;
  maxPrice: number;
  quantity: number;
  slip: number;
  stakeReduced?: BetRecord['stakeReduced'];
}

/**
 * Reads the market and applies every check a range bet must pass: the two strikes are a real range, both contracts are open,
 * the offer rule accepts the price, the price is within the limit, and enough rests on the book on BOTH legs. Throws
 * `BetRefused` (before anything is bought) when it does not.
 */
export async function planRangeBet(deps: Deps, req: RangeRequest): Promise<RangeBetPlan> {
  const slip = (req.slippageTicks ?? 2) * PRICE_TICK;
  if (!(req.stake > 0)) throw new Error('Stake must be a positive dollar amount.');
  if (req.maxPrice !== undefined && !(req.maxPrice > 0 && req.maxPrice < 1)) throw new Error('maxPrice must be between 0 and 1.');

  const feeCoef = deps.feeCoef ?? 0;
  // First read: confirms the two strikes really are a range of this event.
  const first = await deps.exchange.getEvent(req.eventTicker);
  const named = findRange(first, req.lowSymbol, req.highSymbol, feeCoef, deps.waiveMarkup);

  // Immediately before trading: the resting size on both legs and a fresh read of prices and market state.
  const [depthLow, depthHigh, event] = await Promise.all([
    deps.exchange.topOfBook(named.low.symbol),
    deps.exchange.topOfBook(named.high.symbol),
    deps.exchange.getEvent(req.eventTicker),
  ]).catch((err: unknown) => {
    throw new BetRefused('no_depth', `Could not read the live order book, so no order was sent (${err instanceof Error ? err.message : String(err)}).`);
  });
  const pair = findRange(event, req.lowSymbol, req.highSymbol, feeCoef, deps.waiveMarkup);

  if (!pair.low.open || !pair.high.open) {
    const closed = [pair.low, pair.high].filter((r) => !r.open).map((r) => `"${r.label}" is ${r.state}`);
    throw new BetRefused('market_closed', `${event.ticker} is not open for trading right now: ${closed.join(', ')}. No order was sent.`, pair.offer);
  }
  if (!pair.offer.offerable) {
    throw new BetRefused('offer_refused', `This bet is not offered: ${pair.offer.reasons.map((r) => r.message).join(' ')} No order was sent.`, pair.offer);
  }
  const price = pair.price;
  if (price === null || pair.low.ask === null || pair.high.bid === null) {
    throw new BetRefused('offer_refused', 'No range price is available: the books are empty or the range costs more than it can win.', pair.offer);
  }
  const maxPrice = req.maxPrice ?? Math.min(0.99, clean(price + 0.05));
  if (price > maxPrice) {
    throw new BetRefused('price_above_limit', `The live price is ${price.toFixed(3)} per $1, above your limit of ${maxPrice.toFixed(3)}.`, pair.offer);
  }

  const wanted = rangeContractsFor(req.stake, pair.low.ask, pair.high.bid, feeCoef);
  if (wanted < 0.01) throw new BetRefused('stake_too_small', `A $${req.stake} stake is too small at these prices.`, pair.offer);

  // Depth guard: an immediate-or-cancel order only fills what rests at the best price, so size the bet to what is really
  // there on BOTH legs. Size only counts if it sits at the quoted price or better.
  const lowAvailable = depthLow.ask !== null && depthLow.ask <= pair.low.ask + 1e-9 ? (depthLow.askSize ?? 0) : 0;
  const highAvailable = depthHigh.bid !== null && depthHigh.bid >= pair.high.bid - 1e-9 ? (depthHigh.bidSize ?? 0) : 0;
  const quantity = capRangeToDepth(wanted, lowAvailable, highAvailable);
  if (quantity < 0.01) {
    throw new BetRefused(
      'insufficient_depth',
      `Not enough is on offer at the quoted price right now (${lowAvailable} contracts on "${pair.low.label}", ${highAvailable} on "${pair.high.label}"). ` +
        'No order was sent; try again in a moment.',
      pair.offer,
    );
  }
  let stakeReduced: BetRecord['stakeReduced'];
  if (quantity < wanted - 1e-9) {
    const reducedTo = Math.round(planRange(quantity, pair.low.ask, pair.high.bid, feeCoef).cost * 100) / 100;
    stakeReduced = {
      requested: req.stake,
      reducedTo,
      outcomeAvailable: lowAvailable,
      conditionAvailable: highAvailable,
      reason:
        `Only ${lowAvailable} contracts were on offer on "${pair.low.label}" and ${highAvailable} on "${pair.high.label}" ` +
        `at the best price, so the bet was reduced from $${req.stake.toFixed(2)} to about $${reducedTo.toFixed(2)}.`,
    };
  }
  return { event, pair, price, maxPrice, quantity, slip, ...(stakeReduced ? { stakeReduced } : {}) };
}

/** Always returns a ledger record; it never leaves an unrecorded order behind. */
export async function placeRangeBet(deps: Deps, req: RangeRequest): Promise<BetRecord> {
  const now = deps.now ?? (() => new Date());
  const feeCoef = deps.feeCoef ?? 0;
  const { event, pair, price, maxPrice, quantity, slip, stakeReduced } = await planRangeBet(deps, req);

  const id = betIdFor('range', undefined, (deps.newId ?? defaultId)());
  const bet: BetRecord = {
    id,
    user: req.user,
    createdAt: now().toISOString(),
    eventTicker: event.ticker,
    eventTitle: event.title,
    expiry: event.expiryDate ?? null,
    product: 'range',
    ...(req.basket ? { basket: req.basket } : {}),
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

  // Leg 1: YES on the lower strike. Never pay so much that the bet could exceed maxPrice even with a perfect second leg.
  const askLow = pair.low.ask!;
  const bidHigh = pair.high.bid!;
  let limit = Math.min(clean(askLow + slip), 0.99);
  while (limit > askLow + 1e-9 && !withinLimit(rangePrice(limit, bidHigh, feeCoef), maxPrice)) limit = clean(limit - PRICE_TICK);
  const first = await sendLeg(deps, bet, 'outcome', {
    symbol: pair.low.symbol,
    side: 'buy',
    outcome: 'yes',
    limitPrice: limit,
    quantity,
    tif: 'IOC',
    clientOrderId: `gv-${id}-b`,
  });
  if (first.status === 'error' || first.quantityFilled <= 0) {
    bet.status = 'failed';
    bet.note = first.status === 'error' ? `First order failed: ${first.note}` : 'Nothing was available at the quoted price, so no bet was placed.';
    refreshTotals(bet);
    deps.ledger.save();
    return bet;
  }

  // Leg 2: NO on the higher strike, the same size as what filled.
  await matchSecondLeg(deps, bet, maxPrice, slip);
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

/** Buys NO on the higher strike until it matches the YES held on the lower one, within the price cap. */
async function matchSecondLeg(deps: Deps, bet: BetRecord, maxPrice: number, slip: number): Promise<void> {
  const feeCoef = deps.feeCoef ?? 0;
  for (let attempt = 1; attempt <= MAX_HEDGE_ATTEMPTS; attempt++) {
    const yes = holdings(bet).outcome;
    const no = netHolding(bet, bet.target.symbol, 'no');
    const need = clean(yes.quantity - no.quantity);
    if (yes.quantity <= 0 || need <= 0) return;

    // Fresh book for the higher strike each attempt.
    const event = await deps.exchange.getEvent(bet.eventTicker);
    const contract = event.contracts.find((c) => c.instrumentSymbol === bet.target.symbol);
    const rung = contract ? toRung(contract) : null;
    if (!rung || !rung.open || rung.bid === null) return;

    const noAsk = clean(1 - rung.bid);
    const yesAvg = yes.spent / yes.quantity; // what the first leg really cost per contract, fee included
    // Highest NO price, from the best offer upward, that keeps the whole bet at or under maxPrice.
    const priceAt = (noPrice: number) => {
      const price = clean(yesAvg + noPrice + feeRate(noPrice, feeCoef) - 1);
      return price > 0 && price < 1 ? price : null;
    };
    let limit = Math.min(clean(noAsk + slip), 0.99);
    while (limit > noAsk + 1e-9 && !withinLimit(priceAt(limit), maxPrice)) limit = clean(limit - PRICE_TICK);
    if (limit < noAsk - 1e-9 || !withinLimit(priceAt(limit), maxPrice)) return; // matching now would break the price limit

    const leg = await sendLeg(deps, bet, 'hedge', {
      symbol: bet.target.symbol,
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
