import { ApiError } from '../api/client';
import type { Direction, Product } from '../api/types';
import { usd } from './format';
import { capFrom } from './stake';

/**
 * What a failed bet says to the person who placed it. Every answer says that nothing was bought when that is true, and what
 * to do about it. The words follow the product: a range or a breakout asks for other levels, a falling parlay for a lower
 * target. A parlay's two prices are "the first level" and "the target", the same names the builder uses.
 */
export function friendly(err: unknown, ctx: { product?: Product; direction?: Direction } = {}): string {
  if (err instanceof ApiError) {
    const range = ctx.product === 'range';
    const breakout = ctx.product === 'breakout';
    switch (err.code) {
      case 'offer_refused':
      case 'markup_too_high':
        if (breakout) return 'This breakout is not good value right now. Nothing was bought. Try other levels.';
        return range ? 'This range is not good value right now. Nothing was bought. Try other levels.' : 'This bet is not good value right now. Nothing was bought. Try other levels.';
      case 'price_too_high':
        // A breakout costs too much when its levels are close together, a range when they are far apart.
        if (breakout) return 'Finishing outside these two levels is close to certain, so it would cost too much for what it can win. Nothing was bought. Move the levels further apart.';
        if (range) return 'The range would cost too much for what it can win. Nothing was bought. Pick a narrower range.';
        return `The payout would be too small for the price. Nothing was bought. Move the target further ${ctx.direction === 'down' ? 'below' : 'above'} the first level.`;
      case 'no_price':
        if (breakout) return 'There is no sensible price for finishing outside these two levels. Nothing was bought. Move the levels further apart.';
        if (range) return 'There is no sensible price for this range. Nothing was bought. Move the levels further apart.';
        return `The payout would be too small for the price. Nothing was bought. Move the target further ${ctx.direction === 'down' ? 'below' : 'above'} the first level.`;
      case 'no_depth':
        return 'We could not read the market just now, so nothing was bought. Try again in a moment.';
      case 'insufficient_depth':
        return 'There is not enough resting on the market to fill that bet right now. Nothing was bought. Try a smaller stake or other levels.';
      case 'market_closed':
        return 'This market is not open for trading right now. Nothing was bought. Pick other levels or check back shortly.';
      case 'price_above_limit':
        return 'The price moved against you before the order went through. Nothing was bought. Try again.';
      case 'stake_too_small':
        return 'That stake is too small to place.';
      case 'stake_too_large': {
        // The executor caps a single bet on the hosted demo and says the amount; the same words as the button uses.
        const cap = capFrom(err);
        return cap !== null ? `Each bet is capped at ${usd(cap, 0)} here. Nothing was bought. Enter a smaller stake.` : `${err.message} Nothing was bought.`;
      }
      case 'invalid_stake':
        return 'That is not an amount we can place. Nothing was bought. Enter a stake in dollars.';
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}
