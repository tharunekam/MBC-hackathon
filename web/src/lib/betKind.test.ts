import { describe, expect, it } from 'vitest';
import { betSentence, kindOf, kindOfBetId, productName, resultOf, resultWords } from './betKind';

describe('a bet id says what kind of bet it is', () => {
  it('reads the marker the executor puts on the id', () => {
    expect(kindOfBetId('a1b2c3d4')).toEqual({ product: 'parlay', direction: 'up' });
    expect(kindOfBetId('dn-a1b2c3d4')).toEqual({ product: 'parlay', direction: 'down' });
    expect(kindOfBetId('rg-a1b2c3d4')).toEqual({ product: 'range', direction: 'up' });
    expect(kindOfBetId('bo-a1b2c3d4')).toEqual({ product: 'breakout', direction: 'up' });
    expect(kindOfBetId('demo1')).toEqual({ product: 'parlay', direction: 'up' });
  });
});

describe('a bet record without a kind is a rising parlay', () => {
  it('defaults both fields', () => {
    expect(kindOf({})).toEqual({ product: 'parlay', direction: 'up' });
    expect(kindOf({ product: 'range' })).toEqual({ product: 'range', direction: 'up' });
    expect(kindOf({ product: 'breakout' })).toEqual({ product: 'breakout', direction: 'up' });
    expect(kindOf({ product: 'parlay', direction: 'down' })).toEqual({ product: 'parlay', direction: 'down' });
  });
});

describe('words for each product', () => {
  it('names the products as the header does', () => {
    expect(productName({ product: 'parlay', direction: 'up' })).toBe('Stake Back');
    expect(productName({ product: 'parlay', direction: 'down' })).toBe('Stake Back');
    expect(productName({ product: 'range', direction: 'up' })).toBe('Range');
    expect(productName({ product: 'breakout', direction: 'up' })).toBe('Breakout');
  });
  it('says each bet in one line', () => {
    expect(betSentence({ product: 'parlay', direction: 'up' }, { condition: 62500, target: 64000 })).toBe('Given $62,500 or above, reach $64,000');
    expect(betSentence({ product: 'parlay', direction: 'down' }, { condition: 64000, target: 62500 })).toBe('Given it stays under $64,000, fall below $62,500');
    expect(betSentence({ product: 'range', direction: 'up' }, { condition: 62500, target: 64000 })).toBe('Finish between $62,500 and $64,000');
    expect(betSentence({ product: 'breakout', direction: 'up' }, { condition: 62500, target: 64000 })).toBe('Finish outside $62,500 to $64,000');
  });
});

describe('how a settled bet came out', () => {
  const settled = (conditionResolved: 'yes' | 'no', targetResolved: 'yes' | 'no') => ({ settlement: { conditionResolved, targetResolved, payout: 0, pnl: 0, settledAt: '' } });
  it('is a stake back when the first level failed, a win when the target hit, otherwise a loss', () => {
    expect(resultOf(settled('no', 'no'))).toBe('refunded');
    expect(resultOf(settled('yes', 'yes'))).toBe('won');
    expect(resultOf(settled('yes', 'no'))).toBe('lost');
    expect(resultOf({})).toBe(null);
  });
  it('words it the same for every product: Won, Lost, or Stake back', () => {
    expect(resultWords('won')).toBe('Won');
    expect(resultWords('lost')).toBe('Lost');
    expect(resultWords('refunded')).toBe('Stake back');
  });
});
