/**
 * Cash out: sell an open bet back before its event finishes.
 *
 * Every quote already says what a bet would fetch if it were sold at once. This is the order path behind that number: two
 * sell orders, one per leg, on the same contracts the bet was bought on. Nothing here is special to Gemini; a bet is two
 * ordinary positions, so leaving it is two ordinary sells.
 *
 *   1. Read both books live and price the sale at the best bid of each leg, fees included.
 *   2. Refuse, before any order, when the sale cannot be done whole: a market that is not taking orders, no bid, less
 *      resting at the best price than the bet holds, or a position Gemini has already netted against another bet.
 *   3. Sell the outcome leg first, then the hedge. If the first sells and the second does not, what is left is the leg
 *      that pays the stake back when the condition fails, which is the safer half to be left holding.
 *
 * The same numbers serve `GET /cashout` (the quote) and `POST /cashout` (the sale), so a page can never show a figure
 * the sale was not checked against.
 */
import type { Deps } from './bets.ts';
import { holdings, legMap, refreshTotals, sendLeg } from './bets.ts';
import type { BetRecord, LegRecord, Ledger } from './ledger.ts';
import { viewFor } from './mirror.ts';
import { PRODUCTION_TAKER_FEE_COEF } from './offer.ts';
import { toRung } from './pairs.ts';
import { PRICE_TICK, clean, takerFee } from './pricing.ts';

export type CashOutCode =
  /** The bet is not one that can be sold: it is settled, failed, already cashed out, or holds nothing. */
  | 'not_open'
  /** One of the bet's markets is not taking orders right now (closed, finished, or post-only). */
  | 'market_closed'
  /** Nobody is bidding for one of the legs, or the live book could not be read. */
  | 'no_bid'
  /** Less rests at the best price than the bet holds, so the sale could not be done whole. */
  | 'insufficient_depth'
  /** Another open bet holds the other side of one of these contracts, so Gemini has already netted the position. */
  | 'position_netted'
  /** The sale would bring in less than the floor the caller set. */
  | 'below_minimum'
  /** The first sell order filled nothing, so the bet is unchanged. */
  | 'nothing_sold';

export interface CashOutLegQuote {
  role: 'outcome' | 'hedge';
  symbol: string;
  /** The side really held on Gemini. */
  outcome: 'yes' | 'no';
  /** Contracts the bet holds on this leg. */
  quantity: number;
  /** Best price a seller gets per contract right now, in the leg's own terms. Null when nobody is bidding. */
  price: number | null;
  /** Contracts wanted at that price. Null when the book could not be read. */
  available: number | null;
}

export interface CashOutQuote {
  betId: string;
  asOf: string;
  /** True when the whole bet can be sold now at the prices below. */
  available: boolean;
  code: CashOutCode | null;
  /** Why not, in a sentence. Null when available. */
  reason: string | null;
  /** Net dollars in the bet now: what was paid, less anything already sold back. */
  stake: number;
  /** What selling both legs now brings in, after the fees this venue charges. Null when a leg has no bid. */
  proceeds: number | null;
  /** proceeds minus stake: what cashing out now makes or loses. */
  pnl: number | null;
  /** The same sale at Gemini's published taker rate (the sandbox charges nothing). */
  proceedsAtProductionFees: number | null;
  legs: CashOutLegQuote[];
}

/** A cash-out turned down. Before any order unless the code is `nothing_sold`. */
export class CashOutRefused extends Error {
  readonly code: CashOutCode;
  readonly quote?: CashOutQuote;
  constructor(code: CashOutCode, message: string, quote?: CashOutQuote) {
    super(message);
    this.name = 'CashOutRefused';
    this.code = code;
    this.quote = quote;
  }
}

const isLive = (bet: BetRecord): boolean => bet.status === 'open' || bet.status === 'unhedged';

/**
 * Contracts of this bet that Gemini may have netted away. Gemini keeps one position per contract per account and pays $1
 * at once for each YES + NO pair, so when ANOTHER unsettled bet holds the other side of a contract this bet holds, the
 * account no longer has this bet's contracts to sell. Returns the symbols where that is so.
 */
export function nettedAgainst(ledger: Ledger, bet: BetRecord): string[] {
  const m = legMap(bet);
  const mine = [m.outcome, m.hedge];
  const out: string[] = [];
  for (const leg of mine) {
    const other = leg.side === 'yes' ? 'no' : 'yes';
    let opposite = 0;
    for (const b of ledger.data.bets) {
      if (b === bet || b.user !== bet.user || b.settlement || b.review?.resolved) continue;
      for (const l of b.legs) {
        if (l.symbol !== leg.symbol || l.outcome !== other || l.quantityFilled <= 0) continue;
        opposite += (l.side === 'buy' ? 1 : -1) * l.quantityFilled;
      }
    }
    if (clean(opposite) > 0) out.push(leg.symbol);
  }
  return out;
}

