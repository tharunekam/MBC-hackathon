import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeChain } from '../src/chain.ts';
import { commitHash } from '../src/hash.ts';
import { ServiceError } from '../src/executor.ts';
import { encode, parseMemo } from '../src/memo.ts';
import type { RevealMemo } from '../src/memo.ts';
import { setup } from './helpers.ts';

const rejects = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof ServiceError && e.code === code, `expected ServiceError ${code}`);
};

test('commit: writes one Memo record from the authority whose hash matches the stored call', async () => {
  const { service, chain, bets, store } = setup();
  bets.add();
  const call = await service.commitCall('b1', 'primary');
  assert.equal(call.state, 'committed');
  assert.equal(call.network, 'fake');
  assert.match(call.handle, /^[a-z]+-[a-z]+-\d{2}$/);
  assert.equal(chain.txs.length, 1);
  const tx = chain.txs[0]!;
  assert.equal(tx.signer, chain.authority);
  assert.equal(tx.signature, call.commitSignature);
  const memo = parseMemo(tx.memo);
  assert.equal(memo?.t, 'c');
  if (memo?.t !== 'c') throw new Error('unreachable');
  assert.equal(memo.h, call.commitHash);
  const row = store.data.calls[0]!;
  assert.equal(commitHash(row.fields, row.salt), memo.h, 'the stored salt and fields reproduce the on-chain hash');
  assert.ok(!tx.memo.includes(row.salt), 'the salt is not published at commit time');
  assert.ok(!tx.memo.includes('GEMI-'), 'nothing about the bet is published at commit time');
  assert.ok(!tx.memo.includes('primary'), 'no account name on chain');
});

test('commit: repeating it, even at the same instant, writes only once', async () => {
  const { service, chain, bets } = setup();
  bets.add();
  const [a, b] = await Promise.all([service.commitCall('b1', 'primary'), service.commitCall('b1', 'primary')]);
  const c = await service.commitCall('b1', 'primary');
  assert.equal(a.id, b.id);
  assert.equal(a.commitSignature, c.commitSignature);
  assert.equal(chain.txs.length, 1);
});

test('commit: only a complete, hedged bet of this user can be recorded', async () => {
  const { service, chain, bets } = setup();
  await rejects(service.commitCall('nope', 'primary'), 'unknown_bet');
  bets.add({ id: 'theirs', user: 'alice' });
  await rejects(service.commitCall('theirs', 'primary'), 'unknown_bet');
  for (const [id, over] of [
    ['failed', { status: 'failed' }],
    ['unwound', { status: 'unwound' }],
    ['unhedged', { status: 'unhedged' }],
    ['placing', { status: 'placing' }],
    ['nohedge', { payoffs: { hedged: false, conditionalPrice: 0.4 } }],
    ['nofair', { offer: { fairPrice: null } }],
    ['badfair', { offer: { fairPrice: 1.2 } }],
  ] as const) {
    bets.add({ id, ...over } as never);
    await rejects(service.commitCall(id, 'primary'), 'bet_not_eligible');
  }
  assert.equal(chain.txs.length, 0, 'nothing reached the chain');
});

test('commit: if Solana fails, nothing is written to the chain, no call is shown, the salt is kept, and the error is plain', async () => {
  const { service, chain, bets, store } = setup();
  bets.add();
  chain.failNext = 'Attempt to debit an account but found no record of a prior credit.';
  await rejects(service.commitCall('b1', 'primary'), 'chain_unfunded');
  chain.failNext = 'socket hang up';
  await rejects(service.commitCall('b1', 'primary'), 'chain_error');
  assert.equal(chain.txs.length, 0);
  assert.equal(service.listCalls('primary').length, 0, 'a call that has not landed is not shown');
  assert.deepEqual(store.data.calls.map((c) => c.state), ['pending'], 'but its salt is kept so a retry is safe');
  assert.equal((await service.commitCall('b1', 'primary')).state, 'committed', 'it works once the chain does');
  assert.equal(store.data.calls.length, 1);
});

