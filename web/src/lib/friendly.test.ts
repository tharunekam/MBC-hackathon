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
    expect(friendly(err('price_too_high'))).toMatch(/further above the condition/);
    expect(friendly(err('price_too_high'), { product: 'parlay', direction: 'down' })).toMatch(/further below the condition/);
  });

  it('speaks of levels for a range', () => {
    expect(friendly(err('markup_too_high'), { product: 'range' })).toMatch(/other levels/);
    expect(friendly(err('no_price'), { product: 'range' })).toMatch(/further apart/);
  });

  it('passes the server\'s own words through for a code it does not know, and copes with anything else', () => {
    expect(friendly(err('something_new', 'Leg 2: the market is closed.'))).toBe('Leg 2: the market is closed.');
    expect(friendly(new Error('boom'))).toBe('boom');
    expect(friendly('x')).toBe('Something went wrong.');
  });
});
