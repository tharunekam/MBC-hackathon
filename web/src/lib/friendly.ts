import { ApiError } from '../api/client';
import type { Direction, Product } from '../api/types';

/**
 * What a failed bet says to the person who placed it. Every answer says that nothing was bought when that is true, and what
 * to do about it. The words follow the product: a range asks for levels further apart, a falling parlay for a lower target.
 */
export function friendly(err: unknown, ctx: { product?: Product; direction?: Direction } = {}): string {
  if (err instanceof ApiError) {
    const range = ctx.product === 'range';
    switch (err.code) {
      case 'offer_refused':
      case 'markup_too_high':
        return range ? 'This range is not good value right now. Nothing was bought. Try other levels.' : 'This pair is not good value right now. Nothing was bought. Try other prices.';
      case 'price_too_high':
      case 'no_price':
        if (range) return 'The range would cost too much for what it can win. Nothing was bought. Move the levels further apart.';
        return `The payout would be too small for the price. Nothing was bought. Move the target further ${ctx.direction === 'down' ? 'below' : 'above'} the condition.`;
      case 'no_depth':
        return 'We could not read the market just now, so nothing was bought. Try again in a moment.';
      case 'insufficient_depth':
        return 'There is not enough resting on the market to fill that bet right now. Nothing was bought. Try a smaller stake or other prices.';
      case 'market_closed':
        return 'This market is not open for trading right now. Nothing was bought. Pick other prices or check back shortly.';
      case 'price_above_limit':
        return 'The price moved against you before the order went through. Nothing was bought. Try again.';
      case 'stake_too_small':
        return 'That stake is too small to place.';
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}
