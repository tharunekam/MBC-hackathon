import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cacheControl, clientAddress, resolveStatic, route, shellWithPublicImage } from '../lib/edge.mjs';

describe('which paths reach a backend', () => {
  it('lets the web app call what it needs, with the right method', () => {
    assert.deepEqual(route('GET', '/api/markets'), { target: 'executor', path: '/markets' });
    assert.deepEqual(route('POST', '/api/bets'), { target: 'executor', path: '/bets' });
    assert.deepEqual(route('POST', '/api/baskets'), { target: 'executor', path: '/baskets' });
    assert.deepEqual(route('GET', '/api/cashout'), { target: 'executor', path: '/cashout' });
    assert.deepEqual(route('POST', '/api/cashout'), { target: 'executor', path: '/cashout' });
    assert.deepEqual(route('GET', '/api/stream'), { target: 'executor', path: '/stream' });
    assert.deepEqual(route('GET', '/api/quote/'), { target: 'executor', path: '/quote' });
    assert.deepEqual(route('GET', '/chain/leaderboard'), { target: 'chain', path: '/leaderboard' });
    assert.deepEqual(route('POST', '/chain/calls'), { target: 'chain', path: '/calls' });
    assert.deepEqual(route('POST', '/chain/calls/abc123/reveal'), { target: 'chain', path: '/calls/abc123/reveal' });
    assert.deepEqual(route('GET', '/chain/calls/abc123/verify'), { target: 'chain', path: '/calls/abc123/verify' });
    assert.deepEqual(route('POST', '/chain/hooks/quicknode'), { target: 'chain', path: '/hooks/quicknode' });
    assert.equal(route('GET', `/chain/reveals/${'5'.repeat(88)}`)?.target, 'chain');
  });

  it('refuses everything else, including admin and dev routes and the wrong method', () => {
    for (const [m, p] of [
      ['POST', '/chain/admin/backfill'],
      ['GET', '/chain/admin/backfill'],
      ['POST', '/api/dev/reset'],
      ['POST', '/api/dev/resolve'],
      ['GET', '/api/'],
      ['GET', '/api'],
      ['DELETE', '/api/bets'],
      ['GET', '/api/baskets'],
      ['GET', '/api/settle'],
      ['POST', '/api/markets'],
      ['GET', '/chain/calls/abc/reveal'],
      ['POST', '/chain/calls/abc/verify'],
      ['GET', '/chain/calls/../admin/backfill'],
      ['POST', '/chain/calls/a/b/reveal'],
      ['GET', '/chain/reveals/short'],
      ['GET', '/api/../chain/admin'],
      ['GET', '/something'],
    ]) assert.equal(route(m, p), null, `${m} ${p} must not reach a backend`);
  });
});

describe('which address is the client', () => {
  it('uses the socket unless the host proxy is trusted, and then the address that proxy added', () => {
    assert.equal(clientAddress('1.2.3.4', '9.9.9.9', false), '1.2.3.4');
    assert.equal(clientAddress('10.0.0.1', '6.6.6.6, 8.8.8.8', true), '8.8.8.8', 'a caller-chosen leading entry is not believed');
    assert.equal(clientAddress('10.0.0.1', undefined, true), '10.0.0.1');
    assert.equal(clientAddress(undefined, undefined, false), 'unknown');
  });
});

describe('serving the built app', () => {
  const root = mkdtempSync(join(tmpdir(), 'given-dist-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>x</title>');
  writeFileSync(join(root, 'assets', 'app-abc.js'), 'console.log(1)');
  writeFileSync(join(root, 'assets', 'app-abc.js.map'), '{}');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  writeFileSync(join(root, 'favicon.svg'), '<svg/>');

  it('serves files, and the app shell for client-side routes', () => {
    assert.equal(resolveStatic(root, '/assets/app-abc.js')?.spa, false);
    assert.equal(resolveStatic(root, '/favicon.svg')?.spa, false);
    assert.deepEqual(resolveStatic(root, '/')?.spa, true);
    assert.deepEqual(resolveStatic(root, '/bets')?.spa, true);
    assert.deepEqual(resolveStatic(root, '/verify/5abc')?.spa, true);
  });

  it('a missing asset is a 404, not the app shell', () => {
    assert.equal(resolveStatic(root, '/assets/missing.js'), null);
    assert.equal(resolveStatic(root, '/nope.png'), null);
  });

  it('never leaves the folder', () => {
    // A path that climbs out is flattened to a path inside the folder, so it gets the shell or nothing, never a file outside.
    for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/etc/passwd', '/assets/../../x.js', '/..\\..\\x', '//etc/passwd']) {
      const r = resolveStatic(root, p);
      assert.ok(r === null || (r.spa && r.file === join(root, 'index.html')), `${p} -> ${JSON.stringify(r)}`);
    }
  });

  it('never serves dotfiles or source maps, or a malformed path', () => {
    for (const p of ['/.env', '/assets/.hidden/a.js', '/assets/app-abc.js.map', '/a%00.js', '/%E0%A4%A']) {
      assert.equal(resolveStatic(root, p), null, p);
    }
  });

  it('hashed assets are cached for a year and the shell is always re-checked', () => {
    assert.match(cacheControl('/x/dist/assets/app-abc.js', false), /immutable/);
    assert.equal(cacheControl('/x/dist/index.html', true), 'no-cache');
    assert.equal(cacheControl('/x/dist/index.html', false), 'no-cache');
    assert.doesNotMatch(cacheControl('/x/dist/favicon.svg', false), /immutable/);
  });

  it('puts the public address in front of the link-preview picture, and leaves the page alone when it has none to add', () => {
    const page = '<head><meta property="og:image" content="/og.png" /><link rel="icon" href="/favicon.svg" /></head>';
    assert.equal(
      shellWithPublicImage(page, 'https://given.example.com/'),
      '<head><meta property="og:image" content="https://given.example.com/og.png" /><link rel="icon" href="/favicon.svg" /></head>',
    );
    assert.equal(shellWithPublicImage(page, ''), null); // no public address configured
    assert.equal(shellWithPublicImage(page, 'given.example.com'), null); // not a full address: better a bare path than a broken one
    assert.equal(shellWithPublicImage('<head></head>', 'https://given.example.com'), null); // nothing to change
    // a picture that already has a full address is not touched
    assert.equal(shellWithPublicImage('<meta property="og:image" content="https://cdn.example/og.png" />', 'https://given.example.com'), null);
  });
});
