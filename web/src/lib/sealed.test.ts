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
    expect(sealedSpoken({ calls: 1, sealed: 3 })).toBe('1 revealed of 3 sealed, 2 not revealed');
  });

  it('counts stake-back calls apart, because they can never be revealed', () => {
    expect(sealedWords({ calls: 6, sealed: 9, refunded: 2 })).toBe('of 9 sealed, 2 stake back');
    expect(unrevealed({ calls: 6, sealed: 9, refunded: 2 })).toBe(1);
    expect(sealedSpoken({ calls: 6, sealed: 9, refunded: 2 })).toBe('6 revealed of 9 sealed, 2 stake back, 1 not revealed');
  });

  it('does not call it a gap when the only calls not revealed were refunded', () => {
    expect(sealedWords({ calls: 4, sealed: 5, refunded: 1 })).toBe('of 5 sealed, the other was a stake back');
    expect(sealedWords({ calls: 4, sealed: 6, refunded: 2 })).toBe('of 6 sealed, the others were stake backs');
    expect(unrevealed({ calls: 4, sealed: 6, refunded: 2 })).toBe(0);
    expect(sealedSpoken({ calls: 4, sealed: 6, refunded: 2 })).toBe('4 revealed of 6 sealed, 2 stake back');
  });

  it('separates thousands, in the line and for a screen reader', () => {
    expect(sealedWords({ calls: 1200, sealed: 1500 })).toBe('of 1,500 sealed');
    expect(sealedWords({ calls: 300, sealed: 1500, refunded: 1100 })).toBe('of 1,500 sealed, 1,100 stake back');
    expect(sealedWords({ calls: 1200, sealed: 2000, refunded: 800 })).toBe('of 2,000 sealed, the others were stake backs');
    expect(sealedSpoken({ calls: 1200, sealed: 2500, refunded: 1000 })).toBe('1,200 revealed of 2,500 sealed, 1,000 stake back, 300 not revealed');
    // Small numbers are as they were.
    expect(sealedWords({ calls: 1, sealed: 3 })).toBe('of 3 sealed');
  });

  it('never reports a negative gap from counts that disagree', () => {
    expect(unrevealed({ calls: 5, sealed: 4, refunded: 3 })).toBe(0);
    expect(sealedWords({ calls: 5, sealed: 4 })).toBe('every call revealed');
  });
});