test('reveal: a bet that was sold back keeps its call sealed until its market settles, and nothing more is written before then', async () => {
  const { service, chain, bets } = setup();
  bets.add();
  const call = await service.commitCall('b1', 'primary');
  const written = chain.txs.length;
  bets.bets.get('b1')!.status = 'cashed_out'; // the executor sold both orders; the bet will never have a settlement
  await rejects(service.revealCall(call.id, 'primary'), 'cashed_out');
  assert.equal(service.listCalls('primary')[0]!.state, 'committed');
  assert.equal(chain.txs.length, written);
  // A bet that is already cashed out cannot have a call recorded for it afterwards either.
  bets.add({ id: 'b2', status: 'cashed_out' });
  await rejects(service.commitCall('b2', 'primary'), 'bet_not_eligible');
});

test('reveal: once the market settles, a sold-back bet\'s call is revealed and scored like any other', async () => {
  // Selling early does not change whether the call was right. The executor records how it turned out (`called`) and the
  // call is scored against the fair price it was made at, exactly as if the bet had been held.
  const { service, chain, bets } = setup();
  bets.add(); // b1: sold back, and the call came off
  bets.add(); // b2: sold back, and it did not
  bets.add(); // b3: sold back, and the first half failed
  const [hit, miss, off] = [await service.commitCall('b1', 'primary'), await service.commitCall('b2', 'primary'), await service.commitCall('b3', 'primary')];
  for (const id of ['b1', 'b2', 'b3']) bets.bets.get(id)!.status = 'cashed_out';
  bets.bets.get('b1')!.called = { conditionResolved: 'yes', targetResolved: 'yes' };
  bets.bets.get('b2')!.called = { conditionResolved: 'yes', targetResolved: 'no' };
  bets.bets.get('b3')!.called = { conditionResolved: 'no', targetResolved: 'no' };

  const won = await service.revealCall(hit.id, 'primary');
  assert.equal(won.state, 'revealed');
  assert.equal(won.reveal?.outcome, 1);
  assert.equal(won.reveal?.edge, 0.59); // 1 minus the fair price of 0.41 at entry
  const lost = await service.revealCall(miss.id, 'primary');
  assert.equal(lost.reveal?.outcome, 0);
  assert.equal(lost.reveal?.edge, -0.41);
  assert.equal((parseMemo(chain.txs.at(-1)!.memo) as RevealMemo).o, 0);
  assert.equal((await service.verifyCall(hit.id, 'primary')).matches, true);

  // The first half failed: void, as for a bet still held, but nothing came back here because the bet had been sold.
  await assert.rejects(service.revealCall(off.id, 'primary'), (e: unknown) => e instanceof ServiceError && e.code === 'void_call' && !/stake came back/.test(e.message));
  assert.equal(service.listCalls('primary').find((c) => c.id === off.id)!.state, 'void');
});

test('reveal: not before settlement; a refunded call is void and never scored', async () => {
  const { service, chain, bets } = setup();
  bets.add();
  const call = await service.commitCall('b1', 'primary');
  await rejects(service.revealCall(call.id, 'primary'), 'not_settled');
  bets.settle('b1', 'no', 'no'); // the first half failed: stake came back
  await rejects(service.revealCall(call.id, 'primary'), 'void_call');
  assert.equal(service.listCalls('primary')[0]!.state, 'void');
  await rejects(service.revealCall(call.id, 'primary'), 'void_call');
  assert.equal(chain.txs.length, 1, 'only the commit was ever written');
});

