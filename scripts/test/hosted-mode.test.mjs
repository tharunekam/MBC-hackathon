import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hostedModeSettings } from '../lib/hosted-mode.mjs';

describe('hosted chain and order modes', () => {
  it('preserves the existing default networks and order modes', () => {
    assert.deepEqual(hostedModeSettings('quotes'), { chain: 'fake', readOnly: true, indexOnly: false });
    assert.deepEqual(hostedModeSettings('fake'), { chain: 'fake', readOnly: false, indexOnly: false });
    assert.deepEqual(hostedModeSettings('live'), { chain: 'devnet', readOnly: false, indexOnly: false });
  });

  it('allows devnet ingestion in quotes mode while keeping orders disabled', () => {
    assert.deepEqual(hostedModeSettings('quotes', 'devnet'), { chain: 'devnet', readOnly: true, indexOnly: true });
    assert.deepEqual(hostedModeSettings('fake', 'devnet'), { chain: 'fake', readOnly: false, indexOnly: false });
  });

  it('accepts replay mode, which starts no backend', () => {
    assert.deepEqual(hostedModeSettings('replay'), { chain: 'fake', readOnly: false, indexOnly: false });
  });

  it('rejects misspelled chain settings rather than silently using a fake chain', () => {
    assert.throws(() => hostedModeSettings('quotes', 'devnets'), /GIVEN_QUOTES_CHAIN/);
  });
});
