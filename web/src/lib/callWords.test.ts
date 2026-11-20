import { describe, expect, it } from 'vitest';
import { booksVerdict, calledWords, countText, edgeText, edgeTone, proofLinkMore, resultWord } from './callWords';
import { edgeText as formatEdgeText } from './format';

const lo = 'GEMI-BTC2611190100-HI62500';
const hi = 'GEMI-BTC2611190100-HI64000';

describe('how a scored call came out', () => {
  it('is Won or Lost, the same two words on every page', () => {
    expect(resultWord(1)).toBe('Won');
    expect(resultWord(0)).toBe('Lost');
  });

  it('a rising Stake Back won by finishing at or above its target, and lost between its two levels', () => {
    expect(calledWords({ betId: 'a1b2c3', condition: lo, target: hi, outcome: 1 })).toBe('The price finished at or above $64,000.');
    expect(calledWords({ betId: 'a1b2c3', condition: lo, target: hi, outcome: 0 })).toBe('The price finished at or above $62,500 but below $64,000.');
  });

  it('a falling Stake Back is the mirror: its first level is the higher one', () => {
    expect(calledWords({ betId: 'dn-a1b2c3', condition: hi, target: lo, outcome: 1 })).toBe('The price finished below $62,500.');
    expect(calledWords({ betId: 'dn-a1b2c3', condition: hi, target: lo, outcome: 0 })).toBe('The price finished below $64,000 but at or above $62,500.');
  });

  it('a Range wins between its two levels', () => {
    expect(calledWords({ betId: 'rg-a1b2c3', condition: lo, target: hi, outcome: 1 })).toBe('The price finished between $62,500 and $64,000.');
    expect(calledWords({ betId: 'rg-a1b2c3', condition: lo, target: hi, outcome: 0 })).toBe('The price finished below $62,500 or above $64,000.');
  });

  it('a Breakout is the Range the other way round: the same finish is a win on one and a loss on the other', () => {
    expect(calledWords({ betId: 'bo-a1b2c3', condition: lo, target: hi, outcome: 1 })).toBe('The price finished below $62,500 or above $64,000.');
    expect(calledWords({ betId: 'bo-a1b2c3', condition: lo, target: hi, outcome: 0 })).toBe('The price finished between $62,500 and $64,000.');
  });

  it('says nothing about the finish when a symbol carries no level, and never uses the old lead-ins', () => {
    expect(calledWords({ betId: 'rg-a1b2c3', condition: 'SOMETHING-ELSE', target: hi, outcome: 1 })).toBe('');
    expect(calledWords({ betId: 'a1b2c3', condition: lo, target: 'SOMETHING-ELSE', outcome: 0 })).toBe('');
    for (const o of [0, 1] as const) expect(calledWords({ betId: 'a1b2c3', condition: lo, target: hi, outcome: o })).not.toMatch(/Called it|Missed/);
  });
});

describe('how an edge is written', () => {
  it('is the one formatter in format.ts, not a second copy', () => {
    expect(edgeText).toBe(formatEdgeText);
  });

  it('has an explicit sign, two decimals and the true minus', () => {
    expect(edgeText(0.589)).toBe('+0.59');
    expect(edgeText(-0.41)).toBe('−0.41');
  });

  it('rounds before it chooses a sign, so a value that rounds to zero has none', () => {
    expect(edgeText(0.004)).toBe('0.00');
    expect(edgeText(-0.004)).toBe('0.00');
    expect(edgeText(-0)).toBe('0.00');
    expect(edgeText(0.1 + 0.2 - 0.3)).toBe('0.00');
    expect(edgeText(-0.006)).toBe('−0.01');
  });

  it('keeps a big sum whole and shows a dash where there is no number', () => {
    expect(edgeText(1234.567)).toMatch(/^\+1,?234\.57$/);
    expect(edgeText(-12345.6)).toMatch(/^−12,?345\.60$/);
    expect(edgeText(NaN)).toBe('–');
    expect(edgeText(Infinity)).toBe('–');
  });

  it('is green above zero, red below it, and plain at zero, from the rounded value', () => {
    expect(edgeTone(0.31)).toBe('good');
    expect(edgeTone(-0.31)).toBe('bad');
    expect(edgeTone(-0.004)).toBe('');
    expect(edgeTone(NaN)).toBe('');
  });

  it('counts with separators', () => {
    expect(countText(1284)).toBe('1,284');
    expect(countText(1500)).toBe('1,500');
    expect(countText(12)).toBe('12');
    expect(countText(NaN)).toBe('–');
  });
});

describe('the words a screen reader gets for a proof link and for the books check', () => {
  it('two calls on one market get different link names, with no stray colon or space before it', () => {
    const won = `Proof page${proofLinkMore('Won', 'Range', 'Ethereum · closes today 8 AM')}`;
    const lost = `Proof page${proofLinkMore('Lost', 'Stake Back up', 'Ethereum · closes today 8 AM')}`;
    expect(won).toBe('Proof page for the Won Range on Ethereum, closes today 8 AM');
    expect(lost).not.toBe(won);
    expect(won).not.toMatch(/\s:|:\s*$/);
  });
  it('a call with no market line still says which call it is', () => {
    expect(proofLinkMore('Lost', 'Breakout', null)).toBe(' for the Lost Breakout');
  });
  it('says whether the books match, once, in one sentence', () => {
    expect(booksVerdict(true, 'the exchange')).toBe('The books match the exchange.');
    expect(booksVerdict(false, 'demo data')).toBe('The books do not match demo data.');
  });
});
