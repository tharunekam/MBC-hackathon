import { describe, expect, it } from 'vitest';
import { rangeComesBack, receiptWords } from './receiptWords';

const strikes = (c: number, t: number) => ({ condition: { symbol: 'c', label: 'c', strike: c }, target: { symbol: 't', label: 't', strike: t } });

describe('a placed bet is described in its own words', () => {
  it('a rising parlay: the first order is the bet and the second returns the stake', () => {
    const w = receiptWords({ ...strikes(62500, 64000), product: 'parlay' });
    expect(w.title).toBe('Given $62,500 or above, reach $64,000');
    expect(w.first).toBe('that it reaches $64,000');
    expect(w.second).toBe('that it falls below $62,500');
    expect(w.outcomes.map((o) => o.kind)).toEqual(['win', 'back', 'lose']);
    expect(w.outcomes[2]!.label).toBe('If it holds $62,500 but stops short');
    expect(w.secondWhy).toBe('This order pays your stake back if the first level fails.');
  });

  it('a falling parlay: the same shape the other way up', () => {
    const w = receiptWords({ ...strikes(64000, 62500), product: 'parlay', direction: 'down' });
    expect(w.title).toBe('Given it stays under $64,000, fall below $62,500');
    expect(w.first).toBe('that it falls below $62,500');
    expect(w.second).toBe('that it reaches $64,000');
    expect(w.outcomes.map((o) => o.kind)).toEqual(['win', 'back', 'lose']);
    expect(w.outcomes[1]!.label).toBe('If it reaches $64,000');
    expect(w.outcomes[2]!.label).toBe('If it stays under $64,000 but does not fall below $62,500');
  });

  it('a falling parlay always "stays under" its first level and "falls below" its target, never "stays below" or "given below"', () => {
    const said = JSON.stringify(receiptWords({ ...strikes(64000, 62500), product: 'parlay', direction: 'down' }));
    expect(said).not.toMatch(/stays below|given below/i);
    expect(said).toMatch(/stays under \$64,000/);
    expect(said).toMatch(/falls? below \$62,500/);
  });

  it('calls a parlay’s two prices the first level and the target, never a condition, a leg, a part or a pair', () => {
    for (const direction of ['up', 'down'] as const) {
      expect(JSON.stringify(receiptWords({ ...strikes(62500, 64000), product: 'parlay', direction }))).not.toMatch(/condition|\bleg\b|\bpart\b|\bpair\b|refund/i);
    }
  });

  it('a range: two results and no refund line', () => {
    const w = receiptWords({ ...strikes(62500, 64000), product: 'range' });
    expect(w.title).toBe('Finish between $62,500 and $64,000');
    expect(w.first).toBe('that it finishes at or above $62,500');
    expect(w.second).toBe('that it finishes below $64,000');
    expect(w.outcomes.map((o) => o.kind)).toEqual(['win', 'lose']);
    expect(w.secondWhy).toBe('Between the two levels both orders pay; outside them only one does.');
  });

  it('what comes back on a range is said as the mechanism, never as a promise', () => {
    expect(rangeComesBack('$6.84')).toBe('At least one of the two orders pays $1 a contract at settlement, so $6.84 of what you pay comes back either way.');
    expect(rangeComesBack('$6.84', true)).toBe('At least one of the two orders pays $1 a contract at settlement, so $6.84 of what you paid comes back either way.');
    const range = JSON.stringify(receiptWords({ ...strikes(62500, 64000), product: 'range' }));
    for (const said of [rangeComesBack('$6.84'), range]) expect(said).not.toMatch(/whatever happens|guarantee|risk-free|always/i);
  });

  it('a breakout: the first order is on the higher strike, the second on the lower, and there is no refund line', () => {
    const w = receiptWords({ ...strikes(62500, 64000), product: 'breakout' });
    expect(w.title).toBe('Finish outside $62,500 to $64,000');
    expect(w.first).toBe('that it finishes at or above $64,000');
    expect(w.second).toBe('that it finishes below $62,500');
    expect(w.secondWhy).toMatch(/Only one of the two orders can pay/);
    expect(w.outcomes).toEqual([
      { kind: 'win', label: 'If it finishes below $62,500, or at $64,000 or above' },
      { kind: 'lose', label: 'If it finishes between them' },
    ]);
    // Nothing about a breakout comes back whatever happens, and the words must not say so.
    expect(JSON.stringify(w)).not.toMatch(/always|whatever happens|stake back/i);
  });

  it('a bet recorded before there were other products reads as a rising parlay', () => {
    expect(receiptWords(strikes(1, 2)).first).toBe('that it reaches $2');
  });
});
