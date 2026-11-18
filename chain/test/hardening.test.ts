/**
 * Crash consistency and durability. The chain and the local store are two systems; these tests cover every point at
 * which one can be written and the other not, and the damaged-file cases. The rule they enforce: a salt is never lost,
 * and nothing is ever written to Solana twice for the same call.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FakeChain } from '../src/chain.ts';
import { ServiceError } from '../src/executor.ts';
import { createLimiter } from '../src/limiter.ts';
import { ChainService } from '../src/service.ts';
import { Store, StoreError } from '../src/store.ts';
import { FakeBets } from './helpers.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'given-chain-hard-'));
const quiet = { log: () => {}, sleep: async () => {} };

/** A service on a file-backed store, so a "restart" can be simulated by building another one on the same file. */
function boot(path: string, chain: FakeChain, bets: FakeBets) {
  const store = new Store(path, () => 'secret', () => {});
  return { store, service: new ChainService({ chain, store, bets, ...quiet, now: () => new Date('2026-11-18T01:30:00Z'), newId: (() => { let n = 0; return () => `call${++n}`; })() }) };
}

describe('a commit that lands on Solana but is not recorded', () => {
  it('keeps the salt on disk BEFORE anything is sent', async () => {
    const path = join(tmp(), 'calls.json');
    const chain = new FakeChain();
    const bets = new FakeBets();
    bets.add();
    chain.failNext = 'network down';
    const { service } = boot(path, chain, bets);
    await assert.rejects(service.commitCall('b1', 'primary'));
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(saved.calls.length, 1);
    assert.equal(saved.calls[0].state, 'pending');
    assert.match(saved.calls[0].salt, /^[0-9a-f]{16,}$/);
    assert.equal(chain.txs.length, 0, 'nothing was written');
  });

  it('a retry after a failure that wrote nothing sends the SAME hash', async () => {
    const path = join(tmp(), 'calls.json');
    const chain = new FakeChain();
    const bets = new FakeBets();
    bets.add();
    const { service, store } = boot(path, chain, bets);
    chain.failNext = 'rpc 500';
    await assert.rejects(service.commitCall('b1', 'primary'));
    const hash = store.data.calls[0]!.hash;
    const call = await service.commitCall('b1', 'primary');
    assert.equal(call.state, 'committed');
    assert.equal(call.commitHash, hash, 'same salt and time, so the same hash');
    assert.equal(chain.txs.length, 1);
    assert.equal(store.data.calls.length, 1, 'still one call');
  });

  it('a timeout after the transaction landed is adopted on retry, and nothing is written twice', async () => {
    const path = join(tmp(), 'calls.json');
    const chain = new FakeChain();
    const bets = new FakeBets();
    bets.add();
    const { service } = boot(path, chain, bets);
    chain.landThenFailNext = 'Solana did not confirm within 60s';
    await assert.rejects(service.commitCall('b1', 'primary'));
    assert.equal(chain.txs.length, 1, 'the first attempt did land');
    const call = await service.commitCall('b1', 'primary');
    assert.equal(call.state, 'committed');
    assert.equal(call.commitSignature, chain.txs[0]!.signature, 'adopted the record that already exists');
    assert.equal(chain.txs.length, 1, 'no second commit');
  });

  it('a pending call is invisible to the API until it has landed', async () => {
    const chain = new FakeChain();
    const bets = new FakeBets();
    bets.add();
    const { service, store } = boot(join(tmp(), 'calls.json'), chain, bets);
    chain.failNext = 'down';
    await assert.rejects(service.commitCall('b1', 'primary'));
    assert.equal(service.listCalls('primary').length, 0);
    const id = store.data.calls[0]!.id;
    await assert.rejects(service.verifyCall(id, 'primary'), (e: unknown) => e instanceof ServiceError && e.code === 'unknown_call');
    await assert.rejects(service.revealCall(id, 'primary'), (e: unknown) => e instanceof ServiceError && e.code === 'commit_pending');
  });

  it('a process killed mid-send recovers on restart: the pending row is promoted from the chain, and the salt survives', async () => {
    const path = join(tmp(), 'calls.json');
    const chain = new FakeChain();
    const bets = new FakeBets();
    bets.add();
    const first = boot(path, chain, bets);
    chain.landThenFailNext = 'killed';
    await assert.rejects(first.service.commitCall('b1', 'primary'));
    const salt = first.store.data.calls[0]!.salt;

    // "restart": a new service on the same file and the same chain, then the periodic backfill runs.
    const second = boot(path, chain, bets);
    assert.equal(second.store.data.calls[0]!.state, 'pending');
    await second.service.backfill();
    const row = second.store.data.calls[0]!;
    assert.equal(row.state, 'committed');
    assert.equal(row.commitSignature, chain.txs[0]!.signature);
    assert.equal(row.salt, salt, 'the salt was never lost');

    // and the call can still be revealed afterwards
    bets.settle('b1', 'yes', 'yes');
    assert.equal((await second.service.revealCall(row.id, 'primary')).state, 'revealed');
  });
});

