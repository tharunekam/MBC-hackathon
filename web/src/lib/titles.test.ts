import { describe, expect, it } from 'vitest';
import { titleFor } from './titles';

describe('page titles', () => {
  it('names each page, then the site', () => {
    expect(titleFor('/parlay')).toBe('Stake Back · Stakeback');
    expect(titleFor('/range')).toBe('Range and Breakout · Stakeback');
    expect(titleFor('/hunch')).toBe('Hunch · Stakeback');
    expect(titleFor('/bets/')).toBe('My bets · Stakeback');
    expect(titleFor('/verify/5fE6B5sFabc')).toBe('Proof of a call · Stakeback');
  });

  it('keeps the site line for the landing page, and says so for an address it does not know', () => {
    expect(titleFor('/')).toBe("Stakeback – money back if it doesn't happen");
    expect(titleFor('')).toBe("Stakeback – money back if it doesn't happen");
    expect(titleFor('/nowhere')).toBe('Page not found · Stakeback');
    expect(titleFor('/parlayx')).toBe('Page not found · Stakeback');
  });

  it('the landing title is the one in index.html, so the tab does not change when the app starts', () => {
    // The page is served with this title and the app sets the same one on arrival: no flicker, and no second name for the site.
    expect(titleFor('/')).toBe("Stakeback – money back if it doesn't happen");
  });

  it('every other page uses the same separator, a middle dot', () => {
    for (const path of ['/parlay', '/range', '/basket', '/hunch', '/markets', '/bets', '/leaderboard', '/proof', '/verify/abc', '/nowhere']) {
      expect(titleFor(path)).toMatch(/^[^·–—-]+ · [^·–—]+$/);
    }
  });

  it('the Range page is named for both bets it holds, whichever side its switch is on', () => {
    expect(titleFor('/range')).toBe('Range and Breakout · Stakeback');
    expect(titleFor('/Range/')).toBe('Range and Breakout · Stakeback');
  });

  it('reads an old address as the page it is sent on to', () => {
    expect(titleFor('/app')).toBe('Stake Back · Stakeback');
    expect(titleFor('/app/bets')).toBe('My bets · Stakeback');
  });

  it('follows the router, which ignores case and knows no page below these', () => {
    expect(titleFor('/Markets')).toBe('Markets · Stakeback');
    expect(titleFor('/BETS/')).toBe('My bets · Stakeback');
    expect(titleFor('/VERIFY/AbC')).toBe('Proof of a call · Stakeback');
    expect(titleFor('/verify')).toBe('Page not found · Stakeback');
    expect(titleFor('/verify/')).toBe('Page not found · Stakeback');
    expect(titleFor('/verify/abc/extra')).toBe('Page not found · Stakeback');
    expect(titleFor('/parlay/extra')).toBe('Page not found · Stakeback');
  });
});
