/**
 * The mirror image of a ladder, which is how a falling-price bet reuses everything built for a rising one.
 *
 * A ladder lists "price at or above X" contracts. "Price below X" is the same contract seen from the other side: its YES
 * price is the contract's NO price. So a bet on a price staying under one level and then falling under a lower one is
 * exactly a bet on the mirrored ladder, where every strike is negated and every book is flipped:
 *
 *     mirrored strike = - strike
 *     mirrored bid    = 1 - ask        (what a NO buyer would pay is what a YES seller receives)
 *     mirrored ask    = 1 - bid
 *     mirrored result = the opposite of the real one
 *
 * The pair-finding, the offer rule, the depth guard and the sizing all work on the mirror without changing. Only the
 * orders themselves are real, and they are sent on the opposite side (a "YES" on the mirror is a real NO).
 */
import type { Exchange } from './exchange.ts';
import type { BookTicker, GeminiContract, GeminiEvent } from './gemini/types.ts';
import { clean } from './pricing.ts';

/** Which way a bet looks. "up" is a bet that a price reaches a higher level, "down" that it falls to a lower one. */
export type Direction = 'up' | 'down';

export const isDirection = (v: unknown): v is Direction => v === 'up' || v === 'down';

export const flipOutcome = (o: 'yes' | 'no'): 'yes' | 'no' => (o === 'yes' ? 'no' : 'yes');

/** The real side of an order that is a YES or NO on the ladder as the bet sees it. */
export const orient = (direction: Direction | undefined, o: 'yes' | 'no'): 'yes' | 'no' => (direction === 'down' ? flipOutcome(o) : o);

const mirrorPrice = (v: string | null | undefined): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(clean(1 - n)) : null;
};

const mirrorSide = (side: string | null | undefined): string | null | undefined => (side === 'yes' ? 'no' : side === 'no' ? 'yes' : side);

function mirrorContract(c: GeminiContract): GeminiContract {
  return {
    ...c,
    strike: c.strike && c.strike.value !== undefined ? { ...c.strike, value: String(-Number(c.strike.value)) } : c.strike,
    prices: c.prices
      ? {
          bestBid: mirrorPrice(c.prices.bestAsk),
          bestAsk: mirrorPrice(c.prices.bestBid),
          lastTradePrice: mirrorPrice(c.prices.lastTradePrice),
        }
      : c.prices,
    resolutionSide: mirrorSide(c.resolutionSide),
  };
}

export const mirrorEvent = (event: GeminiEvent): GeminiEvent => ({ ...event, contracts: event.contracts.map(mirrorContract) });

export const mirrorBook = (b: BookTicker): BookTicker => ({
  symbol: b.symbol,
  bid: b.ask === null ? null : clean(1 - b.ask),
  bidSize: b.askSize,
  ask: b.bid === null ? null : clean(1 - b.bid),
  askSize: b.bidSize,
});

/**
 * An exchange whose READS show the mirror. Orders pass straight through: the bet code names the real side of each order
 * itself (through `orient`), and the prices it quotes in the mirror are the very numbers the real order is limited at.
 */
export function mirrorExchange(ex: Exchange): Exchange {
  return {
    getEvent: async (ticker) => mirrorEvent(await ex.getEvent(ticker)),
    placeOrder: (req) => ex.placeOrder(req),
    findOrder: (id, opts) => ex.findOrder(id, opts),
    cancelOrder: (id) => ex.cancelOrder(id),
    cash: () => ex.cash(),
    allOrders: () => ex.allOrders(),
    watchBook: (symbol, onTick) => ex.watchBook(symbol, (tick) => onTick(mirrorBook(tick))),
    topOfBook: async (symbol) => mirrorBook(await ex.topOfBook(symbol)),
  };
}

/** The exchange as the bet sees it: the mirror for a falling-price bet, itself otherwise. */
export const viewFor = (ex: Exchange, direction: Direction | undefined): Exchange => (direction === 'down' ? mirrorExchange(ex) : ex);

/** A strike as the reader knows it. The mirror negates strikes; this turns one back. */
export const realStrike = (direction: Direction | undefined, mirrored: number): number => (direction === 'down' ? clean(-mirrored) : mirrored);
