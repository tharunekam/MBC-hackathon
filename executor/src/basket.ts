/**
 * A basket: one view across several assets, placed in a single step.
 *
 * Each leg is an ordinary bet (a parlay, going either way, a range or a breakout) on its own ladder, with its own two orders and its own
 * result. A basket adds only two things: every leg is checked before the first one is placed, and the bets carry a shared
 * basket id so they are shown together. Nothing links the legs on the exchange, so a basket is NOT all-or-nothing: if an
 * order cannot be filled after earlier legs are in, the earlier legs stay, nothing further is placed, and the result says so.
 */
import { BetRefused, defaultId, placeConditionalBet, planConditionalBet } from './bets.ts';
import type { Deps } from './bets.ts';
import type { BetRecord } from './ledger.ts';
import type { Direction } from './mirror.ts';
import { placeBreakoutBet, planBreakoutBet } from './breakout-bet.ts';
import { placeRangeBet, planRangeBet } from './range-bet.ts';

export const MIN_BASKET_LEGS = 2;
export const MAX_BASKET_LEGS = 6;

export type BasketLeg =
  | { product: 'parlay'; direction?: Direction; eventTicker: string; conditionSymbol: string; targetSymbol: string; stake: number }
  | { product: 'range'; eventTicker: string; lowSymbol: string; highSymbol: string; stake: number }
  | { product: 'breakout'; eventTicker: string; lowSymbol: string; highSymbol: string; stake: number };

export interface BasketRequest {
  user: string;
  name?: string;
  legs: BasketLeg[];
}

/** A basket turned down BEFORE any order was sent. `index` is the leg that did not pass. */
export class BasketRefused extends Error {
  readonly index: number;
  readonly code: BetRefused['code'] | 'not_a_linked_pair';
  readonly quote?: BetRefused['quote'];
  constructor(index: number, code: BasketRefused['code'], message: string, quote?: BetRefused['quote']) {
    super(`Leg ${index + 1}: ${message}`);
    this.name = 'BasketRefused';
    this.index = index;
    this.code = code;
    this.quote = quote;
  }
}

export interface BasketResult {
  id: string;
  name?: string;
  /** How many legs the basket was asked to have. */
  size: number;
  /** The bets that were placed, in leg order. */
  bets: BetRecord[];
  /** Set when a leg could not be completed: the leg, and why. The legs after it were not attempted. */
  failed: { index: number; code: string; message: string } | null;
}

const NOT_A_PAIR = /not a linked pair|not a range/;

async function checkLeg(deps: Deps, user: string, leg: BasketLeg, index: number): Promise<void> {
  try {
    if (leg.product === 'range') {
      await planRangeBet(deps, { user, eventTicker: leg.eventTicker, lowSymbol: leg.lowSymbol, highSymbol: leg.highSymbol, stake: leg.stake });
    } else if (leg.product === 'breakout') {
      await planBreakoutBet(deps, { user, eventTicker: leg.eventTicker, lowSymbol: leg.lowSymbol, highSymbol: leg.highSymbol, stake: leg.stake });
    } else {
      await planConditionalBet(deps, {
        user,
        eventTicker: leg.eventTicker,
        conditionSymbol: leg.conditionSymbol,
        targetSymbol: leg.targetSymbol,
        direction: leg.direction,
        stake: leg.stake,
      });
    }
  } catch (err) {
    if (err instanceof BetRefused) throw new BasketRefused(index, err.code, err.message, err.quote);
    if (err instanceof Error && NOT_A_PAIR.test(err.message)) throw new BasketRefused(index, 'not_a_linked_pair', err.message);
    throw err;
  }
}

export async function placeBasket(deps: Deps, req: BasketRequest): Promise<BasketResult> {
  const size = req.legs.length;
  if (size < MIN_BASKET_LEGS || size > MAX_BASKET_LEGS) {
    throw new Error(`A basket needs from ${MIN_BASKET_LEGS} to ${MAX_BASKET_LEGS} legs; this one has ${size}.`);
  }

  // Every leg is checked against the live market first, so a basket that cannot be placed is refused before anything is bought.
  for (let i = 0; i < size; i++) await checkLeg(deps, req.user, req.legs[i]!, i);

  const id = `bk-${(deps.newId ?? defaultId)()}`;
  const result: BasketResult = { id, ...(req.name ? { name: req.name } : {}), size, bets: [], failed: null };
  for (let i = 0; i < size; i++) {
    const leg = req.legs[i]!;
    const basket = { id, ...(req.name ? { name: req.name } : {}), index: i, size };
    try {
      const bet =
        leg.product === 'range'
          ? await placeRangeBet(deps, { user: req.user, eventTicker: leg.eventTicker, lowSymbol: leg.lowSymbol, highSymbol: leg.highSymbol, stake: leg.stake, basket })
          : leg.product === 'breakout'
            ? await placeBreakoutBet(deps, { user: req.user, eventTicker: leg.eventTicker, lowSymbol: leg.lowSymbol, highSymbol: leg.highSymbol, stake: leg.stake, basket })
            : await placeConditionalBet(deps, {
              user: req.user,
              eventTicker: leg.eventTicker,
              conditionSymbol: leg.conditionSymbol,
              targetSymbol: leg.targetSymbol,
              direction: leg.direction,
              stake: leg.stake,
              basket,
            });
      result.bets.push(bet);
      if (bet.status !== 'open') {
        result.failed = { index: i, code: bet.status, message: bet.note ?? 'The orders for this leg could not be completed.' };
        break;
      }
    } catch (err) {
      // The first leg was turned down before any order, so nothing at all was bought: that is a refused basket, not a
      // basket with a failed leg. (Seen on the sandbox 2026-11-20: the size at the best price can drop to zero in the
      // moment between the check above and the leg's own.)
      if (i === 0 && err instanceof BetRefused) throw new BasketRefused(0, err.code, err.message, err.quote);
      result.failed = {
        index: i,
        code: err instanceof BetRefused ? err.code : 'error',
        message: err instanceof Error ? err.message : String(err),
      };
      break;
    }
  }
  return result;
}
