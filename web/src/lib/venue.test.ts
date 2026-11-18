import { describe, expect, it } from 'vitest';
import { describeVenue } from './venue';

describe('the app says what it is talking to', () => {
  it('Gemini\'s sandbox, plainly', () => {
    expect(describeVenue('live', { venue: 'Gemini sandbox' })).toEqual({ chip: null, footnote: 'Practice money on Gemini’s sandbox.', readOnly: false });
  });

  it('a sandbox our own seeder is quoting on is labelled, in the nav and in the footnote', () => {
    const note = describeVenue('live', { venue: 'Gemini sandbox', seeded: true });
    expect(note.chip).toBe('Seeded prices');
    expect(note.footnote).toMatch(/our own test quotes/);
    expect(note.readOnly).toBe(false);
  });

  it('seeding is never claimed anywhere but the sandbox', () => {
    expect(describeVenue('live', { venue: 'Gemini', seeded: true }).chip).toBe(null);
    expect(describeVenue('live', { venue: 'Local test exchange', seeded: true }).chip).toBe('Local test exchange');
  });

  it('quotes only, demo data, a test exchange, and not yet connected', () => {
    expect(describeVenue('live', { venue: 'Gemini sandbox', readOnly: true })).toMatchObject({ chip: 'Quotes only', readOnly: true });
    expect(describeVenue('mock', null).chip).toBe('Demo data');
    expect(describeVenue('live', { venue: 'Local test exchange' }).footnote).toBe('Local test exchange. Not Gemini, and no real orders.');
    expect(describeVenue('live', undefined)).toEqual({ chip: null, footnote: 'Connecting to the exchange.', readOnly: false });
  });
});