test('reveal: publishes every input of the hash plus the outcome, and the pair verifies', async () => {
  const { service, chain, bets } = setup();
  bets.add();
  const call = await service.commitCall('b1', 'primary');
  bets.settle('b1', 'yes', 'yes');
  const done = await service.revealCall(call.id, 'primary');
  assert.equal(done.state, 'revealed');
  assert.equal(done.reveal?.outcome, 1);
  assert.equal(done.reveal?.edge, 0.59);
  assert.equal(done.reveal?.fairPriceAtEntry, 0.41);
  assert.equal(chain.txs.length, 2);
  const memo = parseMemo(chain.txs[1]!.memo) as RevealMemo;
  assert.equal(memo.t, 'r');
  assert.equal(memo.c, call.commitSignature);
  assert.equal(memo.o, 1);
  // Second reveal is a no-op that returns the same record.
  assert.equal((await service.revealCall(call.id, 'primary')).reveal?.signature, done.reveal?.signature);
  assert.equal(chain.txs.length, 2);
  const proof = await service.verifyCall(call.id, 'primary');
  assert.equal(proof.matches, true);
  assert.equal(proof.recomputedHash, call.commitHash);
});

test('reveal: a miss (condition held, target missed) scores minus the fair price', async () => {
  const { service, bets } = setup();
  bets.add();
  const call = await service.commitCall('b1', 'primary');
  bets.settle('b1', 'yes', 'no');
  const done = await service.revealCall(call.id, 'primary');
  assert.equal(done.reveal?.outcome, 0);
  assert.equal(done.reveal?.edge, -0.41);
});

test('a verifier with no database rebuilds the leaderboard from the chain alone', async () => {
  const { service, bets, fresh } = setup();
  bets.add();
  const call = await service.commitCall('b1', 'primary');
  bets.settle('b1', 'yes', 'yes');
  await service.revealCall(call.id, 'primary');

  const verifier = fresh();
  const r = await verifier.backfill();
  assert.deepEqual(r, { scanned: 2, added: 2 });
  const board = verifier.leaderboard();
  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0]!.calls, 1);
  assert.equal(board.rows[0]!.edge, 0.59);
  assert.equal(board.rows[0]!.hitRate, 1);
  assert.equal(board.rows[0]!.handle, call.handle);
  // Running it again finds nothing new.
  assert.deepEqual(await verifier.backfill(), { scanned: 2, added: 0 });
});

test('a shallow backfill reads one page of signatures; the default reads up to five', async () => {
  const { chain, service, bets, fresh } = setup();
  bets.add();
  const call = await service.commitCall('b1', 'primary');
  bets.settle('b1', 'yes', 'yes');
  await service.revealCall(call.id, 'primary');
  const verifier = fresh();
  let asked = 0;
  const original = chain.recentSignatures.bind(chain);
  chain.recentSignatures = (limit, before) => {
    asked++;
    return original(limit, before);
  };
  await verifier.backfill(1, 1);
  assert.equal(asked, 1, 'one page when asked for one');
  asked = 0;
  await verifier.backfill(1, 5);
  assert.equal(asked, 3, 'two full pages of 1, then an empty page ends the scan');
});

test('ingest ignores memos not signed by an authority, and memos that are not ours', async () => {
  const { chain, service, fresh } = setup();
  const verifier = fresh();
  const bogus = chain.forge(encode({ g: 1, t: 'c', h: 'a'.repeat(64), u: 'quiet-otter-42', at: 1 }), 'SomeoneElse11111111111111111111111111111111');
  assert.equal(await verifier.ingest(bogus.signature, 'stream'), 'ignored');
  const junk = chain.forge('hello world', chain.authority);
  assert.equal(await verifier.ingest(junk.signature, 'stream'), 'ignored');
  assert.equal(await verifier.ingest('1'.repeat(88), 'stream'), 'ignored', 'a signature that is not on chain');
  assert.equal(Object.keys(verifier.store.data.commits).length, 0);
  void service;
});

