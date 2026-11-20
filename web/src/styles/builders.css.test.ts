import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const app = read('app.css');
const builder = read('builder.css');
const dist = read('dist.css');
const markets = read('markets.css');
const header = read('header.css');

/** The declarations of the first rule whose selector list is exactly `selector`, or null. */
function rule(css: string, selector: string): string | null {
  const at = css.split('\n').findIndex((l) => l.trim().replace(/\s*\{$/, '').replace(/,$/, '') === selector && /[{,]\s*$/.test(l));
  if (at < 0) return null;
  const rest = css.split('\n').slice(at).join('\n');
  return rest.slice(rest.indexOf('{') + 1, rest.indexOf('}'));
}

describe('the chart means what the rest of the app means by its colours', () => {
  it('a win stretch is green and a lose stretch is red, and neither is amber', () => {
    expect(rule(app, ".lc-window[data-zone='win']")).toMatch(/var\(--good\)/);
    expect(rule(app, ".lc-window[data-zone='lose']")).toMatch(/var\(--bad\)/);
    for (const r of [rule(app, ".lc-window[data-zone='win']"), rule(app, ".lc-window[data-zone='lose']")]) expect(r).not.toMatch(/accent/);
  });

  it('there is no stretch rule left that is amber by default', () => {
    expect(rule(app, '.lc-window')).toBeNull();
  });

  it('the legend swatches are the same two colours', () => {
    expect(rule(app, '.lg-win')).toMatch(/var\(--good\)/);
    expect(rule(app, '.lg-lose')).toMatch(/var\(--bad\)/);
  });

  it('both marker pills are amber, whichever marker they name', () => {
    expect(rule(app, '.lc-pill rect')).toMatch(/var\(--accent\)/);
    expect(app).not.toMatch(/lc-pill\[data-kind/);
  });
});

describe('a chosen segment, chip or filter reads as chosen without its amber fill', () => {
  it('the switch, the quick amounts and the market filter each get an ink edge when chosen', () => {
    expect(rule(builder, '.switch button.is-on')).toMatch(/border-color:\s*var\(--ink\)/);
    expect(rule(builder, '.builder .presets .chip.is-on')).toMatch(/border-color:\s*var\(--ink\)/);
    expect(rule(markets, ".mk-seg button[aria-pressed='true']")).toMatch(/border-color:\s*var\(--ink\)/);
  });

  it('the edge is always there, transparent when not chosen, so choosing moves nothing by a pixel', () => {
    expect(rule(builder, '.switch button')).toMatch(/border:\s*1px solid transparent/);
    expect(rule(builder, '.builder .presets .chip')).toMatch(/border:\s*1px solid transparent/);
    expect(rule(markets, '.mk-seg button')).toMatch(/border:\s*1px solid transparent/);
  });

  it('the chosen phone tab has a rule along its edge as well as its pale fill', () => {
    expect(rule(app, '.tabbar a.is-on::before')).toMatch(/background:\s*var\(--ink\)/);
  });
});

describe('the phone tab bar and the header', () => {
  it('every tab is as wide as its own name, so "Stake Back" is never cut to "Stake"', () => {
    expect(rule(app, '.tabbar a')).toMatch(/flex:\s*1 1 auto/);
    expect(app).not.toMatch(/tab-short/);
  });

  it('are solid, so a chart scrolling under them does not show through as a blur', () => {
    expect(rule(app, '.tabbar')).not.toMatch(/backdrop-filter/);
    expect(rule(header, '.nav::before')).not.toMatch(/backdrop-filter/);
    expect(rule(header, '.nav::before')).toMatch(/background:\s*var\(--bg\);/);
  });
});

describe('the rest of the builders', () => {
  it('the ticket is one column that may shrink, so a receipt cannot be wider than its card at 320px', () => {
    expect(rule(builder, '.builder .quote-card')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  });

  it('a form field has an edge of 3:1, half the ink, not the hairline', () => {
    expect(rule(app, '.field')).toMatch(/border:\s*1px solid color-mix\(in srgb, var\(--ink\) 50%/);
  });

  it('the place bar is its own, so the Basket keeps its own', () => {
    expect(rule(builder, '.builder .bet-bar')).toMatch(/position:\s*sticky/);
    expect(builder).not.toMatch(/\.place-bar/);
  });

  it('the Hunch dials have a hairline track and an amber thumb, not the heavy native bar', () => {
    expect(rule(dist, ".hunch-dial input[type='range']")).toMatch(/appearance:\s*none/);
    expect(rule(dist, ".hunch-dial input[type='range']::-webkit-slider-runnable-track")).toMatch(/height:\s*2px/);
    expect(rule(dist, ".hunch-dial input[type='range']::-webkit-slider-thumb")).toMatch(/background:\s*var\(--accent\)/);
    expect(rule(dist, ".hunch-dial input[type='range']::-moz-range-thumb")).toMatch(/background:\s*var\(--accent\)/);
    expect(dist).not.toMatch(/accent-color/);
  });

  it('the level numbers on a Hunch card are ink, not amber', () => {
    expect(rule(dist, '.hunch-idea h3 em')).toMatch(/color:\s*var\(--ink\)/);
  });

  it('the Hunch chart stays in view beside a long list', () => {
    expect(dist).toMatch(/\.hunch \.left-col\s*\{[^}]*position:\s*sticky/);
  });
});
