import { describe, expect, it } from 'vitest';
import { describeVenue, modeFlag, withFlag } from './venue';

describe('the app labels only what changes what a person should expect', () => {
  it('Gemini’s sandbox and a local exchange are the ordinary cases and carry no label', () => {
    for (const venue of ['Gemini sandbox', 'Local test exchange', 'Staging exchange']) {
      expect(describeVenue('live', { venue })).toEqual({ chip: null, hint: '', readOnly: false, kind: 'exchange' });
    }
  });

  it('Gemini itself says the money is real', () => {
    expect(describeVenue('live', { venue: 'Gemini' })).toEqual({ chip: 'Real money', hint: 'Orders here are placed in a live exchange account.', readOnly: false, kind: 'exchange' });
  });

  it('a sandbox our own seeder is quoting on is labelled', () => {
    const note = describeVenue('live', { venue: 'Gemini sandbox', seeded: true });
    expect(note.chip).toBe('Seeded prices');
    expect(note.hint).toMatch(/placed by us/);
    expect(note.readOnly).toBe(false);
  });

  it('seeding is never claimed anywhere but the sandbox', () => {
    expect(describeVenue('live', { venue: 'Gemini', seeded: true }).chip).toBe('Real money');
    expect(describeVenue('live', { venue: 'Local test exchange', seeded: true }).chip).toBe(null);
  });

  it('a replay says it is one, whatever else the recorded health says', () => {
    const replay = { recordedAt: '2026-11-19T01:00:00.000Z' };
    for (const health of [{ venue: 'Gemini sandbox', seeded: true, replay }, { venue: 'Local test exchange', replay }, { venue: 'Gemini sandbox', readOnly: true, replay }]) {
      const note = describeVenue('live', health);
      expect(note.chip).toBe('Replay');
      expect(note.kind).toBe('replay');
      expect(note.hint).toMatch(/No order is placed/);
    }
  });

  it('quotes only says bets are off, on any exchange', () => {
    for (const venue of ['Gemini sandbox', 'Local test exchange']) {
      expect(describeVenue('live', { venue, readOnly: true })).toEqual({ chip: 'Quotes only', hint: 'You can look at prices here, but bets are switched off.', readOnly: true, kind: 'exchange' });
    }
  });

  it('demo data says nothing is sent anywhere, whatever the health says', () => {
    for (const health of [null, { venue: 'Gemini sandbox' }]) {
      const note = describeVenue('mock', health);
      expect(note.chip).toBe('Demo data');
      expect(note.kind).toBe('demo');
      expect(note.hint).toMatch(/Nothing is sent anywhere/);
    }
  });

  it('before the executor answers, it claims nothing', () => {
    for (const health of [undefined, null]) {
      expect(describeVenue('live', health)).toEqual({ chip: null, hint: '', readOnly: false, kind: 'exchange' });
    }
  });

  it('no label names a test or a stand-in, and none promises anything', () => {
    const cases = [describeVenue('mock', null), describeVenue('live', { venue: 'Gemini sandbox', seeded: true }), describeVenue('live', { venue: 'Gemini sandbox', readOnly: true }), describeVenue('live', { venue: 'Gemini sandbox', replay: { recordedAt: '2026-11-19T01:00:00.000Z' } })];
    for (const note of cases) {
      expect(`${note.chip} ${note.hint}`).not.toMatch(/real|test|stand|practice|sandbox|resting|live|guarantee|risk-free/i);
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
