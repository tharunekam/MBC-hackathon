import { describe, expect, it } from 'vitest';
import { calledWords, resultWord } from './callWords';

const lo = 'GEMI-BTC2611190100-HI62500';
const hi = 'GEMI-BTC2611190100-HI64000';

describe('how a scored call came out', () => {
  it('is Won or Lost, the same two words on every page', () => {
    expect(resultWord(1)).toBe('Won');
    expect(resultWord(0)).toBe('Lost');
  });

  it('a rising parlay hit by finishing at or above its target, and missed between its two levels', () => {
    expect(calledWords({ betId: 'a1b2c3', condition: lo, target: hi, outcome: 1 })).toBe('Called it. It finished at or above $64,000.');
    expect(calledWords({ betId: 'a1b2c3', condition: lo, target: hi, outcome: 0 })).toBe('Missed. It finished at or above $62,500, but below $64,000.');
  });

  it('a falling parlay is the mirror: its condition is the higher level', () => {
    expect(calledWords({ betId: 'dn-a1b2c3', condition: hi, target: lo, outcome: 1 })).toBe('Called it. It finished below $62,500.');
    expect(calledWords({ betId: 'dn-a1b2c3', condition: hi, target: lo, outcome: 0 })).toBe('Missed. It finished below $64,000, but not below $62,500.');
  });

  it('a range hits between its two levels', () => {
    expect(calledWords({ betId: 'rg-a1b2c3', condition: lo, target: hi, outcome: 1 })).toBe('Called it. It finished between $62,500 and $64,000.');
    expect(calledWords({ betId: 'rg-a1b2c3', condition: lo, target: hi, outcome: 0 })).toBe('Missed. It finished outside $62,500 to $64,000.');
  });

  it('a breakout is the range the other way round: the same finish is a hit on one and a miss on the other', () => {
    expect(calledWords({ betId: 'bo-a1b2c3', condition: lo, target: hi, outcome: 1 })).toBe('Called it. It finished outside $62,500 to $64,000.');
    expect(calledWords({ betId: 'bo-a1b2c3', condition: lo, target: hi, outcome: 0 })).toBe('Missed. It finished between $62,500 and $64,000.');
  });

  it('says only what is certain when a symbol carries no level', () => {
    expect(calledWords({ betId: 'rg-a1b2c3', condition: 'SOMETHING-ELSE', target: hi, outcome: 1 })).toBe('Called it.');
    expect(calledWords({ betId: 'a1b2c3', condition: lo, target: 'SOMETHING-ELSE', outcome: 0 })).toBe('Missed.');
  });
});
