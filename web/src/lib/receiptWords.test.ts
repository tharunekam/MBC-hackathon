import { describe, expect, it } from 'vitest';
import { landingOf, landingWords, orderHeading, rangeComesBack, receiptWords, sharesText } from './receiptWords';

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
    expect(w.outcomes[1]!.label).toBe('If it finishes outside the two levels');
  });

  it('what comes back on a range is said with its numbers, never as a promise', () => {
    expect(rangeComesBack('$6.84', '$10.00')).toBe('At least $6.84 of your $10.00 comes back when the market closes. Where the price finishes decides the rest.');
    const range = JSON.stringify(receiptWords({ ...strikes(62500, 64000), product: 'range' }));
    for (const said of [rangeComesBack('$6.84', '$10.00'), range]) {
      expect(said).not.toMatch(/whatever happens|either way|guarantee|risk-free|always|contract|settle/i);
    }
  });

  it('shares always carry two decimals, and a missing quantity is a dash, not "undefined shares"', () => {
    expect(sharesText(10.2)).toBe('10.20 shares');
    expect(sharesText(21.74)).toBe('21.74 shares');
    expect(sharesText(undefined)).toBe('–');
    expect(sharesText(Number.NaN)).toBe('–');
  });

  it('no product describes its orders with exchange words', () => {
    for (const product of ['parlay', 'range', 'breakout'] as const) {
      for (const direction of ['up', 'down'] as const) {
        expect(JSON.stringify(receiptWords({ ...strikes(62500, 64000), product, direction }))).not.toMatch(/contract|settle|strike|ladder|rung|taker|resting/i);
      }
    }
  });

  it('a breakout: the first order is on the higher strike, the second on the lower, and there is no refund line', () => {
    const w = receiptWords({ ...strikes(62500, 64000), product: 'breakout' });
    expect(w.title).toBe('Finish outside $62,500 to $64,000');
    expect(w.first).toBe('that it finishes at or above $64,000');
    expect(w.second).toBe('that it finishes below $62,500');
    expect(w.secondWhy).toBe('Only one order can pay: it does if the price finishes outside the two levels.');
    expect(w.outcomes).toEqual([
      { kind: 'win', label: 'If it finishes below $62,500, or at $64,000 or above' },
      { kind: 'lose', label: 'If it finishes between the two levels' },
    ]);
    // Nothing about a breakout comes back whatever happens, and the words must not say so.
    expect(JSON.stringify(w)).not.toMatch(/always|whatever happens|stake back/i);
  });

  it('a bet recorded before there were other products reads as a rising parlay', () => {
    expect(receiptWords(strikes(1, 2)).first).toBe('that it reaches $2');
  });
});