test('ingest: a forged reveal that does not reproduce its commit is recorded as unverified and never scored', async () => {
  const { service, chain, bets, fresh } = setup();
  bets.add();
  const call = await service.commitCall('b1', 'primary');
  // An (authority-signed) reveal that claims a much lower fair price than was committed, to inflate the edge.
  const row = service['store'].data.calls[0]!;
  const forged: RevealMemo = {
    g: 1, t: 'r', c: call.commitSignature, u: call.handle, b: row.fields.betId, e: row.fields.event, k: row.fields.condition, x: row.fields.target,
    p: row.fields.entryPrice, f: 0.05, at: row.fields.at, s: row.salt, o: 1,
  };
  const sent = chain.forge(encode(forged), chain.authority);
  const verifier = fresh();
  assert.equal(await verifier.ingest(call.commitSignature, 'rpc'), 'new');
  assert.equal(await verifier.ingest(sent.signature, 'rpc'), 'unverified');
  assert.equal(verifier.store.data.reveals[sent.signature]?.reason, 'hash_mismatch');
  assert.deepEqual(verifier.leaderboard().rows, []);
});

test('ingest: only the first reveal of a commit counts', async () => {
  const { service, chain, bets, fresh } = setup();
  bets.add();
  const call = await service.commitCall('b1', 'primary');
  bets.settle('b1', 'yes', 'yes');
  const done = await service.revealCall(call.id, 'primary');
  // The same, valid reveal written a second time.
  const again = chain.forge(chain.txs.find((t) => t.signature === done.reveal!.signature)!.memo, chain.authority);
  const verifier = fresh();
  await verifier.backfill();
  assert.equal(verifier.leaderboard().rows[0]!.calls, 1);
  assert.equal(verifier.store.data.reveals[again.signature]?.reason, 'duplicate_reveal');
});

test('ingest: a reveal whose commit is not yet visible is not stored, and is picked up once it is', async () => {
  const { service, chain, bets, fresh } = setup();
  bets.add();
  const call = await service.commitCall('b1', 'primary');
  bets.settle('b1', 'yes', 'yes');
  const done = await service.revealCall(call.id, 'primary');
  // Hide the commit from the chain for a moment.
  const hidden = chain.txs.splice(0, 1)[0]!;
  const verifier = fresh();
  assert.equal(await verifier.ingest(done.reveal!.signature, 'rpc'), 'unverified');
  assert.equal(Object.keys(verifier.store.data.reveals).length, 0);
  chain.txs.unshift(hidden);
  assert.equal(await verifier.ingest(done.reveal!.signature, 'rpc'), 'new');
  assert.equal(verifier.leaderboard().rows.length, 1);
});

test('ingest from the Stream retries briefly when the node has not confirmed the transaction yet', async () => {
  const { service, chain, bets, fresh } = setup();
  bets.add();
  const call = await service.commitCall('b1', 'primary');
  const tx = chain.txs.splice(0, 1)[0]!;
  let waits = 0;
  const verifier = fresh({
    sleep: async () => {
      waits++;
      if (waits === 2) chain.txs.push(tx); // it shows up on the third look
    },
  });
  assert.equal(await verifier.ingest(call.commitSignature, 'stream'), 'new');
  assert.equal(waits, 2);
});

