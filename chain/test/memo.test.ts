import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitHash, edge, handleFor, newSalt, preimage } from '../src/hash.ts';
import type { CallFields } from '../src/hash.ts';
import { MEMO_MAX_BYTES, encode, fieldsOf, parseMemo, revealMatchesCommit } from '../src/memo.ts';
import type { CommitMemo, RevealMemo } from '../src/memo.ts';

const FIELDS: CallFields = {
  betId: 'd1a2b3',
  event: 'BTC2611190100',
  condition: 'GEMI-BTC2611190100-HI62500',
  target: 'GEMI-BTC2611190100-HI63500',
  entryPrice: 0.4375,
  fairPrice: 0.41,
  at: 1763433000,
};
const SIG = '5'.repeat(88);

const commitOf = (f: CallFields, salt: string, handle = 'quiet-otter-42'): CommitMemo => ({ g: 1, t: 'c', h: commitHash(f, salt), u: handle, at: f.at });
const revealOf = (f: CallFields, salt: string, outcome: 0 | 1, handle = 'quiet-otter-42'): RevealMemo => ({
  g: 1, t: 'r', c: SIG, u: handle, b: f.betId, e: f.event, k: f.condition, x: f.target, p: f.entryPrice, f: f.fairPrice, at: f.at, s: salt, o: outcome,
});

test('the hash is stable: same call and salt, same hash; any change, different hash', () => {
  const salt = '00112233445566778899aabbccddeeff';
  const h = commitHash(FIELDS, salt);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(commitHash({ ...FIELDS }, salt), h);
  assert.notEqual(commitHash({ ...FIELDS, target: 'GEMI-BTC2611190100-HI64000' }, salt), h);
  assert.notEqual(commitHash({ ...FIELDS, entryPrice: 0.4376 }, salt), h);
  assert.notEqual(commitHash({ ...FIELDS, at: FIELDS.at + 1 }, salt), h);
  assert.notEqual(commitHash(FIELDS, 'ffeeddccbbaa99887766554433221100'), h);
});

test('the preimage format is pinned, so a verifier written elsewhere reproduces it', () => {
  assert.equal(
    preimage(FIELDS, 'aa'.repeat(16)),
    'given1|d1a2b3|BTC2611190100|GEMI-BTC2611190100-HI62500|GEMI-BTC2611190100-HI63500|0.437500|0.410000|1763433000|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
});

test('a field containing the separator cannot be used to forge a different preimage', () => {
  assert.throws(() => preimage({ ...FIELDS, betId: 'a|b' }, 'aa'));
  assert.throws(() => preimage({ ...FIELDS, event: '' }, 'aa'));
});

test('salts are random 128-bit hex and never repeat', () => {
  const a = newSalt();
  const b = newSalt();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test('a reveal reproduces its commit; a tampered reveal does not', () => {
  const salt = newSalt();
  const commit = commitOf(FIELDS, salt);
  assert.equal(revealMatchesCommit(commit, revealOf(FIELDS, salt, 1)), true);
  // changing any revealed input breaks the match
  assert.equal(revealMatchesCommit(commit, { ...revealOf(FIELDS, salt, 1), f: 0.2 }), false, 'a lower fair price would inflate the score');
  assert.equal(revealMatchesCommit(commit, { ...revealOf(FIELDS, salt, 1), p: 0.3 }), false);
  assert.equal(revealMatchesCommit(commit, { ...revealOf(FIELDS, salt, 1), x: 'GEMI-BTC2611190100-HI64000' }), false);
  assert.equal(revealMatchesCommit(commit, { ...revealOf(FIELDS, salt, 1), s: newSalt() }), false);
  assert.equal(revealMatchesCommit(commit, { ...revealOf(FIELDS, salt, 1), u: 'amber-wren-11' }), false);
  assert.equal(revealMatchesCommit(commit, { ...revealOf(FIELDS, salt, 1), at: FIELDS.at + 5 }), false);
  // The outcome is NOT covered by the hash (it is unknown at commit time): it is attested by the authority's signature.
  assert.equal(revealMatchesCommit(commit, revealOf(FIELDS, salt, 0)), true);
});

test('memos round-trip, and the worst realistic size fits the 566-byte limit', () => {
  const salt = newSalt();
  const c = commitOf(FIELDS, salt);
  assert.deepEqual(parseMemo(encode(c)), c);
  const longest: CallFields = { ...FIELDS, betId: 'x'.repeat(24), event: 'BTC2611190100'.padEnd(20, '0'), condition: 'GEMI-' + 'C'.repeat(40), target: 'GEMI-' + 'T'.repeat(40) };
  const r = revealOf(longest, salt, 1, 'steady-marten-99');
  const text = encode(r);
  assert.ok(Buffer.byteLength(text) < MEMO_MAX_BYTES, `reveal is ${Buffer.byteLength(text)} bytes`);
  assert.deepEqual(parseMemo(text), r);
  assert.deepEqual(fieldsOf(r), longest);
});

test('encode refuses an oversize memo', () => {
  const huge = revealOf({ ...FIELDS, condition: 'C'.repeat(120), target: 'T'.repeat(120), event: 'E'.repeat(120) }, newSalt(), 1);
  assert.throws(() => encode(huge), /566/);
});

test('parseMemo accepts only the two exact shapes', () => {
  assert.equal(parseMemo('not json'), null);
  assert.equal(parseMemo('[]'), null);
  assert.equal(parseMemo('{"g":2,"t":"c"}'), null);
  assert.equal(parseMemo(JSON.stringify({ ...commitOf(FIELDS, newSalt()), h: 'zz' })), null, 'hash must be 64 hex characters');
  assert.equal(parseMemo(JSON.stringify({ ...revealOf(FIELDS, newSalt(), 1), o: 2 })), null, 'outcome is 0 or 1');
  assert.equal(parseMemo(JSON.stringify({ ...revealOf(FIELDS, newSalt(), 1), c: 'short' })), null, 'commit reference must look like a signature');
  assert.equal(parseMemo(JSON.stringify({ ...revealOf(FIELDS, newSalt(), 1), s: 'nothex' })), null);
  assert.equal(parseMemo(JSON.stringify({ ...revealOf(FIELDS, newSalt(), 1), p: 'a lot' })), null);
  assert.equal(parseMemo('{"g":1,"t":"x"}'), null);
});

test('edge: a win scores one minus the fair price, a miss scores minus it', () => {
  assert.equal(edge(1, 0.41), 0.59);
  assert.equal(edge(0, 0.41), -0.41);
  assert.equal(edge(1, 0.5), 0.5);
});

test('handles are stable per user and secret, differ across secrets, and look like names', () => {
  const a = handleFor('primary', 'secret-one');
  assert.match(a, /^[a-z]+-[a-z]+-\d{2}$/);
  assert.equal(handleFor('primary', 'secret-one'), a);
  assert.notEqual(handleFor('primary', 'secret-two'), a);
  assert.ok(!a.includes('primary'));
});
