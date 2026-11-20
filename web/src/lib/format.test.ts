import { describe, expect, it } from 'vitest';
import { money, timeLeft } from './format';

describe('a price in dollars', () => {
  it('keeps a whole strike whole', () => {
    expect(money(63500)).toBe('$63,500');
    expect(money(142)).toBe('$142');
    expect(money(1)).toBe('$1');
    expect(money(0)).toBe('$0');
  });

  it('always shows both cents once there are any', () => {
    expect(money(141.6)).toBe('$141.60');
    expect(money(63769.91)).toBe('$63,769.91');
    expect(money(1806.5)).toBe('$1,806.50');
    expect(money(2.5)).toBe('$2.50');
  });

  it('keeps up to four decimals under $10, where ladders step by fractions of a cent', () => {
    expect(money(0.905)).toBe('$0.905');
    expect(money(0.9512)).toBe('$0.9512');
    expect(money(0.88)).toBe('$0.88');
    expect(money(3.525)).toBe('$3.525');
  });

  it('is not thrown by the dust left over from arithmetic between rungs', () => {
    expect(money(63240.000000001)).toBe('$63,240');
    expect(money(0.30000000000000004)).toBe('$0.30');
    expect(money(141.6000000001)).toBe('$141.60');
  });
});

describe('time left on a market', () => {
  const now = Date.parse('2026-11-20T01:00:00Z');
  it('counts down, then says closed', () => {
    expect(timeLeft('2026-11-20T03:10:00Z', now)).toBe('Closes in 2 h 10 min');
    expect(timeLeft('2026-11-20T01:25:00Z', now)).toBe('Closes in 25 min');
    expect(timeLeft('2026-11-20T01:00:30Z', now)).toBe('Closes in under a minute');
    expect(timeLeft('2026-11-20T00:59:00Z', now)).toBe('Closed');
    expect(timeLeft(null, now)).toBeNull();
  });
});
