import { describe, expect, it } from 'vitest';
import { describeVenue, modeFlag, withFlag } from './venue';

describe('the app says what it is talking to', () => {
  it('Gemini\'s sandbox says it is the sandbox and that the money is practice money', () => {
    const note = describeVenue('live', { venue: 'Gemini sandbox' });
    expect(note).toEqual({ chip: 'Sandbox · practice money', readOnly: false, place: 'Gemini’s sandbox', about: 'Uses Gemini’s API on the sandbox, with practice money.' });
  });

  it('the local test exchange never reads as Gemini', () => {
    const note = describeVenue('live', { venue: 'Local test exchange' });
    expect(note.chip).toBe('Test exchange');
    expect(note.place).toBe('the local test exchange');
    expect(note.about).toMatch(/stands in for Gemini/);
    expect(note.about).toMatch(/no order reaches Gemini/);
    expect(note.readOnly).toBe(false);
  });

  it('any other stand-in is labelled with its own name', () => {
    const note = describeVenue('live', { venue: 'Staging exchange' });
    expect(note.chip).toBe('Staging exchange');
    expect(note.place).toBe('Staging exchange');
    expect(note.about).toMatch(/stands in for Gemini/);
  });

  it('Gemini itself says the money is real', () => {
    expect(describeVenue('live', { venue: 'Gemini' })).toEqual({ chip: 'Gemini · real money', readOnly: false, place: 'Gemini', about: 'Uses Gemini’s API, with real money.' });
  });

  it('a sandbox our own seeder is quoting on is labelled', () => {
    const note = describeVenue('live', { venue: 'Gemini sandbox', seeded: true });
    expect(note.chip).toBe('Seeded prices');
    expect(note.place).toBe('Gemini’s sandbox');
    expect(note.about).toMatch(/practice money/);
    expect(note.about).toMatch(/our own quotes/);
  });

  it('seeding is never claimed anywhere but the sandbox', () => {
    expect(describeVenue('live', { venue: 'Gemini', seeded: true }).chip).toBe('Gemini · real money');
    expect(describeVenue('live', { venue: 'Local test exchange', seeded: true }).chip).toBe('Test exchange');
  });

  it('a replay says it is one, whatever else the recorded health says', () => {
    const replay = { recordedAt: '2026-11-19T01:00:00.000Z' };
    for (const health of [{ venue: 'Gemini sandbox', seeded: true, replay }, { venue: 'Local test exchange', replay }, { venue: 'Gemini sandbox', readOnly: true, replay }]) {
      const note = describeVenue('live', health);
      expect(note.chip).toBe('Replay');
      expect(note.place).toBe('a recorded session');
      expect(note.about).toMatch(/no order is placed/);
    }
  });

  it('quotes only says bets are off, and where the prices come from', () => {
    expect(describeVenue('live', { venue: 'Gemini sandbox', readOnly: true })).toEqual({
      chip: 'Quotes only',
      readOnly: true,
      place: 'Gemini’s sandbox',
      about: 'Uses Gemini’s API for sandbox prices. Bets are switched off here.',
    });
    expect(describeVenue('live', { venue: 'Local test exchange', readOnly: true }).about).toBe('Shows prices from the local test exchange. Bets are switched off here.');
  });

  it('demo data says nothing is sent anywhere, whatever the health says', () => {
    for (const health of [null, { venue: 'Gemini sandbox' }]) {
      const note = describeVenue('mock', health);
      expect(note.chip).toBe('Demo data');
      expect(note.place).toBe('demo data');
      expect(note.about).toMatch(/nothing is sent to Gemini/);
    }
  });

  it('before the executor answers, it claims nothing', () => {
    for (const health of [undefined, null]) {
      expect(describeVenue('live', health)).toEqual({ chip: null, readOnly: false, place: 'the exchange', about: '' });
    }
  });

  it('every label that is not Gemini itself leaves "real" out, and none promises anything', () => {
    const cases = [describeVenue('mock', null), describeVenue('live', { venue: 'Gemini sandbox' }), describeVenue('live', { venue: 'Gemini sandbox', seeded: true }), describeVenue('live', { venue: 'Local test exchange' })];
    for (const note of cases) {
      const words = `${note.chip} ${note.place} ${note.about}`;
      expect(words).not.toMatch(/real|guarantee|risk-free/i);
    }
  });
});

describe('the mode flag travels with internal links', () => {
  it('reads the flag the way the api does', () => {
    expect(modeFlag('?mock')).toBe('mock');
    expect(modeFlag('?theme=dark&mock&still')).toBe('mock');
    expect(modeFlag('?live')).toBe('live');
    expect(modeFlag('?mock&live')).toBe('live');
    expect(modeFlag('')).toBe(null);
    expect(modeFlag('?market=BTC')).toBe(null);
  });

  it('leaves a link alone when there is no flag', () => {
    expect(withFlag('/parlay', null)).toBe('/parlay');
    expect(withFlag('/range?side=out', null)).toBe('/range?side=out');
  });

  it('adds the flag, keeping the link\'s own query and hash', () => {
    expect(withFlag('/parlay', 'mock')).toBe('/parlay?mock');
    expect(withFlag('/', 'live')).toBe('/?live');
    expect(withFlag('/range?side=out', 'mock')).toBe('/range?side=out&mock');
    expect(withFlag('/#how', 'mock')).toBe('/?mock#how');
    expect(withFlag('/range?side=out#top', 'mock')).toBe('/range?side=out&mock#top');
  });

  it('does not add it twice', () => {
    expect(withFlag('/parlay?mock', 'mock')).toBe('/parlay?mock');
    expect(withFlag('/parlay?market=BTC&mock#x', 'mock')).toBe('/parlay?market=BTC&mock#x');
  });

  it('a flagged link reads back as the same mode', () => {
    for (const flag of ['mock', 'live'] as const) {
      const to = withFlag('/range?side=out#top', flag);
      expect(modeFlag(to.slice(to.indexOf('?'), to.indexOf('#')))).toBe(flag);
    }
  });
});
