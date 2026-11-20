/**
 * What makes the record worth reading: a call is sealed while its result is unknown, a commit lands before its reveal, a call
 * written twice is still one call, and the board adds edge the way the program does.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChainTx } from '../src/chain.ts';
import { commitHash } from '../src/hash.ts';
import { ServiceError } from '../src/executor.ts';
import { encode } from '../src/memo.ts';
import { FakeChain } from '../src/chain.ts';
import { ChainService } from '../src/service.ts';
import { Store } from '../src/store.ts';
import { FakeBets, setup } from './helpers.ts';

const refused = async (p: Promise<unknown>, code: string, status = 409): Promise<ServiceError> => {
  let caught: unknown;
  await p.catch((e: unknown) => (caught = e));
  assert.ok(caught instanceof ServiceError, `expected a ServiceError ${code}`);
  assert.equal(caught.code, code);
  assert.equal(caught.status, status);
  return caught;
};

// ------------------------------------------------------------------ nothing is sealed after the result

test('commit: a bet that has settled is refused, with a plain sentence, and nothing is written or kept', async () => {
  const { service, chain, bets, store } = setup();
  bets.add();
  bets.settle('b1', 'yes', 'yes');
  const err = await refused(service.commitCall('b1', 'primary'), 'too_late');
  assert.match(err.message, /settled/);
  assert.doesNotMatch(err.message, /too_late|_/, 'a sentence, not a code');
  assert.equal(chain.txs.length, 0);
  assert.equal(store.data.calls.length, 0, 'not even a pending call is kept for it');
});

test('commit: an open bet whose market has closed is refused; one whose market is still open, or has no close time, is sealed as before', async () => {
  const { service, chain, bets } = setup(); // the clock reads 01:30
  bets.add({ id: 'closed', expiry: '2026-11-18T01:00:00.000Z' });
  bets.add({ id: 'closing-now', expiry: '2026-11-18T01:30:00.000Z' });
  const err = await refused(service.commitCall('closed', 'primary'), 'too_late');
  assert.match(err.message, /closed/);
  await refused(service.commitCall('closing-now', 'primary'), 'too_late');
  assert.equal(chain.txs.length, 0);

  bets.add({ id: 'open', expiry: '2026-11-18T02:00:00.000Z' });
  bets.add({ id: 'no-close-time' });
  bets.add({ id: 'null-close-time', expiry: null });
  for (const id of ['open', 'no-close-time', 'null-close-time']) assert.equal((await service.commitCall(id, 'primary')).state, 'committed');
  assert.equal(chain.txs.length, 3);
});

test('commit: the last 90 seconds before the close are refused too, in a plain sentence, so a slow confirmation cannot land after it', async () => {
  const { service, chain, bets } = setup(); // the clock reads 01:30:00
  bets.add({ id: 'in-89s', expiry: '2026-11-18T01:31:29.000Z' });
  bets.add({ id: 'in-90s', expiry: '2026-11-18T01:31:30.000Z' });
  bets.add({ id: 'in-91s', expiry: '2026-11-18T01:31:31.000Z' });
  const err = await refused(service.commitCall('in-89s', 'primary'), 'too_late');
  assert.match(err.message, /about to close/);
  assert.doesNotMatch(err.message, /too_late|_|90/, 'a sentence, not a code or a number of seconds');
  assert.equal(chain.txs.length, 0);
  for (const id of ['in-90s', 'in-91s']) assert.equal((await service.commitCall(id, 'primary')).state, 'committed');
});

test('commit: a bet with no usable expiry is judged by the close written in its event code', async () => {
  const { service, chain, bets } = setup();
  bets.add({ id: 'closed-by-code', expiry: null, eventTicker: 'BTC2611180100' }); // closes 2026-11-18 01:00 UTC, the clock reads 01:30
  bets.add({ id: 'soon-by-code', expiry: 'not a date', eventTicker: 'BTC2611180131' }); // 01:31, inside the margin
  await refused(service.commitCall('closed-by-code', 'primary'), 'too_late');
  await refused(service.commitCall('soon-by-code', 'primary'), 'too_late');
  bets.add({ id: 'later-by-code', expiry: null, eventTicker: 'BTC2611190100' });
  bets.add({ id: 'no-code', expiry: null, eventTicker: 'ETHTEST' });
  for (const id of ['later-by-code', 'no-code']) assert.equal((await service.commitCall(id, 'primary')).state, 'committed');
  assert.equal(chain.txs.length, 2);
});

test('commit: a retry of a call that never landed asks about the bet again, so a result that arrived in between stops it', async () => {
  const { service, chain, bets, store } = setup();
  bets.add({ expiry: '2026-11-18T02:00:00.000Z' });
  chain.failNext = 'rpc 500';
  await refused(service.commitCall('b1', 'primary'), 'chain_error', 502);
  assert.deepEqual(store.data.calls.map((c) => c.state), ['pending']);

  bets.settle('b1', 'yes', 'yes'); // the result comes in while the retry waits
  await refused(service.commitCall('b1', 'primary'), 'too_late');
  assert.equal(chain.txs.length, 0, 'nothing was sealed after the result');
  assert.deepEqual(store.data.calls.map((c) => c.state), ['pending'], 'the row is left as it was');
});

test('commit: a retry after the market has closed is refused too, and one inside the window still works', async () => {
  let clock = new Date('2026-11-18T01:30:00Z');
  const { service, chain, bets } = setup({ now: () => clock });
  bets.add({ id: 'late', expiry: '2026-11-18T02:00:00.000Z' });
  bets.add({ id: 'in-time', expiry: '2026-11-18T02:00:00.000Z' });
  chain.failNext = 'rpc 500';
  await refused(service.commitCall('late', 'primary'), 'chain_error', 502);
  chain.failNext = 'rpc 500';
  await refused(service.commitCall('in-time', 'primary'), 'chain_error', 502);

  clock = new Date('2026-11-18T01:57:00Z');
  assert.equal((await service.commitCall('in-time', 'primary')).state, 'committed');
  clock = new Date('2026-11-18T02:00:01Z');
  await refused(service.commitCall('late', 'primary'), 'too_late');
  assert.equal(chain.txs.length, 1, 'only the one inside the window was sealed');
});

test('commit: a first try that landed before the result is still adopted after it: the record is already on chain', async () => {
  const { service, chain, bets } = setup();
  bets.add();
  chain.landThenFailNext = 'Solana did not confirm within 60s';
  await assert.rejects(service.commitCall('b1', 'primary'));
  bets.settle('b1', 'yes', 'yes');
  const call = await service.commitCall('b1', 'primary');
  assert.equal(call.state, 'committed');
  assert.equal(call.commitSignature, chain.txs[0]!.signature);
  assert.equal(chain.txs.length, 1, 'adopted, not written again');
});

test('commit: a call already sealed is returned as it was, whatever the bet has become since', async () => {
  const { service, chain, bets } = setup();
  bets.add();
  const first = await service.commitCall('b1', 'primary');
  bets.settle('b1', 'yes', 'yes');
  const again = await service.commitCall('b1', 'primary');
  assert.equal(again.id, first.id);
  assert.equal(chain.txs.length, 1);
});

// ------------------------------------------------------------------ a commit lands before its reveal

const FIELDS = { betId: 'late1', event: 'EV', condition: 'C', target: 'T', entryPrice: 0.45, fairPrice: 0.41, at: 5000 };
const SALT = '7'.repeat(32);
const HANDLE = 'calm-fox-11';
const COMMIT_SIG = '3'.repeat(88); // a signature that is chosen up front, so a reveal can name a commit that has not been written yet
const commitMemo = () => encode({ g: 1, t: 'c', h: commitHash(FIELDS, SALT), u: HANDLE, at: FIELDS.at });
const revealMemo = (c: string) =>
  encode({ g: 1, t: 'r', c, u: HANDLE, b: FIELDS.betId, e: FIELDS.event, k: FIELDS.condition, x: FIELDS.target, p: FIELDS.entryPrice, f: FIELDS.fairPrice, at: FIELDS.at, s: SALT, o: 1 });
const place = (chain: { txs: ChainTx[] }, signature: string, slot: number, memo: string, signer: string): void => {
  chain.txs.push({ signature, slot, blockTime: 1_700_000_000, memo, signer });
};

test('ingest: a reveal whose commit is in a later slot is recorded as unverified and never scored', async () => {
  const { chain, fresh } = setup();
  const reveal = chain.forge(revealMemo(COMMIT_SIG), chain.authority);
  place(chain, COMMIT_SIG, reveal.slot + 50, commitMemo(), chain.authority); // the hash is right, the order is not
  const verifier = fresh();
  assert.equal(await verifier.ingest(reveal.signature, 'rpc'), 'unverified');
  assert.equal(verifier.store.data.reveals[reveal.signature]?.reason, 'commit_not_before_reveal');
  assert.deepEqual(verifier.leaderboard().rows, []);
});

test('ingest: a commit in the same slot as its reveal cannot be shown to come first, so it is not scored either', async () => {
  const { chain, fresh } = setup();
  const reveal = chain.forge(revealMemo(COMMIT_SIG), chain.authority);
  place(chain, COMMIT_SIG, reveal.slot, commitMemo(), chain.authority);
  const verifier = fresh();
  assert.equal(await verifier.ingest(reveal.signature, 'rpc'), 'unverified');
  assert.equal(verifier.store.data.reveals[reveal.signature]?.reason, 'commit_not_before_reveal');
});

test('ingest: the same pair with the commit first is scored', async () => {
  const { chain, fresh } = setup();
  place(chain, COMMIT_SIG, 1000, commitMemo(), chain.authority);
  const reveal = chain.forge(revealMemo(COMMIT_SIG), chain.authority);
  const verifier = fresh();
  assert.equal(await verifier.ingest(reveal.signature, 'rpc'), 'new');
  assert.equal(verifier.leaderboard().rows.length, 1);
});

test('ingest: a reveal after a commit stored before slots were kept is still judged by its hash alone', async () => {
  const { chain, fresh } = setup();
  const reveal = chain.forge(revealMemo(COMMIT_SIG), chain.authority);
  place(chain, COMMIT_SIG, reveal.slot + 50, commitMemo(), chain.authority);
  const verifier = fresh();
  verifier.store.data.commits[COMMIT_SIG] = { signature: COMMIT_SIG, hash: commitHash(FIELDS, SALT), handle: HANDLE, at: FIELDS.at }; // no slot, no signer
  assert.equal(await verifier.ingest(reveal.signature, 'rpc'), 'new');
});

// ------------------------------------------------------------------ one call is one commit

test('a lost reply with an unreadable history writes the call twice, and it is still one sealed call and one scored call', async () => {
  const { service, chain, bets, store } = setup({ selfIngest: true });
  bets.add();
  chain.landThenFailNext = 'Solana did not confirm within 60s';
  await assert.rejects(service.commitCall('b1', 'primary')); // the first commit landed; its reply was lost
  const readable = chain.recentSignatures.bind(chain);
  chain.recentSignatures = async () => {
    throw new Error('429 Too Many Requests'); // and the history cannot be read to find it
  };
  const call = await service.commitCall('b1', 'primary');
  chain.recentSignatures = readable;
  const [orphan, kept] = chain.txs;
  assert.equal(chain.txs.length, 2);
  assert.equal(JSON.parse(orphan!.memo).h, JSON.parse(kept!.memo).h, 'the same hash was written twice');
  assert.equal(call.commitSignature, kept!.signature);

  await service.backfill(); // now both are seen
  assert.equal(store.data.commits[orphan!.signature]?.duplicateOf, kept!.signature, 'the later sighting of the same call is marked as a repeat');
  assert.equal(store.data.commits[kept!.signature]?.duplicateOf, undefined);

  bets.settle('b1', 'yes', 'yes');
  await service.revealCall(call.id, 'primary');
  const row = service.leaderboard().rows[0]!;
  assert.deepEqual([row.calls, row.sealed], [1, 1], 'sealed counts distinct calls');

  // A second authority-signed reveal that names the orphan commit is not scored again.
  const r = store.data.calls[0]!;
  const f = r.fields;
  const second = chain.forge(
    encode({ g: 1, t: 'r', c: orphan!.signature, u: r.handle, b: f.betId, e: f.event, k: f.condition, x: f.target, p: f.entryPrice, f: f.fairPrice, at: f.at, s: r.salt, o: 1 }),
    chain.authority,
  );
  assert.equal(await service.ingest(second.signature, 'rpc'), 'unverified');
  assert.equal(store.data.reveals[second.signature]?.reason, 'duplicate_reveal');
  const after = service.leaderboard().rows[0]!;
  assert.deepEqual([after.calls, after.sealed, after.edge], [1, 1, 0.59], 'one call, one edge');
});

test('a verifier that reads the same two commits from the chain alone counts one call, whichever commit the reveal names', async () => {
  const { service, chain, bets, fresh } = setup({ selfIngest: true });
  bets.add();
  chain.landThenFailNext = 'lost';
  await assert.rejects(service.commitCall('b1', 'primary'));
  chain.recentSignatures = async () => {
    throw new Error('429');
  };
  const call = await service.commitCall('b1', 'primary'); // the repeat; the reveal will name it
  delete (chain as { recentSignatures?: unknown }).recentSignatures; // back to the class's own, readable history
  bets.settle('b1', 'yes', 'yes');
  await service.revealCall(call.id, 'primary');

  const verifier = fresh();
  await verifier.backfill();
  const row = verifier.leaderboard().rows[0]!;
  assert.deepEqual([row.calls, row.sealed, row.edge], [1, 1, 0.59]);
});

test('two different calls with different hashes are two calls', async () => {
  const { service, bets } = setup({ selfIngest: true });
  bets.add();
  bets.add();
  const [a, b] = [await service.commitCall('b1', 'primary'), await service.commitCall('b2', 'primary')];
  bets.settle('b1', 'yes', 'yes');
  bets.settle('b2', 'yes', 'yes');
  await service.revealCall(a.id, 'primary');
  await service.revealCall(b.id, 'primary');
  const row = service.leaderboard().rows[0]!;
  assert.deepEqual([row.calls, row.sealed, row.edge], [2, 2, 1.18]);
});

// ------------------------------------------------------------------ the board adds edge as the program does

test('leaderboard: a long record adds edge in millionths, so it agrees with the program to the fourth decimal however many calls there are', async () => {
  const { chain, fresh } = setup();
  const fair = 0.123456; // six decimals, as a ratio of mids gives
  const N = 50;
  for (let i = 0; i < N; i++) {
    const f = { betId: `many${i}`, event: 'EV', condition: 'C', target: 'T', entryPrice: 0.15, fairPrice: fair, at: 9000 + i };
    const salt = i.toString(16).padStart(2, '0').repeat(16);
    const c = chain.forge(encode({ g: 1, t: 'c', h: commitHash(f, salt), u: HANDLE, at: f.at }), chain.authority);
    chain.forge(encode({ g: 1, t: 'r', c: c.signature, u: HANDLE, b: f.betId, e: f.event, k: f.condition, x: f.target, p: f.entryPrice, f: fair, at: f.at, s: salt, o: 1 }), chain.authority);
  }
  const verifier = fresh();
  await verifier.backfill(500, 5);
  const row = verifier.leaderboard().rows[0]!;
  assert.equal(row.calls, N);
  const exact = (N * Math.round((1 - fair) * 1e6)) / 1e6; // what the program's edge_sum holds, as dollars
  assert.ok(Math.abs(row.edge - exact) <= 0.00005 + 1e-9, `board ${row.edge} against the program's ${exact}`);
  // A single call is still shown to four decimals.
  assert.equal(row.recent![0]!.edge, 0.8765);
});

// ------------------------------------------------------------------ a record is never a repeat of itself

/** A chain whose write is read by the stream (or the backfill) before the write call returns. */
class EchoChain extends FakeChain {
  service: ChainService | null = null;
  via: 'stream' | 'rpc' = 'stream';
  override async sendMemo(text: string) {
    const sent = await super.sendMemo(text);
    await this.service!.ingest(sent.signature, this.via);
    return sent;
  }
}