describe('what a placement turned into, from the bet the executor answers with', () => {
  const at = (status: string, product?: 'parlay' | 'range' | 'breakout') => ({ status: status as never, ...(product ? { product } : {}), direction: undefined });

  it('only a fully hedged open bet is a placed bet; every other status is told as what it is', () => {
    expect(landingOf({ status: 'open' })).toBe('placed');
    expect(landingOf({ status: 'unhedged' })).toBe('unprotected');
    expect(landingOf({ status: 'unwound' })).toBe('unwound');
    expect(landingOf({ status: 'failed' })).toBe('failed');
    for (const status of ['placing', 'settled', 'needs_review', 'cashed_out'] as const) expect(landingOf({ status })).toBe('unconfirmed');
  });

  it('an unhedged bet whose order the exchange never confirmed is not "half placed": nobody knows what became of the order', () => {
    const unknown = { status: 'unhedged' as const, product: 'parlay' as const, direction: undefined, legs: [{ status: 'filled' }, { status: 'unknown' }] as never };
    expect(landingOf(unknown)).toBe('unconfirmed');
    const w = landingWords(unknown);
    expect(w.eyebrow).toBe('Not confirmed');
    expect(w.lines.join(' ')).toMatch(/did not confirm one of this bet/);
    expect(w.lines.join(' ')).toMatch(/Gemini account/);
    expect(w.paidLabel).toBeNull();
    // A record read back by hand carries only the executor's note, and says the same.
    expect(landingOf({ status: 'unhedged', note: "Gemini did not confirm one of this bet's orders, so the bet may be partly or fully in place." })).toBe('unconfirmed');
    // An unhedged bet whose second order simply did not go through is still half placed.
    expect(landingOf({ status: 'unhedged', legs: [{ status: 'filled' }, { status: 'error' }] as never })).toBe('unprotected');
  });

  it('says "Bet placed" for a placed bet and for nothing else', () => {
    for (const status of ['open', 'unhedged', 'unwound', 'failed', 'placing', 'settled', 'needs_review', 'cashed_out']) {
      const w = landingWords(at(status));
      const said = JSON.stringify(w);
      expect(/Bet placed/.test(said)).toBe(status === 'open');
      expect(/filled|fills|went through/i.test(w.eyebrow)).toBe(false);
    }
  });

  it('a bet that failed says nothing was bought and nothing was spent', () => {
    const w = landingWords(at('failed'));
    expect(w.eyebrow).toBe('Not placed');
    expect(w.lines).toEqual(['Nothing was bought and nothing was spent.', 'The first order did not go through.']);
    expect(w.paidLabel).toBeNull();
  });

  it('a bet that was sold back says the second order could not be placed, and puts what it cost on the money line', () => {
    const w = landingWords(at('unwound'));
    expect(w.eyebrow).toBe('Not placed');
    expect(w.lines).toEqual(['The second order could not be placed, so the first one was sold back.']);
    expect(w.paidLabel).toBe('It cost you');
  });

  it('a bet with only its first order in says what is missing, and how to sell it back, without a word about protection', () => {
    const parlay = landingWords(at('unhedged', 'parlay'));
    expect(parlay.eyebrow).toBe('Half placed');
    expect(parlay.lines[0]).toBe('Only the first order went through, so your stake does not come back if the first level fails.');
    expect(parlay.lines[1]).toBe('You can sell the bet back now in My bets, or leave it open.');
    expect(parlay.paidLabel).toBe('You paid');
    // A Range or a Breakout has no stake-back order: its second order is the other side of the bet.
    expect(landingWords(at('unhedged', 'range')).lines[0]).toBe('Only the first order went through, so only part of this bet is in place.');
    expect(landingWords(at('unhedged', 'breakout')).lines[0]).toBe('Only the first order went through, so only part of this bet is in place.');
    for (const product of ['parlay', 'range', 'breakout'] as const) expect(JSON.stringify(landingWords(at('unhedged', product)))).not.toMatch(/protect/i);
  });

  it('never says an order filled, or promises anything, for a bet that is not placed', () => {
    for (const status of ['unhedged', 'unwound', 'failed', 'placing']) {
      for (const product of ['parlay', 'range', 'breakout'] as const) {
        const said = JSON.stringify(landingWords(at(status, product)));
        expect(said).not.toMatch(/Order \d (filled|went through)|guarantee|risk-free|never lose|whatever happens|contract|settle/i);
      }
    }
  });

  it('names an order by what it really bought, and only a full one is said to have gone through', () => {
    expect(orderHeading(1, { quantityFilled: 10, quantityRequested: 10 })).toBe('Order 1 went through');
    expect(orderHeading(2, { quantityFilled: 0, quantityRequested: 10 })).toBe('Order 2 did not go through');
    expect(orderHeading(2, undefined)).toBe('Order 2 did not go through');
    expect(orderHeading(1, { quantityFilled: 4, quantityRequested: 10 })).toBe('Order 1 went through in part');
    // Share counts that differ by rounding dust are one order.
    expect(orderHeading(1, { quantityFilled: 9.9999999999, quantityRequested: 10 })).toBe('Order 1 went through');
    // No trade jargon in the words a person reads.
    for (const leg of [undefined, { quantityFilled: 4, quantityRequested: 10 }, { quantityFilled: 10, quantityRequested: 10 }]) expect(orderHeading(1, leg)).not.toMatch(/fill/i);
  });
});
