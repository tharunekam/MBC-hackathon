import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('optional project configuration loads without overriding inherited values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'given-project-env-'));
  try {
    const fixture = join(dir, 'settings.fixture');
    writeFileSync(fixture, 'GIVEN_ENV_TEST_NEW=from-file\nGIVEN_ENV_TEST_EXISTING=from-file\n');
    const script = `
      import { loadProjectEnv } from './scripts/lib/project-env.mjs';
      loadProjectEnv(process.argv[1]);
      loadProjectEnv(process.argv[2]);
      console.log(JSON.stringify([process.env.GIVEN_ENV_TEST_NEW, process.env.GIVEN_ENV_TEST_EXISTING]));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, fixture, join(dir, 'missing')], {
      cwd: new URL('../..', import.meta.url),
      env: { ...process.env, GIVEN_ENV_TEST_EXISTING: 'from-caller', GIVEN_ENV_TEST_NEW: '' },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    assert.deepEqual(JSON.parse(child.stdout), ['', 'from-caller']);
    const noOverride = { ...process.env, GIVEN_ENV_TEST_EXISTING: 'from-caller' };
    delete noOverride.GIVEN_ENV_TEST_NEW;
    const cleanChild = spawnSync(process.execPath, ['--input-type=module', '-e', script, fixture, join(dir, 'missing')], {
      cwd: new URL('../..', import.meta.url),
      env: noOverride,
      encoding: 'utf8',
    });
    assert.equal(cleanChild.status, 0);
    assert.deepEqual(JSON.parse(cleanChild.stdout), ['from-file', 'from-caller']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
