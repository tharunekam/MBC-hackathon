import { describe, expect, it } from 'vitest';
import { wholePercentText, wholePercents } from './shares';

const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);

describe('chances shown side by side add up on screen', () => {
  it('rounds the three results of a parlay to whole percents that add to 100', () => {
    // Seen in the app: each rounded on its own read 38% + 16% + 47% = 101%.
    expect(wholePercents([0.376, 0.156, 0.468])).toEqual([38, 15, 47]);
    expect(sum(wholePercents([0.376, 0.156, 0.468]))).toBe(100);
    // and 38% + 2% + 61% = 101%
    expect(sum(wholePercents([0.3751, 0.0152, 0.6097]))).toBe(100);
  });

  it('leaves shares that already round cleanly alone', () => {
    expect(wholePercents([0.5, 0.25, 0.25])).toEqual([50, 25, 25]);
    expect(wholePercents([1])).toEqual([100]);
    expect(wholePercents([0.47, 0.53])).toEqual([47, 53]);
  });

  it('never moves a share by more than a point', () => {
    const shares = [0.021, 0.039, 0.111, 0.219, 0.251, 0.209, 0.109, 0.041];
    const out = wholePercents(shares);
    expect(sum(out)).toBe(100);
    out.forEach((p, i) => expect(Math.abs(p - shares[i]! * 100)).toBeLessThan(1));
  });

  it('gives the spare point to the share that was cut the most, and on a tie to the larger', () => {
    expect(wholePercents([1 / 3, 1 / 3, 1 / 3])).toEqual([34, 33, 33]);
    expect(wholePercents([0.335, 0.33, 0.335])).toEqual([34, 33, 33]);
    expect(wholePercents([0.105, 0.895])).toEqual([10, 90]);
  });

  it('scales to the shares it is given, so percents and fractions agree and a hair of drift still adds up', () => {
    expect(wholePercents([37.6, 15.6, 46.8])).toEqual(wholePercents([0.376, 0.156, 0.468]));
    expect(sum(wholePercents([0.3761, 0.1562, 0.4681]))).toBe(100); // adds to 1.0004
  });

  it('treats a missing or negative share as nothing, and all-zero as all zero', () => {
    expect(wholePercents([0.5, -0.1, 0.5])).toEqual([50, 0, 50]);
    expect(wholePercents([Number.NaN, 0.25, 0.75])).toEqual([0, 25, 75]);
    expect(wholePercents([0, 0])).toEqual([0, 0]);
    expect(wholePercents([])).toEqual([]);
  });

  it('writes them as text', () => {
    expect(wholePercentText([0.376, 0.156, 0.468])).toEqual(['38%', '15%', '47%']);
  });
});
