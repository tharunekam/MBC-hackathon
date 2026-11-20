import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import HowItWorks from '../components/HowItWorks';

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const app = strip(readFileSync(new URL('./app.css', import.meta.url), 'utf8'));

describe('the landing page scroll fades', () => {
  const start = app.indexOf('@supports (animation-timeline: view())');
  const gated = app.slice(start, app.indexOf('@keyframes fade-in'));

  it('only run where the browser has scroll timelines, and never for reduced motion or ?still', () => {
    expect(start).toBeGreaterThan(-1);
    expect(gated).toContain('@media (prefers-reduced-motion: no-preference)');
    expect(gated).toContain(':root:not([data-still])');
  });

  it('fade in and out without ever leaving a block faint: one fill each, never both', () => {
    expect(gated).toMatch(/animation: fade-in linear backwards, fade-out linear forwards;/);
    expect(gated).not.toMatch(/\bboth\b/);
  });

  it('end in the plain, visible block: the keyframes name only the faint side', () => {
    const frames = app.slice(app.indexOf('@keyframes fade-in'));
    expect(frames).toMatch(/@keyframes fade-in \{\s*from \{\s*opacity: 0;/);
    expect(frames).toMatch(/@keyframes fade-out \{\s*to \{\s*opacity: 0;/);
    expect(frames).not.toMatch(/(?:from|to) \{[^}]*opacity: 1/);
  });

  it('leave the one-time fade-up for browsers without scroll timelines', () => {
    expect(app).toMatch(/\.js \[data-reveal\] \{\s*opacity: 0;/);
  });
});

describe('the How it works pop-up', () => {
  const html = (kind: 'parlay' | 'range' | 'hunch') => renderToStaticMarkup(createElement(HowItWorks, { kind }));

  it('is a button that opens a dialog, not a link to another page', () => {
    for (const kind of ['parlay', 'range', 'hunch'] as const) {
      const said = html(kind);
      expect(said).toContain('<button type="button" class="head-link"');
      expect(said).toContain('<dialog');
      expect(said).not.toContain('href=');
    }
  });

  it('says what each page does in plain words, with no promise and no exchange jargon', () => {
    for (const kind of ['parlay', 'range', 'hunch'] as const) {
      expect(html(kind).replace(/<[^>]+>/g, ' ')).not.toMatch(/guarantee|risk-free|ladder|strike|settle|contract|parlay/i);
    }
    expect(html('parlay')).toContain('How Stake Back works');
    expect(html('range')).toContain('How Range and Breakout work');
  });
});