test('leaderboard: ranks by total edge, applies the minimum-calls rule, and counts hit rate', async () => {
  const { chain, bets, fresh } = setup();
  // Three players with their own authority-signed commit/reveal pairs, written directly.
  const rows: Array<[string, number, 0 | 1][]> = [
    [['calm-fox-11', 0.4, 1], ['calm-fox-11', 0.5, 1], ['calm-fox-11', 0.3, 0]], // 0.6 + 0.5 - 0.3 = 0.8
    [['bold-lynx-22', 0.2, 1]], // 0.8 over one call
    [['wry-hare-33', 0.6, 0], ['wry-hare-33', 0.6, 0]], // -1.2
  ];
  let i = 0;
  for (const player of rows) {
    for (const [handle, fair, outcome] of player) {
      const f = { betId: `p${++i}`, event: 'EV', condition: 'C', target: 'T', entryPrice: fair + 0.03, fairPrice: fair, at: 1000 + i };
      const salt = (i.toString(16).padStart(2, '0')).repeat(16);
      const c = chain.forge(encode({ g: 1, t: 'c', h: commitHash(f, salt), u: handle, at: f.at }), chain.authority);
      chain.forge(encode({ g: 1, t: 'r', c: c.signature, u: handle, b: f.betId, e: f.event, k: f.condition, x: f.target, p: f.entryPrice, f: fair, at: f.at, s: salt, o: outcome }), chain.authority);
    }
  }
  // Two more calls by one player that were sealed and never revealed. A commit carries its handle, so they still count
  // as calls made: a record cannot be built by keeping the losing ones sealed.
  for (const n of [1, 2]) {
    const f = { betId: `kept${n}`, event: 'EV', condition: 'C', target: 'T', entryPrice: 0.5, fairPrice: 0.45, at: 2000 + n };
    chain.forge(encode({ g: 1, t: 'c', h: commitHash(f, `${n}f`.repeat(16)), u: 'bold-lynx-22', at: f.at }), chain.authority);
  }
  void bets;
  const all = fresh({ minCalls: 1 });
  await all.backfill();
  const board = all.leaderboard();
  assert.deepEqual(board.rows.map((r) => [r.rank, r.handle, r.calls, r.edge]), [
    [1, 'calm-fox-11', 3, 0.8],
    [2, 'bold-lynx-22', 1, 0.8],
    [3, 'wry-hare-33', 2, -1.2],
  ]);
  assert.deepEqual(board.rows.map((r) => [r.handle, r.sealed, r.refunded]), [
    ['calm-fox-11', 3, 0], // every sealed call revealed
    ['bold-lynx-22', 3, 0], // one of three revealed: the gap is on the board
    ['wry-hare-33', 2, 0],
  ]);
  assert.equal(board.rows[0]!.hitRate, 2 / 3);
  const strict = fresh({ minCalls: 2 });
  await strict.backfill();
  assert.deepEqual(strict.leaderboard().rows.map((r) => r.handle), ['calm-fox-11', 'wry-hare-33'], 'one-call players are held back until they have enough calls');
});

test('leaderboard: a player\'s row says how many calls they sealed, and how many of those were refunded and cannot be revealed', async () => {
  const { service, bets } = setup({ minCalls: 1, selfIngest: true });
  bets.add(); // b1: revealed as a hit
  bets.add(); // b2: the first half fails, so the stake comes back and the call is void
  bets.add(); // b3: sealed, settled as a miss, and never revealed
  const [hit, refunded, kept] = [await service.commitCall('b1', 'primary'), await service.commitCall('b2', 'primary'), await service.commitCall('b3', 'primary')];
  bets.settle('b1', 'yes', 'yes');
  bets.settle('b2', 'no', 'no');
  bets.settle('b3', 'yes', 'no');
  await service.revealCall(hit.id, 'primary');
  await rejects(service.revealCall(refunded.id, 'primary'), 'void_call');
  void kept;

  const row = service.leaderboard().rows[0]!;
  assert.equal(row.calls, 1); // what is scored
  assert.equal(row.sealed, 3); // what was called: on chain under the handle, whether or not it was ever revealed
  assert.equal(row.refunded, 1); // of the two not revealed, one could not have been
  assert.equal(row.hitRate, 1); // the rate is over revealed calls only, which is why the other two numbers sit beside it
});

