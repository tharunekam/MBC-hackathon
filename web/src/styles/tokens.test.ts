import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The `--name: value` lines of the block that opens with `opener`. */
function block(opener: string): Record<string, string> {
  const start = css.indexOf(opener);
  expect(start, `${opener} is in tokens.css`).toBeGreaterThan(-1);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[name!] = value!.trim();
  return out;
}

const light = block(':root {');
const dark = block(":root[data-theme='dark']");
const system = block(":root:not([data-theme='light'])");

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('the dark palette is written twice and stays one palette', () => {
  it('a chosen dark theme and a system that asks for dark carry the same tokens', () => {
    expect(system).toEqual(dark);
  });

  it('every token the dark palette changes exists in the light one', () => {
    for (const name of Object.keys(dark)) expect(light[name], name).toBeDefined();
  });
});

describe('colours a person has to see', () => {
  const themes: [string, Record<string, string>][] = [
    ['light', { ...light }],
    ['dark', { ...light, ...dark }],
  ];
  for (const [name, t] of themes) {
    it(`${name}: the focus ring is 3:1 or better on the page and on a surface`, () => {
      for (const ground of [t['--bg']!, t['--surface']!, t['--bg-2']!]) expect(ratio(t['--focus']!, ground)).toBeGreaterThanOrEqual(3);
    });
    it(`${name}: muted text is 4.5:1 or better, and faint marks are 3:1 or better, on the page and on a surface`, () => {
      for (const ground of [t['--bg']!, t['--surface']!]) {
        expect(ratio(t['--muted']!, ground)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t['--faint']!, ground)).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