describe('a reveal that lands on Solana but is not recorded', () => {
  async function committed() {
    const path = join(tmp(), 'calls.json');
    const chain = new FakeChain();
    const bets = new FakeBets();
    bets.add();
    const first = boot(path, chain, bets);
    const call = await first.service.commitCall('b1', 'primary');
    bets.settle('b1', 'yes', 'yes');
    return { path, chain, bets, first, call };
  }

  it('is adopted on retry instead of being sent (and refused) a second time', async () => {
    const { chain, first, call } = await committed();
    chain.landThenFailNext = 'reply lost';
    await assert.rejects(first.service.revealCall(call.id, 'primary'));
    assert.equal(chain.txs.length, 2, 'commit and the reveal that landed');
    const again = await first.service.revealCall(call.id, 'primary');
    assert.equal(again.state, 'revealed');
    assert.equal(again.reveal!.signature, chain.txs[1]!.signature);
    assert.equal(chain.txs.length, 2, 'no duplicate reveal');
  });

  it('survives a restart in between', async () => {
    const { path, chain, bets, first, call } = await committed();
    chain.landThenFailNext = 'killed';
    await assert.rejects(first.service.revealCall(call.id, 'primary'));
    const second = boot(path, chain, bets);
    assert.equal(second.store.data.calls[0]!.revealing, true);
    const again = await second.service.revealCall(call.id, 'primary');
    assert.equal(again.state, 'revealed');
    assert.equal(chain.txs.length, 2);
    assert.equal(second.service.leaderboard().rows.length, 1);
  });

  it('a reveal that did NOT land is sent normally on retry', async () => {
    const { chain, first, call } = await committed();
    chain.failNext = 'rpc 500';
    await assert.rejects(first.service.revealCall(call.id, 'primary'));
    assert.equal(chain.txs.length, 1);
    assert.equal((await first.service.revealCall(call.id, 'primary')).state, 'revealed');
    assert.equal(chain.txs.length, 2);
  });
});

describe('the store file', () => {
  const populated = async (path: string) => {
    const chain = new FakeChain();
    const bets = new FakeBets();
    bets.add();
    const { service, store } = boot(path, chain, bets);
    await service.commitCall('b1', 'primary');
    return { store, chain, bets };
  };

  it('keeps the previous good copy as .bak', async () => {
    const path = join(tmp(), 'calls.json');
    await populated(path);
    const bak = JSON.parse(readFileSync(`${path}.bak`, 'utf8'));
    assert.ok(Array.isArray(bak.calls));
  });

  it('a damaged file falls back to the backup, loudly, and keeps the salts', async () => {
    const path = join(tmp(), 'calls.json');
    const { store } = await populated(path);
    const salt = store.data.calls[0]!.salt;
    store.save(); // make the .bak hold the committed state
    writeFileSync(path, '{"handleSecret": "abc", "calls": [');
    const warned: string[] = [];
    const recovered = new Store(path, () => 'new', (l) => warned.push(l));
    assert.equal(recovered.data.calls[0]!.salt, salt);
    assert.match(warned.join('\n'), /damaged; restored the previous copy/);
    // and the file on disk is whole again
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).calls[0].salt, salt);
  });

  it('REFUSES to start empty when the file and its backup are both unusable', async () => {
    const path = join(tmp(), 'calls.json');
    await populated(path);
    writeFileSync(path, 'not json');
    writeFileSync(`${path}.bak`, '{}');
    assert.throws(() => new Store(path, () => 'new', () => {}), (e: unknown) => e instanceof StoreError && /lose every salt/.test((e as Error).message));
    assert.equal(readFileSync(path, 'utf8'), 'not json', 'the damaged file is left for a human, not overwritten');
  });

  it('a file of the wrong shape is damaged, not empty', () => {
    const path = join(tmp(), 'calls.json');
    writeFileSync(path, JSON.stringify({ hello: 'world' }));
    assert.throws(() => new Store(path, () => 'new', () => {}), StoreError);
  });

  it('never replaces a good backup with a bad file', async () => {
    const path = join(tmp(), 'calls.json');
    const { store } = await populated(path);
    store.save();
    const goodBak = readFileSync(`${path}.bak`, 'utf8');
    writeFileSync(path, 'garbage');
    store.save();
    assert.equal(readFileSync(`${path}.bak`, 'utf8'), goodBak);
  });

  it('a first run creates the file with owner-only permissions', async () => {
    const path = join(tmp(), 'calls.json');
    await populated(path);
    const { statSync } = await import('node:fs');
    assert.equal(statSync(path).mode & 0o077, 0, 'no group or world access: it holds the salts');
  });
});

describe('the rate limiter', () => {
  it('limits a client, then lets it back in when the window passes', () => {
    let t = 0;
    const l = createLimiter({ max: 2, windowMs: 1000 }, () => t);
    assert.deepEqual([l.limited('a'), l.limited('a'), l.limited('a')], [false, false, true]);
    assert.equal(l.limited('b'), false, 'another client is unaffected');
    t = 1001;
    assert.equal(l.limited('a'), false);
  });

  it('does not grow without bound: idle clients are swept', () => {
    let t = 0;
    const l = createLimiter({ max: 5, windowMs: 1000 }, () => t);
    for (let i = 0; i < 5000; i++) l.limited(`10.0.${i >> 8}.${i & 255}`);
    assert.equal(l.size(), 5000);
    t = 5000;
    l.limited('someone-new');
    assert.equal(l.size(), 1, 'every idle client was forgotten');
  });

  it('is off when no limit is configured', () => {
    const l = createLimiter(undefined, () => 0);
    for (let i = 0; i < 100; i++) assert.equal(l.limited('a'), false);
    assert.equal(l.size(), 0);
  });
});
