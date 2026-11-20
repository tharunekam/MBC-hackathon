import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';

/** A rate limit that is not a usable number must stop the service, not quietly switch the limiter off. */
describe('the rate limit setting', () => {
  const load = (value: string | undefined) => loadConfig({ GIVEN_CHAIN: 'fake', GIVEN_RATE_LIMIT_PER_MIN: value });

  it('is a number of requests a minute, or off when it is not set', () => {
    assert.equal(load('20').rateLimitPerMin, 20);
    assert.equal(load(' 7.5 ').rateLimitPerMin, 7.5);
    assert.equal(load(undefined).rateLimitPerMin, null);
    assert.equal(load('').rateLimitPerMin, null);
  });

  it('refuses a value that would become NaN or switch the limiter off', () => {
    for (const bad of ['20/min', '$20', 'many', '0', '-5', '1e3', 'Infinity', '0x10']) {
      assert.throws(() => load(bad), /GIVEN_RATE_LIMIT_PER_MIN must be a number above 0/, `"${bad}" should be refused`);
    }
  });

  it('names the setting and shows what was given, shortened', () => {
    assert.throws(() => load('x'.repeat(80)), (err: Error) => err.message.includes('GIVEN_RATE_LIMIT_PER_MIN') && !err.message.includes('x'.repeat(50)));
  });
});

/** The other numeric settings: a word or a unit must stop the service, not become NaN. */
describe('the whole-number settings', () => {
  it('read a plain whole number, and keep their defaults when not set', () => {
    const c = loadConfig({ GIVEN_CHAIN: 'fake', GIVEN_LB_MIN_CALLS: '3', GIVEN_BACKFILL_MS: '30000', GIVEN_CHAIN_PORT: '9000' });
    assert.deepEqual([c.minCalls, c.backfillMs, c.port], [3, 30000, 9000]);
    const d = loadConfig({ GIVEN_CHAIN: 'fake' });
    assert.deepEqual([d.minCalls, d.backfillMs, d.port], [1, 0, 8742]);
    assert.equal(loadConfig({ GIVEN_CHAIN: 'devnet' }).backfillMs, 60_000);
    assert.equal(loadConfig({ GIVEN_CHAIN: 'fake', GIVEN_BACKFILL_MS: '0' }).backfillMs, 0, 'zero turns the backfill off');
  });

  it('refuse a value that would become NaN', () => {
    for (const name of ['GIVEN_LB_MIN_CALLS', 'GIVEN_BACKFILL_MS', 'GIVEN_CHAIN_PORT']) {
      for (const bad of ['three', '60s', '87x2', '1e2', '.5', '-1', '2.5', '0x10']) {
        assert.throws(() => loadConfig({ GIVEN_CHAIN: 'fake', [name]: bad }), new RegExp(`${name} must be a whole number`), `${name}="${bad}" should be refused`);
      }
    }
    assert.throws(() => loadConfig({ GIVEN_CHAIN: 'fake', GIVEN_CHAIN_PORT: '70000' }), /GIVEN_CHAIN_PORT must be a whole number/);
  });
});
