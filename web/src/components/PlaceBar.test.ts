import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PlaceBar from './PlaceBar';

describe('the place bar of a phone', () => {
  const html = (chance: string | null) => renderToStaticMarkup(createElement(PlaceBar, { chance, children: createElement('button', { className: 'btn btn-primary btn-wide' }, 'Place bet · $10.00') }));

  it('shows the chance of winning beside the one Place bet button', () => {
    const said = html('37%');
    expect(said).toContain('Chance of winning');
    expect(said).toContain('37%');
    expect((said.match(/btn-primary/g) ?? []).length).toBe(1);
    expect(said).toContain('Place bet · $10.00');
  });

  it('shows a dash, never NaN or a blank, while there is no chance yet', () => {
    expect(html(null)).toContain('<b>–</b>');
  });

  it('has its own class, apart from the Basket’s bar', () => {
    expect(html('37%')).toContain('class="bet-bar"');
    expect(html('37%')).not.toContain('place-bar');
  });
});
