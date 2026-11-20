import { describe, expect, it } from 'vitest';
import type { OddsBand } from '../api/types';
import { bandLabel, expectedText, oddsTotals, oddsVerdict, oddsWords, shareText } from './odds';

const bands = (rows: [calls: number, cameIn: number, expected: number][]): OddsBand[] =>
  rows.map(([calls, cameIn, expected], i) => ({ from: i * 0.25, to: (i + 1) * 0.25, calls, cameIn, expected }));

describe('odds bands', () => {
  it('names each band by the chance the market gave', () => {
    expect(bands([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]).map(bandLabel)).toEqual(['Under 25%', '25% to 50%', '50% to 75%', '75% or more']);
  });

  it('adds the bands up', () => {
    expect(oddsTotals(bands([[8, 2, 1.12], [14, 7, 4.76], [11, 8, 6.3], [4, 4, 3.28]]))).toEqual({ calls: 37, cameIn: 21, expected: expect.closeTo(15.46, 6) });
    expect(oddsTotals([])).toEqual({ calls: 0, cameIn: 0, expected: 0 });
  });

  it('writes an expected count as a person would', () => {
    expect(expectedText(4.76)).toBe('4.8');
    expect(expectedText(3.98)).toBe('4');
    expect(expectedText(0)).toBe('0');
  });

  it('shows a share only where there are calls', () => {
    expect(shareText(2, 8)).toBe('25%');
    expect(shareText(0, 0)).toBe('–');
  });
});

describe('what the table says', () => {
  it('says nothing with no calls', () => {
    expect(oddsWords(bands([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]))).toBeNull();
    expect(oddsWords([])).toBeNull();
  });

  it('draws no conclusion from a handful of calls', () => {
    const b = bands([[1, 1, 0.2], [2, 2, 0.8], [1, 1, 0.6], [0, 0, 0]]);
    expect(oddsVerdict(oddsTotals(b))).toBe('too_few');
    expect(oddsWords(b)).toBe('Of 4 revealed calls, 4 came in; the market’s own odds expected about 1.6. That is too few to say whether its odds were right.');
  });

  it('uses the singular for one call', () => {
    expect(oddsWords(bands([[0, 0, 0], [1, 0, 0.41], [0, 0, 0], [0, 0, 0]]))).toMatch(/^Of 1 revealed call, 0 came in;/);
  });

  it('calls it in line when the count is within what chance allows', () => {
    // 40 calls at an average of 40%: 16 expected, spread about 3.1, so 21 is inside two spreads.
    const b = bands([[0, 0, 0], [40, 21, 16], [0, 0, 0], [0, 0, 0]]);
    expect(oddsVerdict(oddsTotals(b))).toBe('in_line');
    expect(oddsWords(b)).toContain('in line with its odds');
  });

  it('says who beat whom when it is not', () => {
    const more = bands([[0, 0, 0], [40, 30, 16], [0, 0, 0], [0, 0, 0]]);
    expect(oddsVerdict(oddsTotals(more))).toBe('more');
    expect(oddsWords(more)).toContain('beat the market');
    const fewer = bands([[0, 0, 0], [40, 5, 16], [0, 0, 0], [0, 0, 0]]);
    expect(oddsVerdict(oddsTotals(fewer))).toBe('fewer');
    expect(oddsWords(fewer)).toContain('the market beat the players');
  });

  it('does not divide by nothing when every call was a certainty', () => {
    const b = bands([[0, 0, 0], [0, 0, 0], [0, 0, 0], [25, 25, 25]]);
    expect(oddsVerdict(oddsTotals(b))).toBe('in_line');
  });
});