for (const via of ['stream', 'rpc'] as const) {
  test(`commit: a commit that the ${via} reads before commitCall stores it is not recorded as a repeat of itself`, async () => {
    const chain = new EchoChain();
    chain.via = via;
    const { service, store, bets } = setup({ chain });
    chain.service = service;
    bets.add();
    const call = await service.commitCall('b1', 'primary');
    const seen = store.data.commits[call.commitSignature]!;
    assert.equal(seen.duplicateOf, undefined, 'the call is its own first commit');
    assert.equal(seen.signer, chain.authority);
    assert.equal(Object.keys(store.data.commits).length, 1);
    assert.equal(service.recoverPending(), 0);
    bets.settle('b1', 'yes', 'yes');
    await service.revealCall(call.id, 'primary');
    const row = service.leaderboard().rows[0]!;
    assert.deepEqual([row.calls, row.sealed], [1, 1], 'a sealed call is counted');
  });
}

test('commit: a sealed call counts on the board while it is unrevealed, even when the stream saw it first', async () => {
  const chain = new EchoChain();
  const { service, store, bets } = setup({ chain });
  chain.service = service;
  bets.add({ id: 'one' });
  bets.add({ id: 'two' });
  const a = await service.commitCall('one', 'primary');
  await service.commitCall('two', 'primary');
  bets.settle('one', 'yes', 'yes');
  await service.revealCall(a.id, 'primary');
  assert.equal(Object.values(store.data.commits).filter((c) => !c.duplicateOf).length, 2);
  assert.deepEqual(service.leaderboard().rows.map((r) => [r.calls, r.sealed]), [[1, 2]]);
});

