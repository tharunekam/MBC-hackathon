import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { friendly } from './friendly';

const err = (code: string, message = 'raw') => new ApiError(422, { error: message, code }, message);

describe('what a failed bet says', () => {
  it('says nothing was bought, and what to do', () => {
    expect(friendly(err('insufficient_depth'))).toMatch(/Nothing was bought. Try a smaller stake/);
    expect(friendly(err('market_closed'))).toMatch(/Nothing was bought/);
    expect(friendly(err('price_above_limit'))).toMatch(/moved against you/);
  });

  it('asks a rising parlay for a higher target and a falling one for a lower target', () => {
    expect(friendly(err('price_too_high'))).toMatch(/further above the first level/);
    expect(friendly(err('price_too_high'), { product: 'parlay', direction: 'down' })).toMatch(/further below the first level/);
  });

  it('calls a parlay’s two prices the first level and the target, never a condition, a leg or a pair', () => {
    for (const code of ['offer_refused', 'markup_too_high', 'price_too_high', 'no_price', 'insufficient_depth', 'market_closed']) {
      for (const direction of ['up', 'down'] as const) {
        expect(friendly(err(code), { product: 'parlay', direction })).not.toMatch(/condition|\bleg\b|\bpart\b|\bpair\b/i);
      }
    }
  });

  it('says what the cap is when a stake is over it, not that prices are unavailable', () => {
    const said = friendly(new ApiError(400, { error: 'Bets are capped at $100 on this demo.', code: 'stake_too_large' }, 'x'));
    expect(said).toBe('Each bet is capped at $100 here. Nothing was bought. Enter a smaller stake.');
    expect(friendly(new ApiError(400, { error: 'Too much.', code: 'stake_too_large' }, 'x'))).toBe('Too much. Nothing was bought.');
    expect(friendly(new ApiError(400, { error: '"stake" must be a positive dollar amount.', code: 'invalid_stake' }, 'x'))).toMatch(/Nothing was bought. Enter a stake in dollars/);
  });

  it('speaks of levels for a range', () => {
    expect(friendly(err('markup_too_high'), { product: 'range' })).toMatch(/other levels/);
    expect(friendly(err('no_price'), { product: 'range' })).toMatch(/further apart/);
  });

  it('asks a range that costs too much for a narrower one, never a wider one', () => {
    const said = friendly(err('price_too_high'), { product: 'range' });
    expect(said).toMatch(/narrower/);
    expect(said).not.toMatch(/further apart/);
  });

  it('asks a breakout for levels further apart, and says nothing was bought', () => {
    expect(friendly(err('markup_too_high'), { product: 'breakout' })).toMatch(/breakout is not good value.*Nothing was bought.*other levels/);
    for (const code of ['price_too_high', 'no_price']) {
      const said = friendly(err(code), { product: 'breakout' });
      expect(said).toMatch(/Nothing was bought/);
      expect(said).toMatch(/further apart/);
      expect(said).not.toMatch(/target|condition|range/);
    }
  });

  it('passes the server\'s own words through for a code it does not know, and copes with anything else', () => {
    expect(friendly(err('something_new', 'Leg 2: the market is closed.'))).toBe('Leg 2: the market is closed.');
    expect(friendly(new Error('boom'))).toBe('boom');
    expect(friendly('x')).toBe('Something went wrong.');
  });
});
