import type { GeminiContract, GeminiEvent } from './gemini/types.ts';
import { mirrorBook, mirrorEvent, realStrike } from './mirror.ts';
import type { Direction } from './mirror.ts';
import { assessPair } from './offer.ts';
import type { OfferQuote } from './offer.ts';
import { conditionalPrice } from './pricing.ts';

/** One strike of an "X or above" ladder, with its live YES-space book. */
export interface Rung {
  symbol: string;
  label: string;
  strike: number;
  bid: number | null;
  ask: number | null;
  /** True only when the contract is active and its market state is "open". */
  open: boolean;
  /** What Gemini reports, e.g. "active/open", "active/post_only", "settled/closed". */
  state: string;
}

export interface LinkedPair {
  eventTicker: string;
  eventTitle: string;
  expiry: string | null;
  /** The condition: the lower strike. */
  a: Rung;
  /** The outcome: the higher strike, which can only hit if A does. */
  b: Rung;
  /** Executable all-in price of $1 "if B given A" right now (fees included), or null if the book can't support it. */
  conditionalPrice: number | null;
  /** The offer rule's verdict and the numbers every quote must carry. */
  offer: OfferQuote;
}

const toNum = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function toRung(c: GeminiContract): Rung | null {
  if (c.strike?.type !== 'above') return null;
  const strike = toNum(c.strike.value);
  if (strike === null) return null;
  return {
    symbol: c.instrumentSymbol,
    label: c.label,
    strike,
    bid: toNum(c.prices?.bestBid),
    ask: toNum(c.prices?.bestAsk),
    open: c.status === 'active' && c.marketState === 'open',
    state: `${c.status}/${c.marketState ?? 'unknown'}`,
  };
}

/** The event's "or above" strikes, lowest first. Empty if the event isn't a ladder. */
export function ladder(event: GeminiEvent): Rung[] {
  return event.contracts
    .map(toRung)
    .filter((r): r is Rung => r !== null)
    .sort((x, y) => x.strike - y.strike);
}

/**
 * A rung as the reader knows it. Pairs for a falling-price bet are found on the mirror of the ladder (see mirror.ts), where
 * strikes are negated and books flipped; this turns one back into the real strike and the real YES book.
 */
export function realRung(r: Rung, direction: Direction | undefined): Rung {
  if (direction !== 'down') return r;
  const book = mirrorBook({ symbol: r.symbol, bid: r.bid, bidSize: null, ask: r.ask, askSize: null });
  return { ...r, strike: realStrike(direction, r.strike), bid: book.bid, ask: book.ask };
}

/**
 * Every (condition, outcome) pair in an event where the outcome strike sits
 * above the condition strike. Both are "price at or above X" on the same
 * underlying and expiry, so B hitting implies A hit: the link that lets two
 * plain orders behave as a conditional bet.
 *
 * With `direction: 'down'` the pairs are those of a falling-price bet: the condition is the higher strike, the outcome the
 * lower one. They are found on the mirror of the ladder, so every rung in the result is a mirrored rung; `realRung` shows
 * it the way a reader knows it.
 */
export function linkedPairs(
  event: GeminiEvent,
  opts: { tradableOnly?: boolean; feeCoef?: number; waiveMarkup?: boolean; direction?: Direction } = {},
): LinkedPair[] {
  const rungs = ladder(opts.direction === 'down' ? mirrorEvent(event) : event);
  const out: LinkedPair[] = [];
  for (let i = 0; i < rungs.length; i++) {
    for (let j = i + 1; j < rungs.length; j++) {
      const a = rungs[i]!;
      const b = rungs[j]!;
      if (b.strike <= a.strike) continue;
      const price = a.open && b.open ? conditionalPrice(b.ask, a.bid, opts.feeCoef ?? 0) : null;
      if (opts.tradableOnly && price === null) continue;
      out.push({
        eventTicker: event.ticker,
        eventTitle: event.title,
        expiry: event.expiryDate ?? null,
        a,
        b,
        conditionalPrice: price,
        offer: assessPair(rungs, a, b, { feeCoef: opts.feeCoef ?? 0, waiveMarkup: opts.waiveMarkup }),
      });
    }
  }
  return out;
}

export function findPair(event: GeminiEvent, aSymbol: string, bSymbol: string, feeCoef = 0, waiveMarkup = false, direction: Direction = 'up'): LinkedPair {
  const pair = linkedPairs(event, { feeCoef, waiveMarkup, direction }).find((p) => p.a.symbol === aSymbol && p.b.symbol === bSymbol);
  if (!pair) {
    throw new Error(
      `${aSymbol} and ${bSymbol} are not a linked pair in ${event.ticker}: both must be "or above" strikes ` +
        `of this event, with the outcome strike ${direction === 'down' ? 'lower' : 'higher'} than the condition strike.`,
    );
  }
  return pair;
}
