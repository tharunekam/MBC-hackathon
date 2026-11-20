import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it } from 'vitest';
import ErrorBoundary, { PageProblem, isChunkError, needsReload } from './ErrorBoundary';

describe('a page that fails to draw does not take the app with it', () => {
  it('the boundary turns a thrown error into its own state, and draws the page as normal until then', () => {
    expect(ErrorBoundary.getDerivedStateFromError(new Error('boom'))).toMatchObject({ failed: true });
    const html = renderToStaticMarkup(createElement(ErrorBoundary, null, createElement('p', null, 'The page')));
    expect(html).toBe('<p>The page</p>');
  });

  it('the replacement says one plain thing and offers a way back, and prints nothing from the error', () => {
    const html = renderToStaticMarkup(
      createElement(StaticRouter, { location: '/bets' }, createElement(PageProblem, { error: new Error('Cannot read properties of undefined (reading legs)'), onRetry: () => {} })),
    );
    expect(html).toContain('Something went wrong');
    expect(html).toContain('This page could not be shown.');
    expect(html).toContain('Try again');
    expect(html).toContain('href="/parlay"');
    expect(html).toContain('href="/bets"');
    expect(html).not.toMatch(/undefined|legs|TypeError/);
  });

  it('a page that failed once and was redrawn is reloaded the second time, and so is one whose code failed to download', () => {
    const odd = new TypeError("Cannot read properties of undefined (reading 'legs')");
    expect(needsReload(odd, false)).toBe(false);
    expect(needsReload(odd, true)).toBe(true);
    expect(needsReload(new Error('Loading chunk 7 failed.'), false)).toBe(true);
  });

  it('recognises a page whose code failed to download, which only a reload can fix', () => {
    expect(isChunkError(new TypeError('Failed to fetch dynamically imported module: /assets/Bets-abc.js'))).toBe(true);
    expect(isChunkError(new Error('Loading chunk 7 failed.'))).toBe(true);
    expect(isChunkError(new TypeError("Cannot read properties of undefined (reading 'legs')"))).toBe(false);
    expect(isChunkError(null)).toBe(false);
  });
});