/**
 * Prices the sale of a bet's two legs against the live books. Sends nothing.
 *
 * In the bet's own view of the ladder (the mirror for a falling bet) the outcome leg is a YES, sold at the bid, and the
 * hedge leg a NO, sold at 1 minus the ask; the sizes are the ones resting at those prices.
 */
export async function quoteCashOut(deps: Deps, bet: BetRecord): Promise<CashOutQuote> {
  const now = deps.now ?? (() => new Date());
  const feeCoef = deps.feeCoef ?? 0;
  const m = legMap(bet);
  const h = holdings(bet);
  const legs: CashOutLegQuote[] = [
    { role: 'outcome', symbol: m.outcome.symbol, outcome: m.outcome.side, quantity: Math.max(0, h.outcome.quantity), price: null, available: null },
    { role: 'hedge', symbol: m.hedge.symbol, outcome: m.hedge.side, quantity: Math.max(0, h.hedge.quantity), price: null, available: null },
  ];
  const quote: CashOutQuote = {
    betId: bet.id,
    asOf: now().toISOString(),
    available: false,
    code: null,
    reason: null,
    stake: clean(bet.cost),
    proceeds: null,
    pnl: null,
    proceedsAtProductionFees: null,
    legs,
  };
  const no = (code: CashOutCode, reason: string): CashOutQuote => ({ ...quote, code, reason });

  if (bet.status === 'cashed_out') return no('not_open', 'This bet has already been cashed out.');
  if (!isLive(bet)) return no('not_open', `This bet is "${bet.status}", so there is nothing to sell.`);
  const held = legs.filter((l) => l.quantity > 0);
  if (held.length === 0) return no('not_open', 'This bet holds no contracts, so there is nothing to sell.');

  const netted = nettedAgainst(deps.ledger, bet);
  if (netted.length > 0) {
    return no(
      'position_netted',
      'Another open bet of yours holds the other side of one of these contracts. Gemini has already paid out that overlap, ' +
        'so this bet cannot be sold on its own. It will settle as normal.',
    );
  }

  const view = viewFor(deps.exchange, bet.direction);
  const event = await view.getEvent(bet.eventTicker);
  const closed: string[] = [];
  for (const leg of held) {
    const contract = event.contracts.find((c) => c.instrumentSymbol === leg.symbol);
    const rung = contract ? toRung(contract) : null;
    if (!rung || !rung.open) closed.push(rung ? `"${rung.label}" is ${rung.state}` : `${leg.symbol} is not listed`);
  }
  if (closed.length > 0) {
    return no('market_closed', `This market is not taking orders right now (${closed.join(', ')}). If it has finished, the bet settles by itself.`);
  }

  try {
    const [outcomeBook, hedgeBook] = await Promise.all([view.topOfBook(m.outcome.symbol), view.topOfBook(m.hedge.symbol)]);
    legs[0].price = outcomeBook.bid;
    legs[0].available = outcomeBook.bid === null ? 0 : (outcomeBook.bidSize ?? 0);
    // The NO bid is 1 minus the YES ask, and what rests at that ask is what a NO seller can hit.
    legs[1].price = hedgeBook.ask === null ? null : clean(1 - hedgeBook.ask);
    legs[1].available = hedgeBook.ask === null ? 0 : (hedgeBook.askSize ?? 0);
  } catch (err) {
    return no('no_bid', `Could not read the live order book, so nothing was priced (${err instanceof Error ? err.message : String(err)}).`);
  }

  if (held.some((l) => l.price === null || !(l.price > 0))) {
    return no('no_bid', 'Nobody is bidding for one of this bet\'s contracts right now, so it cannot be sold. Try again in a moment.');
  }
  const total = (coef: number) => clean(held.reduce((sum, l) => sum + l.quantity * l.price! - takerFee(l.quantity, l.price!, coef), 0));
  quote.proceeds = Math.round(total(feeCoef) * 100) / 100;
  quote.pnl = clean(quote.proceeds - quote.stake);
  quote.proceedsAtProductionFees = Math.round(total(PRODUCTION_TAKER_FEE_COEF) * 100) / 100;

  const thin = held.filter((l) => (l.available ?? 0) + 1e-9 < l.quantity);
  if (thin.length > 0) {
    return no(
      'insufficient_depth',
      `Not enough is wanted at the best price right now to sell the whole bet (${thin.map((l) => `${l.available} of ${l.quantity} contracts`).join(', ')}). Try again in a moment.`,
    );
  }
  quote.available = true;
  return quote;
}