test('a refunded call is counted as refunded without anyone trying to reveal it', async () => {
  // The page never offers to reveal a call whose first half failed, so nothing used to mark it: on a board that shows
  // calls sealed beside calls revealed, it would have read as a call the player was keeping back.
  const { service, chain, bets } = setup({ minCalls: 1, selfIngest: true });
  bets.add(); // b1: revealed as a hit
  bets.add(); // b2: the first half fails, the stake comes back, and nobody ever asks to reveal it
  bets.add(); // b3: still open
  bets.add(); // b4: sold back, then its first half failed
  const [hit, refunded, open, sold] = [await service.commitCall('b1', 'primary'), await service.commitCall('b2', 'primary'), await service.commitCall('b3', 'primary'), await service.commitCall('b4', 'primary')];
  bets.settle('b1', 'yes', 'yes');
  await service.revealCall(hit.id, 'primary');
  assert.equal(service.leaderboard().rows[0]!.refunded, 0);

  bets.settle('b2', 'no', 'no');
  bets.bets.get('b4')!.status = 'cashed_out';
  bets.bets.get('b4')!.called = { conditionResolved: 'no', targetResolved: 'no' };
  const written = chain.txs.length;
  assert.equal(await service.noteRefunds(), 2);
  assert.equal(chain.txs.length, written); // nothing goes on chain for a refund
  const states = Object.fromEntries(service.listCalls('primary').map((c) => [c.id, c.state]));
  assert.deepEqual([states[hit.id], states[refunded.id], states[open.id], states[sold.id]], ['revealed', 'void', 'committed', 'void']);
  const row = service.leaderboard().rows[0]!;
  assert.deepEqual([row.calls, row.sealed, row.refunded], [1, 4, 2]);
  assert.equal(await service.noteRefunds(), 0); // found once
});

test('looking for refunds waits its turn: it is throttled, and a bet service that is down is tried again later', async () => {
  let clock = new Date('2026-11-18T01:30:00Z');
  const { service, bets } = setup({ minCalls: 1, selfIngest: true, now: () => clock });
  bets.add();
  const call = await service.commitCall('b1', 'primary');
  bets.settle('b1', 'no', 'no');
  const real = bets.getBet.bind(bets);
  let asked = 0;
  let down = true;
  bets.getBet = async (id) => {
    asked++;
    if (down) throw new ServiceError(502, 'executor_unreachable', 'down');
    return real(id);
  };
  service.noteRefundsSoon();
  service.noteRefundsSoon(); // the second is dropped: one is already running
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(asked, 1);
  assert.equal(service.listCalls('primary')[0]!.state, 'committed'); // the service was down: nothing was decided
  down = false;
  service.noteRefundsSoon(); // too soon after the last pass
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(asked, 1);
  clock = new Date(clock.getTime() + 21_000);
  service.noteRefundsSoon();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(service.listCalls('primary').find((c) => c.id === call.id)!.state, 'void');
});

test('leaderboard names the program and the keys it counts, so a browser can read the same scores from Solana itself', async () => {
  // Without a program, records are Memos only and there are no score accounts to read: the page must be told so.
  const memosOnly = setup();
  const plain = memosOnly.service.leaderboard();
  assert.equal(plain.program, null);
  assert.deepEqual(plain.authorities, [memosOnly.chain.authority]);

  // With a program and a second trusted key, both keys are named: the rows count reveals signed by either.
  const program = '8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK';
  const extra = 'ExtraAuthority11111111111111111111111111111';
  const chain = Object.assign(new FakeChain(), { program });
  const board = setup({ chain, authorities: [chain.authority, extra] }).service.leaderboard();
  assert.equal(board.program, program);
  assert.deepEqual(board.authorities, [chain.authority, extra]);
  assert.deepEqual(board.rows, []);
});

test('leaderboard source says where the rows came from', async () => {
  const { service, bets, fresh } = setup();
  bets.add();
  const call = await service.commitCall('b1', 'primary');
  bets.settle('b1', 'yes', 'yes');
  const done = await service.revealCall(call.id, 'primary');
  const viaRpc = fresh();
  await viaRpc.backfill();
  assert.equal(viaRpc.leaderboard().source, 'rpc');
  const viaStream = fresh();
  await viaStream.ingest(call.commitSignature, 'stream');
  await viaStream.ingest(done.reveal!.signature, 'stream');
  assert.equal(viaStream.leaderboard().source, 'quicknode-stream');
});

