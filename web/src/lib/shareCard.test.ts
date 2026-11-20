import { describe, expect, it } from 'vitest';
import { CARD_COLORS, CARD_HEIGHT, CARD_WIDTH, shareCardSvg, splitLink, wrap } from './shareCard';
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
  onSolana: true,
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

describe('the picture of a call that is not on Solana', () => {
  it('claims no seal and offers nothing to check: it says only that Given recorded it', () => {
    const svg = shareCardSvg(card({ onSolana: false }));
    expect(svg).toContain('Recorded by Given, not on Solana:');
    for (const claim of ['Sealed', 'Check it yourself', 'Recorded on Solana']) expect(svg).not.toContain(claim);
    expect(svg).toContain('given.example.com/verify/5P8xNpVvQmRt');
  });
});

describe('the picture of a call', () => {
  it('is a link-preview-sized SVG that says who, what, the numbers and where to check', () => {
    const svg = shareCardSvg(card());
    expect(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}"`)).toBe(true);
    expect(wellFormed(svg)).toBe(true);
    for (const text of ['SWIFT-FINCH-33', '>Won<', 'Given BTC at $61,500 or above,', 'Fair price per $1', 'You paid per $1', 'Edge per $1', '41¢', '44¢', '+0.59', 'Nov 18, 2026', 'given.example.com/verify/5P8xNpVvQmRt', 'Sealed on Solana before it was revealed']) {
      expect(svg).toContain(text);
    }
  });

  it('a lost call says so, in the losing colour, and uses the same two result words as the app', () => {
    const svg = shareCardSvg(card({ won: false, edge: '−0.16', edgeGood: false }));
    expect(svg).toContain('>Lost<');
    expect(svg).not.toContain('>Won<');
    for (const old of ['Called it', 'Missed', 'Fell short', 'Target reached']) expect(svg).not.toContain(old);
    expect(svg).not.toContain(CARD_COLORS.good);
  });

  it('wears the app: its dark surfaces, its amber, a system sans-serif stack, and no serif or test label', () => {
    const svg = shareCardSvg(card());
    for (const color of [CARD_COLORS.page, CARD_COLORS.card, CARD_COLORS.accent]) expect(svg).toContain(color);
    expect(svg).not.toMatch(/Georgia|serif'|monospace.*Result/);
    expect(svg).not.toMatch(/#f5f1e8|#fffdf7/i);
    expect(svg).toContain('letter-spacing="5.3"');
    expect(svg).toContain('>GIVEN<');
    expect(svg).not.toMatch(/devnet|Test chain|test/i);
  });

  it('only says it is on Solana when it is, and never claims a record that is not there', () => {
    const on = shareCardSvg(card({ onSolana: true }));
    expect(on).toContain('Recorded on Solana');
    expect(on).toContain('Sealed on Solana before it was revealed');
    const off = shareCardSvg(card({ onSolana: false }));
    // Without a record it says only what is true, in so many words, and claims no seal.
    expect(off).not.toContain('Recorded on Solana');
    expect(off).not.toContain('Committed');
    expect(off).not.toContain('Sealed');
    expect(off).toContain('Recorded by Given, not on Solana');
    expect(off).toContain('Nov 18, 2026');
    // The picture says what the proof page checks, and the proof page cannot check the result.
    expect(on).not.toMatch(/before the result/);
    expect(off).not.toMatch(/before the result/);
  });

  it('prints the whole link, so the address in the picture opens the proof', () => {
    const signature = '5'.repeat(88);
    const svg = shareCardSvg(card({ link: `given.example.com/verify/${signature}` }));
    const printed = [...svg.matchAll(/font-family="ui-monospace[^"]*" font-size="20" fill="#ffd166">([^<]*)</g)].map((m) => m[1]).join('');
    expect(printed).toBe(`given.example.com/verify/${signature}`);
    expect(svg).not.toContain('…');
    // and everything fits above the bottom edge of the card
    const lastY = Math.max(...[...svg.matchAll(/ y="(\d+)" font-family="ui-monospace/g)].map((m) => Number(m[1])));
    expect(lastY).toBeLessThan(584);
  });

  it('a Range and a Breakout say their own question', () => {
    const range = shareCardSvg(card({ question: 'Will BTC finish between $61,500 and $62,500?' }));
    expect(range).toContain('Will BTC finish between $61,500 and $62,500?');
    const breakout = shareCardSvg(card({ won: false, question: 'Will Ethereum finish outside $1,780 to $1,820?', edge: '−0.37', edgeGood: false }));
    expect(breakout).toContain('Will Ethereum finish outside $1,780 to $1,820?');
    expect(breakout).not.toContain('…');
  });

  it('text that came from outside cannot break out of the picture', () => {
    const svg = shareCardSvg(card({ handle: '<script>x</script>', question: 'Given "A&B" at <1 or above, will it reach \'2\'?', link: 'evil"/><image href="x' }));
    expect(wellFormed(svg)).toBe(true);
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<image');
    expect(svg).toContain('&lt;SCRIPT&gt;');
    expect(svg).toContain('&quot;A&amp;B&quot;');
  });

  it('a question takes one or two lines, centred in its band, and the numbers sit at the same height either way', () => {
    const questionLines = (svg: string) => [...svg.matchAll(/font-size="38"/g)].length;
    const labelY = (svg: string) => Number(/y="(\d+)"[^>]*>Fair price per \$1/.exec(svg)![1]);
    const firstY = (svg: string) => Number(/y="(\d+)"[^>]*font-size="38"/.exec(svg)![1]);
    const one = shareCardSvg(card({ question: 'Will BTC reach $62,500?' }));
    const two = shareCardSvg(card());
    const long = shareCardSvg(card({ question: 'Given Natural Gas at $3.525 or above, will it reach $3.625 by the close of the very long named event on November 30?' }));
    expect(questionLines(one)).toBe(1);
    expect(questionLines(two)).toBe(2);
    expect(questionLines(long)).toBe(2);
    expect(long).toContain('…');
    expect(two).not.toContain('…');
    expect(labelY(one)).toBe(labelY(two));
    expect(labelY(two)).toBe(labelY(long));
    // a single line sits lower than the first of two, and the last line always stays above the numbers
    expect(firstY(one)).toBeGreaterThan(firstY(two));
    for (const svg of [one, two, long]) expect(firstY(svg) + (questionLines(svg) - 1) * 48).toBeLessThan(labelY(svg) - 24);
  });
});

describe('fitting text', () => {
  it('wraps at spaces and keeps a long word whole', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrap('supercalifragilistic word', 5)).toEqual(['supercalifragilistic', 'word']);
    expect(wrap('   ', 10)).toEqual([]);
  });

  it('splits an address into lines that put back together as the same address', () => {
    expect(splitLink('a.com/verify/abc')).toEqual(['a.com/verify/abc']);
    const long = `given.example.com/verify/${'5'.repeat(88)}`;
    const parts = splitLink(long);
    expect(parts.join('')).toBe(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(74);
  });
});
