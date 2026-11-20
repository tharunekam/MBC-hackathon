import assert from 'node:assert/strict';
import { test } from 'node:test';
import { oddsBands } from '../src/odds.ts';

test('calls are grouped by the chance the market gave them, with how many came in and how many the odds expected', () => {
  const bands = oddsBands([
    { fairPrice: 0.1, outcome: 0 },
    { fairPrice: 0.2, outcome: 1 },
    { fairPrice: 0.3, outcome: 0 },
    { fairPrice: 0.6, outcome: 1 },
    { fairPrice: 0.9, outcome: 1 },
    { fairPrice: 0.8, outcome: 0 },
  ]);
  assert.deepEqual(bands, [
    { from: 0, to: 0.25, calls: 2, cameIn: 1, expected: 0.3 },
    { from: 0.25, to: 0.5, calls: 1, cameIn: 0, expected: 0.3 },
    { from: 0.5, to: 0.75, calls: 1, cameIn: 1, expected: 0.6 },
    { from: 0.75, to: 1, calls: 2, cameIn: 1, expected: 1.7 },
  ]);
});

test('a chance on an edge belongs to the band above it, and a certain call to the last band', () => {
  const bands = oddsBands([
    { fairPrice: 0, outcome: 0 },
    { fairPrice: 0.25, outcome: 1 },
    { fairPrice: 0.5, outcome: 1 },
    { fairPrice: 0.75, outcome: 0 },
    { fairPrice: 1, outcome: 1 },
  ]);
  assert.deepEqual(bands.map((b) => b.calls), [1, 1, 1, 2]);
  assert.deepEqual(bands.map((b) => b.cameIn), [0, 1, 1, 1]);
});

test('with no calls every band is there and empty, and a fair price that is not a chance is left out', () => {
  assert.deepEqual(oddsBands([]).map((b) => [b.calls, b.cameIn, b.expected]), [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  const odd = oddsBands([
    { fairPrice: Number.NaN, outcome: 1 },
    { fairPrice: -0.1, outcome: 1 },
    { fairPrice: 1.2, outcome: 1 },
  ]);
  assert.equal(odd.reduce((n, b) => n + b.calls, 0), 0);
});

test('the expected count does not pick up floating point dust', () => {
  const bands = oddsBands(Array.from({ length: 10 }, () => ({ fairPrice: 0.1, outcome: 0 as const })));
  assert.equal(bands[0]!.expected, 1);
});
