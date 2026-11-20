import { ApiError } from '../api/client';
import type { Direction, Product } from '../api/types';
import { cents, usd } from './format';
import { capFrom } from './stake';

/**
 * What a failed bet says to the person who placed it. Every answer says that nothing was bought when that is true, and what
 * to do about it. The words follow the product: a range or a breakout asks for other levels, a falling parlay for a lower
 * target. A parlay's two prices are "the first level" and "the target", the same names the builder uses.
 *
 * `shownPrice` is the price per $1 the person was looking at when they pressed Place bet, so that a price that moved out from
 * under them is said with both prices. `basket` says the thing being placed is a basket, so the advice names it.
 *
 * Only a bet being placed (a `product`, or a `basket`) is worded as "we could not place that bet". A page that only reads (the
 * markets, My bets, the leaderboard) has nothing to place, so an answer it cannot use is said as "that did not go through".
 */
export function friendly(err: unknown, ctx: { product?: Product; direction?: Direction; shownPrice?: number | null; basket?: boolean } = {}): string {
  if (err instanceof ApiError) {
    const range = ctx.product === 'range';
    const breakout = ctx.product === 'breakout';
    const placing = ctx.product !== undefined || ctx.basket === true;
    switch (err.code) {
      case 'offer_refused':
      case 'markup_too_high':
        if (breakout) return 'This breakout is not good value right now. Nothing was bought. Try other levels.';
        return range ? 'This range is not good value right now. Nothing was bought. Try other levels.' : 'This bet is not good value right now. Nothing was bought. Try other levels.';
      case 'price_too_high':
        // A breakout costs too much when its levels are close together, a range when they are far apart.
        if (breakout) return 'Finishing outside these levels is close to certain, so it pays little. Nothing was bought. Move the levels further apart.';
        if (range) return 'The range would cost too much for what it can win. Nothing was bought. Pick a narrower range.';
        return `The payout would be too small for the price. Nothing was bought. Move the target further ${ctx.direction === 'down' ? 'below' : 'above'} the first level.`;
      case 'no_price':
        if (breakout) return 'There is no sensible price for finishing outside these two levels. Nothing was bought. Move the levels further apart.';
        if (range) return 'There is no sensible price for this range. Nothing was bought. Move the levels further apart.';
        return `The payout would be too small for the price. Nothing was bought. Move the target further ${ctx.direction === 'down' ? 'below' : 'above'} the first level.`;
      case 'no_depth':
        return 'We could not read the market just now, so nothing was bought. Try again in a moment.';
      case 'insufficient_depth':
        return 'There is not enough on the market to cover that bet right now. Nothing was bought. Try a smaller stake or other levels.';
      case 'market_closed':
        return 'This market is not taking bets right now. Nothing was bought. Check back in a few minutes.';
      case 'price_above_limit': {
        // The refusal carries the offer as it stood when the order arrived: its price is the new one.
        const live = err.body?.quote?.pricePaid;
        const was = ctx.shownPrice;
        const moved =
          typeof live === 'number' && typeof was === 'number' && cents(live) !== cents(was)
            ? `The price moved from ${cents(was)} to ${cents(live)} while you were deciding.`
            : 'The price moved while you were deciding.';
        return `${moved} Nothing was bought. Check the new price and place the ${ctx.basket ? 'basket' : 'bet'} again.`;
      }
      // The kill switch answers before anything is sent, so unlike a dropped connection it leaves no doubt: nothing was bought.
      case 'paused':
        return 'Betting is paused for a moment. Nothing was bought. Try again soon.';
      // The page sent an id it had already used for a different bet. The executor placed nothing, and the next try gets a new id.
      case 'request_id_reused':
        return 'That request was already used for a different bet. Nothing was bought. Check the bet and place it again.';
      // A basket names a leg that did not end up open by the status its bet ended in.
      case 'unwound':
        return 'The second order could not be placed, so the first one was sold back.';
      case 'unhedged':
        // Said by what is missing: a Stake Back gives the stake back only through its second order; a Range and a Breakout have no stake back.
        return ctx.product === undefined || ctx.product === 'parlay'
          ? 'Only the first order went through, so the stake does not come back if the first level fails. You can sell it back in My bets.'
          : 'Only the first order went through, so this bet is only half placed. You can sell it back in My bets.';
      case 'failed':
        return 'The first order did not go through. Nothing was bought.';
      case 'stake_too_small':
        return 'That stake is too small to place.';
      case 'stake_too_large': {
        // The executor caps a single bet on the hosted demo and says the amount; the same words as the button uses.
        const cap = capFrom(err);
        return cap !== null ? `Each bet is capped at ${usd(cap, 0)} here. Nothing was bought. Enter a smaller stake.` : 'That stake is above the most one bet can be here. Nothing was bought. Enter a smaller stake.';
      }
      case 'invalid_stake':
        return 'That is not an amount we can place. Nothing was bought. Enter a stake in dollars.';
      default:
        // A busy or broken server, a dropped connection or an unreadable answer already carry a plain sentence of the client's
        // own. Any other code is the executor's wording, which can name symbols and orders: never shown.
        if (err.status === 0 || err.status === 429 || err.status >= 500 || err.code === 'unreadable') return err.message;
        return placing ? 'We could not place that bet. Nothing was bought. Try again.' : 'That did not go through. Try again.';
    }
  }
  // Whatever else was thrown is a developer's string ("Failed to fetch", a stack message): never shown.
  return 'Something went wrong. Try again in a moment.';
}

/** Why a call could not be sealed on Solana, in one sentence, and whether asking again could change anything. */
export interface SealProblem {
  text: string;
  /** True when no second try can help: the market has closed, so a call can no longer be sealed for this bet. */
  final: boolean;
}

/**
 * What a call that would not seal says. The bet itself is placed whatever happens here, and the sentence says so. A call is
 * refused for good once the market has closed (the chain service answers `too_late`); anything else may pass on a second try.
 */
export function sealProblem(err: unknown): SealProblem {
  if (err instanceof ApiError && err.code === 'too_late') return { text: 'This market has closed, so the call can no longer be sealed. Your bet is placed.', final: true };
  return { text: 'We could not seal this call yet, but your bet is placed.', final: false };
}
