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
    expect(describeVenue('live', { venue: 'Local test exchange', seeded: true }).chip).toBe(null);
  });

  it('a replay says it is one, of what and from when, whatever else the recorded health says', () => {
    const note = describeVenue('live', { venue: 'Gemini sandbox', seeded: true, replay: { recordedAt: '2026-11-19T01:00:00.000Z' } });
    expect(note.chip).toBe('Replay');
    expect(note.footnote).toMatch(/A recording of a real session on Gemini’s sandbox, made on Nov 1[89], 2026\./);
    expect(note.footnote).toMatch(/Nothing here is live, and no order is placed now\./);
    // a recording of the local test exchange does not get to borrow Gemini's name
    expect(describeVenue('live', { venue: 'Local test exchange', replay: { recordedAt: '2026-11-19T01:00:00.000Z' } }).footnote).toMatch(/on Local test exchange \(not Gemini\)/);
    expect(describeVenue('live', { venue: 'Gemini sandbox', replay: { recordedAt: 'not a date' } }).footnote).toMatch(/made earlier\./);
  });

  it('quotes only, demo data, a test exchange, and not yet connected', () => {
    expect(describeVenue('live', { venue: 'Gemini sandbox', readOnly: true })).toMatchObject({ chip: 'Quotes only', readOnly: true });
    expect(describeVenue('mock', null).chip).toBe('Demo data');
    expect(describeVenue('live', { venue: 'Local test exchange' }).footnote).toBe('Local test exchange. Not Gemini, and no real orders.');
    expect(describeVenue('live', undefined)).toEqual({ chip: null, footnote: 'Connecting to the exchange.', readOnly: false });
  });
});
