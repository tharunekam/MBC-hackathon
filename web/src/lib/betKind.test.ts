import { describe, expect, it } from 'vitest';
import { betSentence, kindOf, kindOfBetId, productName, resultOf, resultWords } from './betKind';

describe('a bet id says what kind of bet it is', () => {
  it('reads the marker the executor puts on the id', () => {
    expect(kindOfBetId('a1b2c3d4')).toEqual({ product: 'parlay', direction: 'up' });
    expect(kindOfBetId('dn-a1b2c3d4')).toEqual({ product: 'parlay', direction: 'down' });
    expect(kindOfBetId('rg-a1b2c3d4')).toEqual({ product: 'range', direction: 'up' });
    expect(kindOfBetId('demo1')).toEqual({ product: 'parlay', direction: 'up' });
  });
});

describe('a bet record without a kind is a rising parlay', () => {
  it('defaults both fields', () => {
    expect(kindOf({})).toEqual({ product: 'parlay', direction: 'up' });
    expect(kindOf({ product: 'range' })).toEqual({ product: 'range', direction: 'up' });
    expect(kindOf({ product: 'parlay', direction: 'down' })).toEqual({ product: 'parlay', direction: 'down' });
  });
});

describe('words for each product', () => {
  it('names the products as the header does', () => {
    expect(productName({ product: 'parlay', direction: 'up' })).toBe('Return Parlay');
    expect(productName({ product: 'parlay', direction: 'down' })).toBe('Return Parlay');
    expect(productName({ product: 'range', direction: 'up' })).toBe('Range');
  });
  it('says each bet in one line', () => {
    expect(betSentence({ product: 'parlay', direction: 'up' }, { condition: 62500, target: 64000 })).toBe('Given $62,500 or above, reach $64,000');
    expect(betSentence({ product: 'parlay', direction: 'down' }, { condition: 64000, target: 62500 })).toBe('Given below $64,000, fall below $62,500');
    expect(betSentence({ product: 'range', direction: 'up' }, { condition: 62500, target: 64000 })).toBe('Finish between $62,500 and $64,000');
  });
});

describe('how a settled bet came out', () => {
  const settled = (conditionResolved: 'yes' | 'no', targetResolved: 'yes' | 'no') => ({ settlement: { conditionResolved, targetResolved, payout: 0, pnl: 0, settledAt: '' } });
  it('is a refund when the first half failed, a win when the target hit, otherwise a loss', () => {
    expect(resultOf(settled('no', 'no'))).toBe('refunded');
    expect(resultOf(settled('yes', 'yes'))).toBe('won');
    expect(resultOf(settled('yes', 'no'))).toBe('lost');
    expect(resultOf({})).toBe(null);
  });
  it('words it for the product: a range finishes inside or outside', () => {
    const parlay = { product: 'parlay', direction: 'up' } as const;
    const range = { product: 'range', direction: 'up' } as const;
    expect(resultWords(parlay, 'won')).toBe('Won');
    expect(resultWords(parlay, 'refunded')).toBe('Stake back');
    expect(resultWords(range, 'won')).toBe('Finished inside');
    expect(resultWords(range, 'lost')).toBe('Finished outside');
  });
});
