import { describe, expect, it } from 'vitest';
import { receiptWords } from './receiptWords';

const strikes = (c: number, t: number) => ({ condition: { symbol: 'c', label: 'c', strike: c }, target: { symbol: 't', label: 't', strike: t } });

describe('a placed bet is described in its own words', () => {
  it('a rising parlay: the first order is the bet and the second returns the stake', () => {
    const w = receiptWords({ ...strikes(62500, 64000), product: 'parlay' });
    expect(w.title).toBe('Given $62,500 or above, reach $64,000');
    expect(w.first).toBe('that it reaches $64,000');
    expect(w.second).toBe('that it falls below $62,500');
    expect(w.outcomes.map((o) => o.kind)).toEqual(['win', 'back', 'lose']);
    expect(w.outcomes[2]!.label).toBe('If it holds $62,500 but stops short');
  });

  it('a falling parlay: the same shape the other way up', () => {
    const w = receiptWords({ ...strikes(64000, 62500), product: 'parlay', direction: 'down' });
    expect(w.title).toBe('Given below $64,000, fall below $62,500');
    expect(w.first).toBe('that it falls below $62,500');
    expect(w.second).toBe('that it reaches $64,000');
    expect(w.outcomes.map((o) => o.kind)).toEqual(['win', 'back', 'lose']);
    expect(w.outcomes[1]!.label).toBe('If it reaches $64,000');
  });

  it('a range: two results and no refund line', () => {
    const w = receiptWords({ ...strikes(62500, 64000), product: 'range' });
    expect(w.title).toBe('Finish between $62,500 and $64,000');
    expect(w.first).toBe('that it finishes at or above $62,500');
    expect(w.second).toBe('that it finishes below $64,000');
    expect(w.outcomes.map((o) => o.kind)).toEqual(['win', 'lose']);
  });

  it('a bet recorded before there were other products reads as a rising parlay', () => {
    expect(receiptWords(strikes(1, 2)).first).toBe('that it reaches $2');
  });
});