export interface CashOutRequest {
  /** Refuse unless the sale is quoted to bring in at least this many dollars. */
  minProceeds?: number;
  /** How far below the best price each sell may reach, in cents. Default 1, or 0 when `minProceeds` is set. */
  slippageTicks?: number;
}

const sold = (leg: LegRecord): number => (leg.quantityFilled > 0 && leg.avgPrice !== null ? leg.quantityFilled * leg.avgPrice - (leg.fee ?? 0) : 0);

/**
 * Sells a bet back as two real orders. Always leaves the ledger saying exactly what was sold.
 *
 *   everything sold      -> "cashed_out", with what it brought in and what that made or lost
 *   part sold            -> the bet stays live with what it still holds, flagged, and can be cashed out again
 *   first order unfilled -> CashOutRefused("nothing_sold"); the bet is as it was
 */
export async function cashOutBet(deps: Deps, bet: BetRecord, req: CashOutRequest = {}): Promise<BetRecord> {
  const now = deps.now ?? (() => new Date());
  const quote = await quoteCashOut(deps, bet);
  if (!quote.available) throw new CashOutRefused(quote.code ?? 'not_open', quote.reason ?? 'This bet cannot be cashed out right now.', quote);
  if (req.minProceeds !== undefined && quote.proceeds !== null && quote.proceeds < req.minProceeds - 0.005) {
    throw new CashOutRefused(
      'below_minimum',
      `Selling now would bring in $${quote.proceeds.toFixed(2)}, below the $${req.minProceeds.toFixed(2)} you asked for. Nothing was sold.`,
      quote,
    );
  }

  // With a floor, each order sells at the price just quoted or better and never below it, so what the sale brings in
  // cannot fall under the figure the floor was checked against. Without one, an order may reach a cent further.
  const slip = (req.slippageTicks ?? (req.minProceeds !== undefined ? 0 : 1)) * PRICE_TICK;
  const stakeBefore = bet.cashOut?.stake ?? clean(bet.cost);
  // Each attempt gets its own tags: an order tag can never be reused on Gemini. Numbering from every cash-out order sent
  // so far (not from the attempts) keeps them distinct even when an attempt sent only one of its two orders.
  const attempt = bet.legs.filter((l) => l.role === 'cashout').length + 1;
  const sentNow: LegRecord[] = [];

  const [outcomeLeg, hedgeLeg] = quote.legs;
  if (outcomeLeg.quantity > 0) {
    const leg = await sendLeg(deps, bet, 'cashout', {
      symbol: outcomeLeg.symbol,
      side: 'sell',
      outcome: outcomeLeg.outcome,
      limitPrice: Math.max(PRICE_TICK, clean(outcomeLeg.price! - slip)),
      quantity: outcomeLeg.quantity,
      tif: 'IOC',
      clientOrderId: `gv-${bet.id}-cb${attempt}`,
    });
    sentNow.push(leg);
    if (leg.status === 'error' || leg.quantityFilled <= 0) {
      refreshTotals(bet);
      deps.ledger.save();
      throw new CashOutRefused(
        'nothing_sold',
        leg.status === 'error' ? `The sell order failed (${leg.note}). The bet is unchanged.` : 'The price moved before the order arrived and nothing was sold. The bet is unchanged.',
        quote,
      );
    }
  }
  if (hedgeLeg.quantity > 0) {
    sentNow.push(
      await sendLeg(deps, bet, 'cashout', {
        symbol: hedgeLeg.symbol,
        side: 'sell',
        outcome: hedgeLeg.outcome,
        limitPrice: Math.max(PRICE_TICK, clean(hedgeLeg.price! - slip)),
        quantity: hedgeLeg.quantity,
        tif: 'IOC',
        clientOrderId: `gv-${bet.id}-ca${attempt}`,
      }),
    );
  }

  refreshTotals(bet);
  const h = holdings(bet);
  const left = clean(Math.max(0, h.outcome.quantity) + Math.max(0, h.hedge.quantity));
  const proceeds = clean((bet.cashOut?.proceeds ?? 0) + sentNow.reduce((sum, l) => sum + sold(l), 0));
  const complete = left <= 1e-9;
  bet.cashOut = {
    at: now().toISOString(),
    stake: stakeBefore,
    proceeds,
    pnl: clean(proceeds - stakeBefore),
    complete,
  };
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
  deps.ledger.save();
  return bet;
}
