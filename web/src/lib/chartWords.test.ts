import { describe, expect, it } from 'vitest';
import { AXIS_TITLE, AXIS_TITLE_SHORT, chartZones, levelLabel, levelSpoken } from './chartWords';

describe('a chart pill names its marker and gives its level', () => {
  it('says the marker the way the page and the ticket do, then the level', () => {
    expect(levelLabel('First level', '$61,500')).toBe('First level $61,500');
    expect(levelLabel('Target', '$63,000')).toBe('Target $63,000');
    expect(levelLabel('Lower level', '$62,500')).toBe('Lower level $62,500');
    expect(levelLabel('Higher level', '$63,500')).toBe('Higher level $63,500');
  });

  it('carries no percent: the curve height is what the axis title says, and the ticket has the chance of winning', () => {
    expect(levelLabel('Higher level', '$63,500')).not.toMatch(/%|·|at or above/i);
  });

  it('uses none of the old words that named the bet instead of the price', () => {
    for (const said of [levelLabel('Lower level', '$63,000'), levelSpoken('$63,000', 0.38)]) expect(said).not.toMatch(/holds|reaches|stays under|falls below|floor|ceiling/i);
  });
});

describe('the spoken level still says the chance of finishing at or above', () => {
  it('is said the same way aloud', () => {
    expect(levelSpoken('$63,500', 0.37)).toBe('at or above $63,500, 37 percent chance');
  });

  it('a price with no book has no number', () => {
    expect(levelSpoken('$65,000', null)).toBe('at or above $65,000');
    expect(levelSpoken('$65,000', Number.NaN)).toBe('at or above $65,000');
  });
});

describe('the axis title says what the curve plots', () => {
  it('both lengths name the chance of finishing at or above a price', () => {
    expect(AXIS_TITLE).toMatch(/chance of finishing at or above/i);
    expect(AXIS_TITLE_SHORT).toMatch(/chance at or above/i);
  });
});

describe('the colours of the chart mean what they mean on the ticket', () => {
  it('a Stake Back loses between its markers and wins past the target; the stake-back stretch is not coloured', () => {
    expect(chartZones('up')).toEqual({ below: null, between: 'lose', above: 'win' });
    expect(chartZones('down')).toEqual({ below: 'win', between: 'lose', above: null });
  });

  it('a Range wins between its levels and a Breakout is the same two levels the other way round', () => {
    expect(chartZones('range')).toEqual({ below: 'lose', between: 'win', above: 'lose' });
    expect(chartZones('breakout')).toEqual({ below: 'win', between: 'lose', above: 'win' });
  });

  it('only win and lose are ever drawn: no stretch is a third, amber, kind', () => {
    for (const k of ['up', 'down', 'range', 'breakout'] as const) for (const z of Object.values(chartZones(k))) expect([null, 'win', 'lose']).toContain(z);
  });
});