test('self-ingest (dev without a Stream) shows our own reveal at once; without it, the board waits for the chain feed', async () => {
  const on = setup({ selfIngest: true });
  on.bets.add();
  const c1 = await on.service.commitCall('b1', 'primary');
  on.bets.settle('b1', 'yes', 'yes');
  await on.service.revealCall(c1.id, 'primary');
  assert.equal(on.service.leaderboard().rows.length, 1);

  const off = setup({ selfIngest: false });
  off.bets.add();
  const c2 = await off.service.commitCall('b1', 'primary');
  off.bets.settle('b1', 'yes', 'yes');
  await off.service.revealCall(c2.id, 'primary');
  assert.equal(off.service.leaderboard().rows.length, 0, 'not until the Stream or backfill delivers it');
  await off.service.backfill();
  assert.equal(off.service.leaderboard().rows.length, 1);
});

test('backfill pages through more transactions than one page holds', async () => {
  const { service, chain, bets, fresh } = setup();
  for (let i = 1; i <= 5; i++) {
    bets.add({ id: `m${i}` });
    await service.commitCall(`m${i}`, 'primary');
  }
  assert.equal(chain.txs.length, 5);
  const verifier = fresh();
  assert.deepEqual(await verifier.backfill(2, 5), { scanned: 5, added: 5 });
});

test('backfill avoids refetching confirmed irrelevant memos but retries transactions not yet visible', async () => {
  const { chain, fresh } = setup();
  const unrelated = chain.forge('some other application', chain.authority);
  const pending = chain.forge(encode({ g: 1, t: 'c', h: 'a'.repeat(64), u: 'test', at: 1 }), chain.authority);
  const getTx = chain.getTx.bind(chain);
  const calls = new Map<string, number>();
  chain.getTx = async (sig) => {
    calls.set(sig, (calls.get(sig) ?? 0) + 1);
    if (sig === pending.signature && calls.get(sig) === 1) return null;
    return getTx(sig);
  };
  const verifier = fresh();
  assert.equal((await verifier.backfill()).added, 0);
  assert.equal((await verifier.backfill()).added, 1, 'a transaction unavailable on the first scan is retried');
  assert.equal((await verifier.backfill()).added, 0);
  assert.equal(calls.get(unrelated.signature), 1, 'a confirmed non-Given memo is fetched only once');
  assert.equal(calls.get(pending.signature), 2, 'the valid memo remains eligible after a missing result');
});

test('ingest caches a confirmed untrusted signer without caching RPC failures', async () => {
  const { chain, fresh } = setup();
  const forged = chain.forge(encode({ g: 1, t: 'c', h: 'b'.repeat(64), u: 'test', at: 1 }), 'other-authority');
  const getTx = chain.getTx.bind(chain);
  let calls = 0;
  chain.getTx = async (sig) => {
    calls++;
    if (calls === 1) throw new Error('temporary RPC failure');
    return getTx(sig);
  };
  const verifier = fresh();
  await assert.rejects(verifier.ingest(forged.signature, 'rpc'), /temporary RPC failure/);
  assert.equal(await verifier.ingest(forged.signature, 'rpc'), 'ignored');
  assert.equal(await verifier.ingest(forged.signature, 'rpc'), 'ignored');
  assert.equal(calls, 2, 'the error was retried and the confirmed untrusted signer was cached');
});

test('verify: tampering with what is on chain is detected', async () => {
  const { service, chain, bets } = setup();
  bets.add();
  const call = await service.commitCall('b1', 'primary');
  bets.settle('b1', 'yes', 'yes');
  await service.revealCall(call.id, 'primary');
  assert.equal((await service.verifyCall(call.id, 'primary')).matches, true);
  const reveal = parseMemo(chain.txs[1]!.memo) as RevealMemo;
  chain.txs[1]!.memo = JSON.stringify({ ...reveal, f: 0.01 });
  assert.equal((await service.verifyCall(call.id, 'primary')).matches, false);
  await rejects(service.verifyCall('nope', 'primary'), 'unknown_call');
});
