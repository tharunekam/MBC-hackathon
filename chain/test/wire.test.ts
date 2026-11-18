/**
 * The REAL Solana code (web3.js, signing, sending, polling, parsing) against a stand-in node that speaks the real
 * JSON-RPC protocol. These are the failures a first run with a funded wallet can hit: no SOL, an expired blockhash,
 * a dropped transaction, a rate limit. No network, no SOL.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { SolanaChain } from '../src/chain.ts';
import { ChainService } from '../src/service.ts';
import { Store } from '../src/store.ts';
import { startFakeRpc } from './fake-rpc.ts';
import type { FakeRpc } from './fake-rpc.ts';
import { FakeBets } from './helpers.ts';

let rpc: FakeRpc;
before(async () => {
  rpc = await startFakeRpc();
});
after(async () => {
  await rpc.close();
});

const fast = { pollMs: 20, confirmTimeoutMs: 2000 };
const funded = (lamports = 1_000_000) => {
  const kp = Keypair.generate();
  rpc.fund(kp.publicKey.toBase58(), lamports);
  return { kp, chain: new SolanaChain(rpc.url, kp, fast) };
};

describe('SolanaChain over the wire', () => {
  it('an unfunded authority fails with an instruction a person can follow, and nothing is recorded', async () => {
    const kp = Keypair.generate();
    const chain = new SolanaChain(rpc.url, kp, fast);
    const before = rpc.txs().length;
    await assert.rejects(chain.sendMemo('hello'), (err: Error) => {
      assert.match(err.message, new RegExp(kp.publicKey.toBase58()));
      assert.match(err.message, /faucet\.solana\.com/);
      return true;
    });
    assert.equal(rpc.txs().length, before);
    assert.equal(await chain.balanceLamports(), 0);
  });

  it('records a memo, reads it back with the signer, and charges one fee', async () => {
    const { kp, chain } = funded();
    const sent = await chain.sendMemo('given test memo ✓');
    assert.match(sent.signature, /^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    const tx = await chain.getTx(sent.signature);
    assert.ok(tx);
    assert.equal(tx.memo, 'given test memo ✓');
    assert.equal(tx.signer, kp.publicKey.toBase58());
    assert.equal(tx.slot, sent.slot);
    assert.ok(tx.blockTime && Math.abs(tx.blockTime - Date.now() / 1000) < 30);
    assert.equal(await chain.balanceLamports(), 1_000_000 - 5000);
  });

  it('an unknown signature is null, not an error', async () => {
    const { chain } = funded();
    const sent = await chain.sendMemo('x');
    const other = sent.signature.replace(/.$/, sent.signature.endsWith('A') ? 'B' : 'A');
    assert.equal(await chain.getTx(other), null);
  });

  it('lists the authority’s transactions newest first and pages with `before`', async () => {
    const { chain } = funded();
    const sigs: string[] = [];
    for (let i = 0; i < 4; i++) sigs.push((await chain.sendMemo(`m${i}`)).signature);
    assert.deepEqual(await chain.recentSignatures(10), [...sigs].reverse());
    assert.deepEqual(await chain.recentSignatures(2), [sigs[3], sigs[2]]);
    assert.deepEqual(await chain.recentSignatures(2, sigs[2]), [sigs[1], sigs[0]]);
  });

  it('confirms by polling over HTTP only (no WebSocket needed)', async () => {
    const { chain } = funded();
    rpc.calls.clear();
    await chain.sendMemo('poll');
    assert.ok((rpc.calls.get('getSignatureStatuses') ?? 0) >= 1);
    assert.equal(rpc.calls.get('sendTransaction'), 1);
  });

  it('a blockhash that expires before the transaction lands is retried once, and never double-writes', async () => {
    const { chain } = funded();
    rpc.calls.clear();
    const before = rpc.txs().length;
    rpc.dropNext(); // the first send is accepted but never lands
    setTimeout(() => rpc.expireBlockhashes(), 80); // and its blockhash then expires
    const sent = await chain.sendMemo('retry me');
    assert.equal(rpc.calls.get('sendTransaction'), 2);
    assert.equal(rpc.txs().length - before, 1, 'exactly one record on chain');
    assert.equal((await chain.getTx(sent.signature))?.memo, 'retry me');
  });

  it('a transaction that is neither confirmed nor expired times out and is NOT retried', async () => {
    const kp = Keypair.generate();
    rpc.fund(kp.publicKey.toBase58(), 1_000_000);
    const chain = new SolanaChain(rpc.url, kp, { pollMs: 20, confirmTimeoutMs: 250 });
    rpc.calls.clear();
    rpc.dropNext();
    await assert.rejects(chain.sendMemo('lost'), /may still land/);
    assert.equal(rpc.calls.get('sendTransaction'), 1, 'an unknown outcome must not be re-sent');
  });

  it('survives one rate-limit response', async () => {
    const { chain } = funded();
    rpc.rateLimitNext(1);
    const sent = await chain.sendMemo('429');
    assert.equal((await chain.getTx(sent.signature))?.memo, '429');
  });

  it('reports a refusal from the node in plain words', async () => {
    const { chain } = funded();
    rpc.failSendNext('Program failed to complete');
    await assert.rejects(chain.sendMemo('nope'), /Solana refused the transaction:[\s\S]*Program failed/);
  });

  it('a memo too big for one transaction is refused before anything is sent', async () => {
    const { chain } = funded();
    rpc.calls.clear();
    await assert.rejects(chain.sendMemo('x'.repeat(1300)), /does not fit in one Solana transaction/);
    assert.equal(rpc.calls.get('sendTransaction') ?? 0, 0);
  });
});

describe('the chain service on the wire', () => {
  const bet = (bets: FakeBets) => bets.add({ id: 'wire1', offer: { fairPrice: 0.5 } });

  it('commit → settle → reveal → verify, and a stranger’s memo changes nothing', async () => {
    const { kp, chain } = funded();
    const bets = new FakeBets();
    bet(bets);
    const service = new ChainService({ chain, store: new Store(null, () => 'secret'), bets, sleep: async () => {}, selfIngest: true, log: () => {} });

    const call = await service.commitCall('wire1', 'primary');
    assert.equal(call.state, 'committed');
    bets.settle('wire1', 'yes', 'yes');
    const revealed = await service.revealCall(call.id, 'primary');
    assert.equal(revealed.state, 'revealed');

    // A stranger writes something that looks like ours. It must not count.
    const stranger = funded();
    await stranger.chain.sendMemo(JSON.stringify({ g: 1, t: 'c', h: 'a'.repeat(64), u: 'primary', at: 1 }));

    // A verifier that knows nothing but the authority's public key rebuilds the board from Solana.
    const fresh = new ChainService({ chain, store: new Store(null, () => 'other'), bets, sleep: async () => {}, selfIngest: false, log: () => {} });
    for (const sig of (await chain.recentSignatures(50)).reverse()) await fresh.ingest(sig, 'rpc');
    const rows = fresh.leaderboard().rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.calls, 1);
    assert.ok(Math.abs(rows[0]!.edge - 0.5) < 1e-9, 'target hit at fair 0.5 is +0.5 edge');

    const check = await service.verifyCall(call.id, 'primary');
    assert.equal(check.matches, true);
    assert.equal(rpc.balance(kp.publicKey.toBase58()), 1_000_000 - 2 * 5000);
  });

  it('an unfunded wallet turns a commit into a clear error, the log names the wallet, and nothing is half-written', async () => {
    const kp = Keypair.generate(); // never funded
    const chain = new SolanaChain(rpc.url, kp, fast);
    const bets = new FakeBets();
    bet(bets);
    const logged: string[] = [];
    const service = new ChainService({ chain, store: new Store(null, () => 's'), bets, sleep: async () => {}, log: (l) => logged.push(l) });
    await assert.rejects(service.commitCall('wire1', 'primary'), (err: Error & { code?: string }) => {
      assert.equal(err.code, 'chain_unfunded');
      assert.match(err.message, /out of funds/i);
      return true;
    });
    assert.match(logged.join('\n'), new RegExp(kp.publicKey.toBase58()), 'the operator log names the wallet to fund');
    // Fund it and the same call now succeeds: nothing was half-written.
    rpc.fund(kp.publicKey.toBase58(), 1_000_000);
    assert.equal((await service.commitCall('wire1', 'primary')).state, 'committed');
  });
});
