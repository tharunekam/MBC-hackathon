import { describe, expect, it } from 'vitest';
import realCall from './fixtures/devnet-program-call.json';
import { assetOf, callQuestion, commitHash, memoTx, preimage, strikeOf, verifyOnChain } from './verify';
import type { CallFields, Rpc } from './verify';

// The same vector as chain/test/memo.test.ts. The hash literal was produced by chain/src/hash.ts, so if either side
// changes its format this test (or the chain one) fails.
const FIELDS: CallFields = {
  betId: 'd1a2b3',
  event: 'BTC2611190100',
  condition: 'GEMI-BTC2611190100-HI62500',
  target: 'GEMI-BTC2611190100-HI63500',
  entryPrice: 0.4375,
  fairPrice: 0.41,
  at: 1763433000,
};
const SALT = 'aa'.repeat(16);
const HASH = 'aa90dde78ef414dc574024520f95bc8c95bb023e34b50690d935b8169f4e5c7c';
const AUTH = 'AuthorityKey1111111111111111111111111111111';
const COMMIT_SIG = '4'.repeat(88);
const REVEAL_SIG = '5'.repeat(88);

describe('format parity with the chain service', () => {
  it('the preimage is the pinned string', () => {
    expect(preimage(FIELDS, SALT)).toBe('given1|d1a2b3|BTC2611190100|GEMI-BTC2611190100-HI62500|GEMI-BTC2611190100-HI63500|0.437500|0.410000|1763433000|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });
  it('the hash equals the one chain/src/hash.ts produces', async () => {
    expect(await commitHash(FIELDS, SALT)).toBe(HASH);
  });
});

const commitMemo = { g: 1, t: 'c', h: HASH, u: 'quiet-otter-42', at: FIELDS.at };
const revealMemo = { g: 1, t: 'r', c: COMMIT_SIG, u: 'quiet-otter-42', b: FIELDS.betId, e: FIELDS.event, k: FIELDS.condition, x: FIELDS.target, p: FIELDS.entryPrice, f: FIELDS.fairPrice, at: FIELDS.at, s: SALT, o: 1 };

const tx = (memo: unknown, signer = AUTH, err: unknown = null) => ({
  slot: 100,
  meta: { err },
  transaction: { message: { instructions: [{ program: 'spl-memo', parsed: typeof memo === 'string' ? memo : JSON.stringify(memo) }], accountKeys: [{ pubkey: signer, signer: true }] } },
});

/** A fake Solana node holding the given transactions. */
const node = (txs: Record<string, unknown>): Rpc => async (method, params) => (method === 'getTransaction' ? (txs[params[0] as string] ?? null) : null);

describe('verifyOnChain', () => {
  const good = { [REVEAL_SIG]: tx(revealMemo), [COMMIT_SIG]: tx(commitMemo) };

  it('passes when the reveal reproduces a commit, both signed by our key', async () => {
    const v = await verifyOnChain(node(good), REVEAL_SIG, AUTH);
    expect(v.ok).toBe(true);
    expect(v.checks.map((c) => c.id)).toEqual(['reveal-found', 'reveal-signer', 'commit-found', 'commit-signer', 'link', 'hash']);
    expect(v.checks.every((c) => c.ok)).toBe(true);
    expect(v.commitSignature).toBe(COMMIT_SIG);
  });

  it('fails at the hash when any revealed field was changed after the commit', async () => {
    for (const change of [{ f: 0.05 }, { p: 0.3 }, { x: 'GEMI-BTC2611190100-HI64000' }, { s: 'bb'.repeat(16) }, { b: 'other' }]) {
      const v = await verifyOnChain(node({ ...good, [REVEAL_SIG]: tx({ ...revealMemo, ...change }) }), REVEAL_SIG, AUTH);
      expect(v.ok).toBe(false);
      expect(v.checks.at(-1)?.id).toBe('hash');
    }
  });

  it('fails when either record was signed by some other key', async () => {
    const a = await verifyOnChain(node({ ...good, [REVEAL_SIG]: tx(revealMemo, 'Mallory') }), REVEAL_SIG, AUTH);
    expect(a.checks.at(-1)).toMatchObject({ id: 'reveal-signer', ok: false });
    const b = await verifyOnChain(node({ ...good, [COMMIT_SIG]: tx(commitMemo, 'Mallory') }), REVEAL_SIG, AUTH);
    expect(b.checks.at(-1)).toMatchObject({ id: 'commit-signer', ok: false });
  });

  it('fails when the commit is missing, failed on chain, or from a different player or time', async () => {
    expect((await verifyOnChain(node({ [REVEAL_SIG]: tx(revealMemo) }), REVEAL_SIG, AUTH)).checks.at(-1)).toMatchObject({ id: 'commit-found', ok: false });
    expect((await verifyOnChain(node({ ...good, [COMMIT_SIG]: tx(commitMemo, AUTH, { InstructionError: [0, 'x'] }) }), REVEAL_SIG, AUTH)).checks.at(-1)?.id).toBe('commit-found');
    expect((await verifyOnChain(node({ ...good, [COMMIT_SIG]: tx({ ...commitMemo, u: 'amber-wren-11' }) }), REVEAL_SIG, AUTH)).checks.at(-1)?.id).toBe('link');
    expect((await verifyOnChain(node({ ...good, [COMMIT_SIG]: tx({ ...commitMemo, at: 5 }) }), REVEAL_SIG, AUTH)).checks.at(-1)?.id).toBe('link');
  });

  it('fails cleanly on a signature that is not a Given reveal', async () => {
    expect((await verifyOnChain(node({}), REVEAL_SIG, AUTH)).checks.at(-1)).toMatchObject({ id: 'reveal-found', ok: false });
    expect((await verifyOnChain(node({ [REVEAL_SIG]: tx('hello') }), REVEAL_SIG, AUTH)).ok).toBe(false);
    expect((await verifyOnChain(node({ [REVEAL_SIG]: tx(commitMemo) }), REVEAL_SIG, AUTH)).checks.at(-1)?.id).toBe('reveal-found');
  });

  it('rejects a reveal pointing at a commit whose hash is for a different call', async () => {
    const other = { ...commitMemo, h: 'f'.repeat(64) };
    expect((await verifyOnChain(node({ ...good, [COMMIT_SIG]: tx(other) }), REVEAL_SIG, AUTH)).checks.at(-1)?.id).toBe('hash');
  });
});

describe('helpers', () => {
  it('memoTx ignores transactions without a memo or that failed', async () => {
    expect(await memoTx(node({ a: tx('x', AUTH, { err: 1 }) }), 'a')).toBeNull();
    expect(await memoTx(node({}), 'a')).toBeNull();
    expect((await memoTx(node({ a: tx('hi') }), 'a'))?.memo).toBe('hi');
  });
  it('reads a strike and an asset from Gemini symbols', () => {
    expect(strikeOf('GEMI-BTC2611190100-HI62500')).toBe(62500);
    expect(strikeOf('GEMI-XRP2611190100-HI2.45')).toBe(2.45);
    expect(strikeOf('weird')).toBeNull();
    expect(assetOf('BTC2611190100')).toBe('BTC');
  });
});

describe('the on-chain program check', () => {
  const PROGRAM = 'Program1111111111111111111111111111111111111';
  const withProgram = (memo: unknown, signer = AUTH) => {
    const t = tx(memo, signer);
    t.transaction.message.instructions.push({ programId: PROGRAM } as never);
    return t;
  };
  const node = (txs: Record<string, unknown>): Rpc => async (_m, params) => txs[params[0] as string] ?? null;

  it('is informational when the program ran on both transactions', async () => {
    const v = await verifyOnChain(node({ [REVEAL_SIG]: withProgram(revealMemo), [COMMIT_SIG]: withProgram(commitMemo) }), REVEAL_SIG, AUTH, PROGRAM);
    expect(v.ok).toBe(true);
    const k = v.checks.find((c) => c.id === 'program')!;
    expect(k).toMatchObject({ ok: true, optional: true });
  });

  it('a Memo-only record still verifies, and says so without failing', async () => {
    const v = await verifyOnChain(node({ [REVEAL_SIG]: tx(revealMemo), [COMMIT_SIG]: tx(commitMemo) }), REVEAL_SIG, AUTH, PROGRAM);
    expect(v.ok).toBe(true);
    expect(v.checks.find((c) => c.id === 'program')).toMatchObject({ ok: false, optional: true, label: 'Recorded as a Memo only' });
  });

  it('a program on only one of the two transactions is not reported as checked', async () => {
    const v = await verifyOnChain(node({ [REVEAL_SIG]: withProgram(revealMemo), [COMMIT_SIG]: tx(commitMemo) }), REVEAL_SIG, AUTH, PROGRAM);
    expect(v.checks.find((c) => c.id === 'program')!.ok).toBe(false);
  });

  it('adds no row when the service has no program', async () => {
    const v = await verifyOnChain(node({ [REVEAL_SIG]: tx(revealMemo), [COMMIT_SIG]: tx(commitMemo) }), REVEAL_SIG, AUTH, null);
    expect(v.checks.some((c) => c.id === 'program')).toBe(false);
  });

  it('a tampered reveal still fails whatever the program says', async () => {
    const forged = { ...revealMemo, f: 0.01 };
    const v = await verifyOnChain(node({ [REVEAL_SIG]: withProgram(forged), [COMMIT_SIG]: withProgram(commitMemo) }), REVEAL_SIG, AUTH, PROGRAM);
    expect(v.ok).toBe(false);
    expect(v.checks.some((c) => c.id === 'program')).toBe(false);
  });
});

describe('real Solana devnet records', () => {
  const real = realCall as unknown as { program: string; authority: string; revealSignature: string; commitSignature: string; transactions: Record<string, unknown> };
  const node: Rpc = async (_m, params) => real.transactions[params[0] as string] ?? null;

  it('the first call recorded through the deployed program verifies in the browser, program check included', async () => {
    const v = await verifyOnChain(node, real.revealSignature, real.authority, real.program);
    expect(v.checks.filter((c) => !c.optional).every((c) => c.ok)).toBe(true);
    expect(v.ok).toBe(true);
    expect(v.checks.find((c) => c.id === 'program')).toMatchObject({ ok: true, optional: true });
    expect(v.commitSignature).toBe(real.commitSignature);
  });

  it('the same real records are rejected for any other authority', async () => {
    const v = await verifyOnChain(node, real.revealSignature, 'SomeOtherAuthority1111111111111111111111111', real.program);
    expect(v.ok).toBe(false);
    expect(v.checks.at(-1)?.id).toBe('reveal-signer');
  });
});

describe('the question a call asked, from what is on Solana', () => {
  const sym = (n: number) => `GEMI-BTC2611190100-HI${n}`;
  const base = { event: 'BTC2611190100', outcome: 1 as const };

  it('a rising parlay: given the lower strike, will it reach the higher', () => {
    const q = callQuestion({ ...base, betId: 'd1a2b3', condition: sym(62500), target: sym(63500) });
    expect(q.text).toBe('Given BTC at $62,500 or above, will it reach $63,500?');
    expect(q.result).toBe('Target reached');
    expect(q.parts.filter((p) => p.em).map((p) => p.text)).toEqual(['BTC', '$62,500', '$63,500']);
  });

  it('a falling parlay: its condition is the higher strike', () => {
    const q = callQuestion({ ...base, betId: 'dn-d1a2b3', condition: sym(64000), target: sym(62500), outcome: 0 });
    expect(q.kind).toEqual({ product: 'parlay', direction: 'down' });
    expect(q.text).toBe('Given BTC stays below $64,000, will it fall below $62,500?');
    expect(q.result).toBe('Fell short');
  });

  it('a range: the first strike is the lower, and the result is inside or outside', () => {
    const q = callQuestion({ ...base, betId: 'rg-d1a2b3', condition: sym(62500), target: sym(64000) });
    expect(q.kind.product).toBe('range');
    expect(q.text).toBe('Will BTC finish between $62,500 and $64,000?');
    expect(q.result).toBe('Finished inside');
    expect(callQuestion({ ...base, betId: 'rg-x', condition: sym(1), target: sym(2), outcome: 0 }).result).toBe('Finished outside');
  });

  it('a symbol it cannot read is shown as committed', () => {
    expect(callQuestion({ ...base, betId: 'x', condition: 'odd', target: sym(2) }).text).toBe('Given BTC at odd or above, will it reach $2?');
  });
});