test('reveal: written twice after a lost reply, the call shows the reveal that counts, and its proof page is served', async () => {
  const chain = new FakeChain();
  const { service, bets, store } = setup({ chain });
  bets.add();
  const call = await service.commitCall('b1', 'primary');
  bets.settle('b1', 'yes', 'yes');
  const readable = chain.recentSignatures.bind(chain);
  chain.landThenFailNext = 'Solana did not confirm within 60s';
  await assert.rejects(service.revealCall(call.id, 'primary')); // the first reveal landed; its reply was lost
  chain.recentSignatures = async () => {
    throw new Error('429 Too Many Requests'); // and the history cannot be read to find it
  };
  const again = await service.revealCall(call.id, 'primary');
  chain.recentSignatures = readable;
  const reveals = chain.txs.filter((t) => JSON.parse(t.memo).t === 'r');
  assert.equal(reveals.length, 2, 'the reveal was written twice');
  assert.equal(again.reveal!.signature, reveals[1]!.signature, 'until the chain is read, the call shows the reveal it wrote last');
  await service.ingest(reveals[0]!.signature, 'rpc'); // the first is now read from the chain, then the second
  await service.ingest(reveals[1]!.signature, 'rpc');
  const counted = Object.values(store.data.reveals).filter((r) => r.verified);
  assert.equal(counted.length, 1);
  const shown = service.listCalls('primary')[0]!.reveal!.signature;
  assert.equal(shown, counted[0]!.signature, 'the call shows the reveal that counts');
  assert.doesNotThrow(() => service.publicReveal(shown));
  assert.equal(shown, reveals[0]!.signature);
});
