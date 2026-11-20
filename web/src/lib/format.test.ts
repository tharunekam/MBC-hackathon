import { describe, expect, it } from 'vitest';
import { ago, cents, dateTime, edgeText, money, pct, timeLeft, usd, usdSigned } from './format';

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
    expect(timeLeft('2026-11-20T02:00:00Z', now)).toBe('Closes in 1 h');
    expect(timeLeft('2026-11-21T07:00:00Z', now)).toBe('Closes in 1 d 6 h');
    expect(timeLeft('2026-11-21T01:00:00Z', now)).toBe('Closes in 1 d');
    expect(timeLeft('garbage', now)).toBeNull();
    expect(timeLeft('2026-11-20T01:25:00Z', now)).toBe('Closes in 25 min');
    expect(timeLeft('2026-11-20T01:00:30Z', now)).toBe('Closes in under a minute');
    expect(timeLeft('2026-11-20T00:59:00Z', now)).toBe('Closed');
    expect(timeLeft(null, now)).toBeNull();
  });
});

describe('figures never print a negative zero, NaN or a hyphen for a minus', () => {
  it('rounds before it chooses a sign', () => {
    expect(usd(-0.001)).toBe('$0.00');
    expect(usd(-0)).toBe('$0.00');
    expect(usd(0.1 + 0.2 - 0.3)).toBe('$0.00');
    expect(usd(-12.5)).toBe('−$12.50');
    expect(usd(1234.5)).toBe('$1,234.50');
    expect(usdSigned(-0.004)).toBe('$0.00');
    expect(usdSigned(12.5)).toBe('+$12.50');
    expect(usdSigned(-10)).toBe('−$10.00');
    expect(pct(-0.001)).toBe('0%');
    expect(pct(-0.032)).toBe('−3%');
    expect(pct(0.374)).toBe('37%');
    expect(cents(-0.001)).toBe('0¢');
    expect(cents(0.554)).toBe('55¢');
    expect(money(-0.00001)).toBe('$0');
    expect(edgeText(0.004)).toBe('0.00');
    expect(edgeText(-0.004)).toBe('0.00');
    expect(edgeText(0.405)).toBe('+0.41');
    expect(edgeText(-0.66)).toBe('−0.66');
  });

  it('shows a dash for anything that is not a number', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(usd(bad)).toBe('–');
      expect(usdSigned(bad)).toBe('–');
      expect(pct(bad)).toBe('–');
      expect(cents(bad)).toBe('–');
      expect(money(bad)).toBe('–');
      expect(edgeText(bad)).toBe('–');
    }
  });

  it('reads an unparseable date as nothing, not as NaN', () => {
    expect(ago('garbage')).toBe('');
    expect(dateTime('garbage')).toBe('');
    expect(dateTime(null)).toBe('');
    expect(ago('2026-11-20T00:55:00Z', Date.parse('2026-11-20T01:00:00Z'))).toBe('5 min ago');
  });

  it('writes a date with a time one way', () => {
    expect(dateTime(new Date(2026, 10, 20, 5, 13))).toBe('Nov 20, 5:13 AM');
    expect(dateTime(new Date(2026, 10, 20, 6, 0))).toBe('Nov 20, 6 AM');
  });
});
