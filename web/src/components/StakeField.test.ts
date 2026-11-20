import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import StakeField, { NOT_AN_AMOUNT, stakeSaid } from './StakeField';

describe('a wrong stake is announced, not only drawn', () => {
  it('says that what was typed is not an amount', () => {
    expect(stakeSaid(true, false, 'Up to $25 a bet here.')).toBe(NOT_AN_AMOUNT);
  });

  it('says what the most is when the stake is over it, and nothing when it is fine', () => {
    expect(stakeSaid(false, true, 'Up to $25 a bet here.')).toBe('Up to $25 a bet here.');
    expect(stakeSaid(false, false, 'Up to $25 a bet here.')).toBe('');
    // A note that is not plain text (a node) is never read out as a refusal.
    expect(stakeSaid(false, true, createElement('b', null, 'x'))).toBe('');
  });

  it('keeps a status region on the page from the first draw, because a paragraph added later is not read out', () => {
    const html = renderToStaticMarkup(createElement(StakeField, { id: 'stake', text: '10', stake: 10, onText: () => {}, note: 'Up to $25 a bet here.' }));
    expect(html).toMatch(/<p class="sr-only" role="status"><\/p>/);
  });
});
