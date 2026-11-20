import { describe, expect, it } from 'vitest';
import { MY_BETS, PRODUCTS, TOOLS } from './nav';
import { titleFor } from './titles';

describe('page titles', () => {
  it('names each page, then the site', () => {
    expect(titleFor('/parlay')).toBe('Stake Back · Given');
    expect(titleFor('/range')).toBe('Range · Given');
    expect(titleFor('/hunch')).toBe('Hunch · Given');
    expect(titleFor('/sketch')).toBe('Sketch · Given');
    expect(titleFor('/bets/')).toBe('My bets · Given');
    expect(titleFor('/verify/5fE6B5sFabc')).toBe('Proof of a call · Given');
  });

  it('has a title for every place the header and the menu link to', () => {
    for (const place of [...PRODUCTS, ...TOOLS, MY_BETS]) expect(titleFor(place.to), place.to).not.toBe('Page not found · Given');
    // Sketch sits with the other tools, straight after Hunch.
    const ids = TOOLS.map((t) => t.id);
    expect(ids.indexOf('sketch')).toBe(ids.indexOf('hunch') + 1);
  });

  it('keeps the site line for the landing page, and says so for an address it does not know', () => {
    expect(titleFor('/')).toBe('Given · Bet the second half');
    expect(titleFor('')).toBe('Given · Bet the second half');
    expect(titleFor('/nowhere')).toBe('Page not found · Given');
    expect(titleFor('/parlayx')).toBe('Page not found · Given');
  });

  it('every title uses the same separator, a middle dot', () => {
    for (const path of ['/', '/parlay', '/range', '/basket', '/hunch', '/markets', '/bets', '/leaderboard', '/proof', '/verify/abc', '/nowhere']) {
      expect(titleFor(path)).toMatch(/^[^·–—-]+ · [^·–—]+$/);
    }
  });

  it('follows the Range page\'s switch: the Breakout side has its own title', () => {
    expect(titleFor('/range', '?side=out')).toBe('Breakout · Given');
    expect(titleFor('/range', '?market=BTC&side=out')).toBe('Breakout · Given');
    expect(titleFor('/range', '?side=in')).toBe('Range · Given');
    expect(titleFor('/range', '')).toBe('Range · Given');
    // Only the Range page has a side.
    expect(titleFor('/parlay', '?side=out')).toBe('Stake Back · Given');
  });

  it('reads an old address as the page it is sent on to', () => {
    expect(titleFor('/app')).toBe('Stake Back · Given');
    expect(titleFor('/app/bets')).toBe('My bets · Given');
  });

  it('follows the router, which ignores case and knows no page below these', () => {
    expect(titleFor('/Markets')).toBe('Markets · Given');
    expect(titleFor('/BETS/')).toBe('My bets · Given');
    expect(titleFor('/VERIFY/AbC')).toBe('Proof of a call · Given');
    expect(titleFor('/verify')).toBe('Page not found · Given');
    expect(titleFor('/verify/')).toBe('Page not found · Given');
    expect(titleFor('/verify/abc/extra')).toBe('Page not found · Given');
    expect(titleFor('/parlay/extra')).toBe('Page not found · Given');
  });
});
