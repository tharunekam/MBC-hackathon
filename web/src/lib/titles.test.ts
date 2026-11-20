import { describe, expect, it } from 'vitest';
import { titleFor } from './titles';

describe('page titles', () => {
  it('names each page, then the site', () => {
    expect(titleFor('/parlay')).toBe('Stake Back · Given');
    expect(titleFor('/range')).toBe('Range and Breakout · Given');
    expect(titleFor('/hunch')).toBe('Hunch · Given');
    expect(titleFor('/bets/')).toBe('My bets · Given');
    expect(titleFor('/verify/5fE6B5sFabc')).toBe('Proof of a call · Given');
  });

  it('keeps the site line for the landing page, and says so for an address it does not know', () => {
    expect(titleFor('/')).toBe("Given – money back if it doesn't happen");
    expect(titleFor('')).toBe("Given – money back if it doesn't happen");
    expect(titleFor('/nowhere')).toBe('Page not found · Given');
    expect(titleFor('/parlayx')).toBe('Page not found · Given');
  });

  it('reads an old address as the page it is sent on to', () => {
    expect(titleFor('/app')).toBe('Stake Back · Given');
    expect(titleFor('/app/bets')).toBe('My bets · Given');
  });
});
