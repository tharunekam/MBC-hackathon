import { describe, expect, it } from 'vitest';
import { CARD_HEIGHT, CARD_WIDTH, fitLink, shareCardSvg, wrap } from './shareCard';
import type { ShareCard } from './shareCard';

const card = (over: Partial<ShareCard> = {}): ShareCard => ({
  handle: 'swift-finch-33',
  won: true,
  question: 'Given BTC at $61,500 or above, will it reach $62,500?',
  fair: '41¢',
  paid: '44¢',
  edge: '+0.59',
  edgeGood: true,
  when: 'Nov 18, 2026',
  network: 'Solana devnet',
  link: 'given.example.com/verify/5P8xNpVvQmRt',
  ...over,
});

/** Every tag that opens also closes, in order: enough to know the picture will load as an image. */
function wellFormed(svg: string): boolean {
  const open: string[] = [];
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z]+)\b[^>]*?(\/?)>/g)) {
    if (m[3] === '/') continue;
    if (m[1] === '/') {
      if (open.pop() !== m[2]) return false;
    } else open.push(m[2]!);
  }
  return open.length === 0;
}

describe('the picture of a call', () => {
  it('is a link-preview-sized SVG that says who, what, the numbers and where to check', () => {
    const svg = shareCardSvg(card());
    expect(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}"`)).toBe(true);
    expect(wellFormed(svg)).toBe(true);
    for (const text of ['SWIFT-FINCH-33', 'Called it', 'Given BTC at $61,500 or above,', '41¢', '44¢', 'Target reached', '+0.59', 'Solana devnet', 'Nov 18, 2026', 'given.example.com/verify/5P8xNpVvQmRt', 'Committed on Solana before the result']) {
      expect(svg).toContain(text);
    }
  });

  it('a missed call says so, in the losing colour, and never dresses it up', () => {
    const svg = shareCardSvg(card({ won: false, edge: '−0.16', edgeGood: false }));
    expect(svg).toContain('Missed');
    expect(svg).toContain('Fell short');
    expect(svg).not.toContain('Called it');
    expect(svg).not.toContain('Target reached');
    expect(svg).not.toContain('#1e6c43');
  });

  it('nothing shares the footer line with the link, so a long link cannot run into anything', () => {
    const svg = shareCardSvg(card({ link: `given.example.com/verify/${'5'.repeat(88)}` }));
    expect([...svg.matchAll(/ y="562"/g)]).toHaveLength(1);
    expect(svg).toContain('Solana devnet · Nov 18, 2026');
  });

  it('a range says what the page says: its own question and inside or outside', () => {
    const svg = shareCardSvg(card({ question: 'Will BTC finish between $61,500 and $62,500?', result: 'Finished inside' }));
    expect(svg).toContain('Will BTC finish between $61,500 and');
    expect(svg).toContain('Finished inside');
    expect(svg).not.toContain('Target reached');
    const missed = shareCardSvg(card({ won: false, question: 'Will BTC finish between $61,500 and $62,500?', result: 'Finished outside', edge: '−0.40', edgeGood: false }));
    expect(missed).toContain('Finished outside');
    expect(missed).not.toContain('Fell short');
  });

  it('a call on the test chain is labelled as one', () => {
    expect(shareCardSvg(card({ network: 'Test chain' }))).toContain('Test chain');
    expect(shareCardSvg(card({ network: 'Test chain' }))).not.toContain('Solana devnet');
  });

  it('text that came from outside cannot break out of the picture', () => {
    const svg = shareCardSvg(card({ handle: '<script>x</script>', question: 'Given "A&B" at <1 or above, will it reach \'2\'?', link: 'evil"/><image href="x' }));
    expect(wellFormed(svg)).toBe(true);
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<image');
    expect(svg).toContain('&lt;SCRIPT&gt;');
    expect(svg).toContain('&quot;A&amp;B&quot;');
  });

  it('a question takes one or two lines, the numbers follow it, and nothing reaches the footer', () => {
    const lines = (svg: string) => [...svg.matchAll(/font-size="44"/g)].length;
    const labelY = (svg: string) => Number(/y="(\d+)"[^>]*>Fair price at the time/.exec(svg)![1]);
    const one = shareCardSvg(card({ question: 'Will BTC reach $62,500?' }));
    const two = shareCardSvg(card());
    const long = shareCardSvg(card({ question: 'Given Natural Gas at $3.525 or above, will it reach $3.625 by the close of the very long named event on November 30?' }));
    expect(lines(one)).toBe(1);
    expect(lines(two)).toBe(2);
    expect(lines(long)).toBe(2);
    expect(long).toContain('…');
    expect(two).not.toContain('…');
    expect(labelY(two)).toBeGreaterThan(labelY(one));
    // the value sits 44 below its label; the footer line is at 528
    for (const svg of [one, two, long]) expect(labelY(svg) + 44).toBeLessThan(520);
  });
});

describe('fitting text', () => {
  it('wraps at spaces and keeps a long word whole', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrap('supercalifragilistic word', 5)).toEqual(['supercalifragilistic', 'word']);
    expect(wrap('   ', 10)).toEqual([]);
  });

  it('shortens a long link but leaves a short one alone', () => {
    expect(fitLink('a.com/verify/abc')).toBe('a.com/verify/abc');
    const long = `given.example.com/verify/${'5'.repeat(88)}`;
    expect(fitLink(long)).toHaveLength(56);
    expect(fitLink(long).startsWith('given.example.com/verify/555')).toBe(true);
    expect(fitLink(long).endsWith('…')).toBe(true);
  });
});
