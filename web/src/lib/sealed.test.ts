import { describe, expect, it } from 'vitest';
import { sealedSpoken, sealedWords, unrevealed } from './sealed';

describe('calls sealed beside calls revealed', () => {
  it('says nothing when the board does not report how many were sealed', () => {
    expect(sealedWords({ calls: 3 })).toBeNull();
    expect(unrevealed({ calls: 3 })).toBeNull();
    expect(sealedSpoken({ calls: 3 })).toBeNull();
  });

  it('says so when every call has been revealed', () => {
    expect(sealedWords({ calls: 3, sealed: 3 })).toBe('every call revealed');
    expect(unrevealed({ calls: 3, sealed: 3, refunded: 0 })).toBe(0);
  });

  it('shows the gap when calls are still sealed', () => {
    expect(sealedWords({ calls: 1, sealed: 3 })).toBe('of 3 sealed');
    expect(unrevealed({ calls: 1, sealed: 3 })).toBe(2);
    expect(sealedSpoken({ calls: 1, sealed: 3 })).toBe('1 revealed of 3 sealed, 2 not revealed.');
  });

  it('counts refunded calls apart, because they can never be revealed', () => {
    expect(sealedWords({ calls: 6, sealed: 9, refunded: 2 })).toBe('of 9 sealed, 2 refunded');
    expect(unrevealed({ calls: 6, sealed: 9, refunded: 2 })).toBe(1);
    expect(sealedSpoken({ calls: 6, sealed: 9, refunded: 2 })).toBe('6 revealed of 9 sealed, 2 refunded, 1 not revealed.');
  });

  it('does not call it a gap when the only calls not revealed were refunded', () => {
    expect(sealedWords({ calls: 4, sealed: 5, refunded: 1 })).toBe('of 5 sealed, the other refunded');
    expect(sealedWords({ calls: 4, sealed: 6, refunded: 2 })).toBe('of 6 sealed, the others refunded');
    expect(unrevealed({ calls: 4, sealed: 6, refunded: 2 })).toBe(0);
    expect(sealedSpoken({ calls: 4, sealed: 6, refunded: 2 })).toBe('4 revealed of 6 sealed, 2 refunded.');
  });

  it('never reports a negative gap from counts that disagree', () => {
    expect(unrevealed({ calls: 5, sealed: 4, refunded: 3 })).toBe(0);
    expect(sealedWords({ calls: 5, sealed: 4 })).toBe('every call revealed');
  });
});
