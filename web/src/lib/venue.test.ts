import { describe, expect, it } from 'vitest';
import { describeVenue } from './venue';

describe('the app says what it is talking to', () => {
  it('Gemini\'s sandbox, Gemini itself and a local test exchange carry no label', () => {
    for (const venue of ['Gemini sandbox', 'Gemini', 'Local test exchange']) {
      expect(describeVenue('live', { venue })).toEqual({ chip: null, readOnly: false });
    }
  });

  it('a sandbox our own seeder is quoting on is labelled', () => {
    expect(describeVenue('live', { venue: 'Gemini sandbox', seeded: true })).toEqual({ chip: 'Seeded prices', readOnly: false });
  });

  it('seeding is never claimed anywhere but the sandbox', () => {
    expect(describeVenue('live', { venue: 'Gemini', seeded: true }).chip).toBe(null);
    expect(describeVenue('live', { venue: 'Local test exchange', seeded: true }).chip).toBe(null);
  });

  it('a replay says it is one, whatever else the recorded health says', () => {
    expect(describeVenue('live', { venue: 'Gemini sandbox', seeded: true, replay: { recordedAt: '2026-11-19T01:00:00.000Z' } }).chip).toBe('Replay');
    expect(describeVenue('live', { venue: 'Local test exchange', replay: { recordedAt: '2026-11-19T01:00:00.000Z' } }).chip).toBe('Replay');
  });

  it('quotes only, demo data, and not yet connected', () => {
    expect(describeVenue('live', { venue: 'Gemini sandbox', readOnly: true })).toEqual({ chip: 'Quotes only', readOnly: true });
    expect(describeVenue('mock', null).chip).toBe('Demo data');
    expect(describeVenue('live', undefined)).toEqual({ chip: null, readOnly: false });
  });
});
