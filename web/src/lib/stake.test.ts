import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { capFrom, cleanStakeText, stakeFrom, stakeRefusal } from './stake';

describe('what may be typed in a stake box', () => {
  it('keeps digits and one dot, to the cent', () => {
    expect(cleanStakeText('25')).toBe('25');
    expect(cleanStakeText('$1,250.50')).toBe('1250.50');
    expect(cleanStakeText('12.345')).toBe('12.34');
    expect(cleanStakeText('1.2.3')).toBe('1.23');
    expect(cleanStakeText('abc')).toBe('');
    expect(cleanStakeText('5.')).toBe('5.');
  });
});

describe('the dollars a stake box holds', () => {
  it('reads an amount', () => {
    expect(stakeFrom('10')).toBe(10);
    expect(stakeFrom('7.5')).toBe(7.5);
    expect(stakeFrom('5.')).toBe(5);
    expect(stakeFrom('.5')).toBe(0.5);
  });

  it('is zero, meaning no stake, for an empty box, a lone dot, a zero or anything that is not a number', () => {
    for (const text of ['', ' ', '.', '0', '0.00', 'x', '1.2.3']) expect(stakeFrom(text)).toBe(0);
  });

  it('stops at a hundred thousand dollars', () => {
    expect(stakeFrom('999999999')).toBe(100000);
  });
});

describe('the cap on one bet, as the executor says it', () => {
  const refused = (message: string, code = 'stake_too_large') => new ApiError(400, { error: message, code }, message);

  it('is read from the refusal of a stake above it', () => {
    expect(capFrom(refused('Bets are capped at $100 on this demo.'))).toBe(100);
    expect(capFrom(refused('Bets are capped at $25 on this demo.'))).toBe(25);
    expect(capFrom(refused('Bets are capped at $1,000.50 on this demo.'))).toBe(1000.5);
  });

  it('is not guessed from any other error, or from a sentence with no amount in it', () => {
    expect(capFrom(refused('"stake" is too large.', 'invalid_stake'))).toBeNull();
    expect(capFrom(refused('Too much.'))).toBeNull();
    expect(capFrom(new Error('Bets are capped at $100'))).toBeNull();
    expect(capFrom(null)).toBeNull();
  });

  it('keeps the executor’s own sentence for a cap it could not read', () => {
    expect(stakeRefusal(refused('Too much.'))).toBe('Too much.');
    expect(stakeRefusal(refused('x', 'no_depth'))).toBeNull();
    expect(stakeRefusal(new Error('x'))).toBeNull();
  });
});
