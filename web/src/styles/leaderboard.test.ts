import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = strip(readFileSync(new URL('./tokens.css', import.meta.url), 'utf8'));
const board = strip(readFileSync(new URL('./leaderboard.css', import.meta.url), 'utf8'));

/** The `--name: value` lines of the block that opens with `opener`. */
function block(opener: string): Record<string, string> {
  const start = tokens.indexOf(opener);
  const body = tokens.slice(tokens.indexOf('{', start) + 1, tokens.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[name!] = value!.trim();
  return out;
}

const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = ([r, g, b]: number[]): number => {
  const [x, y, z] = [r!, g!, b!].map((v) => ((v / 255) <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * x + 0.7152 * y + 0.0722 * z;
};
const ratio = (a: number[], b: number[]): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** `rgba(255, 209, 102, 0.16)` laid over an opaque colour. */
function over(soft: string, ground: number[]): number[] {
  const [r, g, b, a] = soft.match(/[\d.]+/g)!.map(Number) as [number, number, number, number];
  return [r, g, b].map((c, i) => c * a + ground[i]! * (1 - a));
}

describe("the leaderboard's own row (the amber tint)", () => {
  const themes: [string, Record<string, string>][] = [
    ['light', block(':root {')],
    ['dark', { ...block(':root {'), ...block(":root[data-theme='dark']") }],
  ];

  // The quiet text of the row: its rank, its time, the "of N sealed" line and the "You" tag.
  const rule = /(\.lb tr\.is-you \.lb-rank,[^{]*)\{([^}]*)\}/.exec(board);

  it('gives that quiet text its own colour, not the muted grey the tint swallows', () => {
    expect(rule, 'a rule for the quiet text of the row').not.toBeNull();
    for (const part of ['.lb-rank', 'td.lb-when', 'td.lb-sealed', '.lb-who[data-tag]::before']) expect(rule![1], part).toContain(part);
    expect(rule![2]).toMatch(/color:\s*var\(--soft\)/);
  });

  for (const [name, t] of themes) {
    it(`${name}: that text is 4.5:1 or better on the tinted row`, () => {
      const row = over(t['--accent-soft']!, rgb(t['--surface']!));
      expect(ratio(rgb(t['--soft']!), row)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
