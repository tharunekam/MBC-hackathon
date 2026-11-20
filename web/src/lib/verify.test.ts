import { describe, expect, it } from 'vitest';
import realCall from './fixtures/devnet-program-call.json';
import { assetOf, callQuestion, closeTimeOf, commitHash, memoTx, preimage, strikeOf, utcTime, verdictLine, verifyOnChain } from './verify';
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

// BTC2611190100 closes 2026-11-19 01:00 UTC. The commit landed hours before that and the reveal after it, as a real call does.
const CLOSES = Date.UTC(2026, 10, 19, 1, 0) / 1000;
const T_COMMIT = CLOSES - 7200;
const T_REVEAL = CLOSES + 3600;

/**
 * A transaction as a node's jsonParsed answer has it. A reveal lands in a later slot, and a later time, than its commit unless
 * a test says otherwise; `blockTime: null` is a node that gave no time.
 */
const tx = (memo: unknown, signer = AUTH, err: unknown = null, when: { slot?: number; blockTime?: number | null } = {}) => {
  const revealing = typeof memo === 'object' && (memo as { t?: string } | null)?.t === 'r';
  const slot = when.slot ?? (revealing ? 105 : 100);
  const blockTime = when.blockTime === undefined ? (revealing ? T_REVEAL : T_COMMIT) : when.blockTime;
  return {
    slot,
    ...(blockTime === null ? {} : { blockTime }),
    meta: { err },
    transaction: { message: { instructions: [{ program: 'spl-memo', parsed: typeof memo === 'string' ? memo : JSON.stringify(memo) }], accountKeys: [{ pubkey: signer, signer: true }] } },
  };
};

/** A fake Solana node holding the given transactions. */
const node = (txs: Record<string, unknown>): Rpc => async (method, params) => (method === 'getTransaction' ? (txs[params[0] as string] ?? null) : null);

describe('verifyOnChain', () => {
  const good = { [REVEAL_SIG]: tx(revealMemo), [COMMIT_SIG]: tx(commitMemo) };

  it('passes when the reveal reproduces a commit, both signed by our key', async () => {
    const v = await verifyOnChain(node(good), REVEAL_SIG, AUTH);
    expect(v.ok).toBe(true);
    expect(v.checks.map((c) => c.id)).toEqual(['reveal-found', 'reveal-signer', 'commit-found', 'commit-signer', 'link', 'hash', 'order', 'closed']);
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

  it('the same real records show their real times: sealed seconds before the reveal, and the evening before the market closed', async () => {
    const v = await verifyOnChain(node, real.revealSignature, real.authority, real.program);
    expect(v.checks.find((c) => c.id === 'order')).toMatchObject({ ok: true, detail: 'Sealed 2026-11-18 04:43:18 UTC (slot 523513407); revealed 2026-11-18 04:43:20 UTC (slot 523513412).' });
    expect(v.checks.find((c) => c.id === 'closed')).toMatchObject({ ok: true });
    expect(v.checks.find((c) => c.id === 'closed')?.detail).toContain('2026-11-19 01:00:00 UTC');
  });

  it('the same real records fail if the commit is moved to a later slot than the reveal', async () => {
    const moved = structuredClone(real.transactions) as Record<string, { slot: number }>;
    moved[real.commitSignature]!.slot = moved[real.revealSignature]!.slot + 1;
    const v = await verifyOnChain(async (_m, params) => moved[params[0] as string] ?? null, real.revealSignature, real.authority, real.program);
    expect(v.ok).toBe(false);
    expect(v.checks.at(-1)?.id).toBe('order');
  });

  it('the same real records are rejected for any other authority', async () => {
    const v = await verifyOnChain(node, real.revealSignature, 'SomeOtherAuthority1111111111111111111111111', real.program);
    expect(v.ok).toBe(false);
    expect(v.checks.at(-1)?.id).toBe('reveal-signer');
  });
});

/** A call on another event, with its own correct hash, so a test can change the event code the call published. */
async function callOn(event: string) {
  const f: CallFields = { ...FIELDS, event, condition: `GEMI-${event}-HI62500`, target: `GEMI-${event}-HI63500` };
  const hash = await commitHash(f, SALT);
  return {
    commit: { ...commitMemo, h: hash },
    reveal: { ...revealMemo, e: event, k: f.condition, x: f.target },
  };
}

describe('when a call was sealed, from Solana\'s own slots and clocks', () => {
  const good = { [REVEAL_SIG]: tx(revealMemo), [COMMIT_SIG]: tx(commitMemo) };
  const run = (txs: Record<string, unknown>) => verifyOnChain(node(txs), REVEAL_SIG, AUTH);

  it('prints the real UTC times of the seal and the reveal, and the slots', async () => {
    const v = await run(good);
    const order = v.checks.find((c) => c.id === 'order')!;
    expect(order).toMatchObject({ ok: true, label: 'Sealed before it was revealed' });
    expect(order.detail).toBe(`Sealed ${utcTime(T_COMMIT)} (slot 100); revealed ${utcTime(T_REVEAL)} (slot 105).`);
    expect(order.detail).toContain('2026-11-18 23:00:00 UTC');
    expect(order.detail).toContain('2026-11-19 02:00:00 UTC');
  });

  it('checks the seal against the market\'s close when the event code carries it, and says when the market closed', async () => {
    const v = await run(good);
    const closed = v.checks.find((c) => c.id === 'closed')!;
    expect(closed).toMatchObject({ ok: true, label: 'Sealed before the market closed' });
    expect(closed.detail).toContain('2026-11-18 23:00:00 UTC');
    expect(closed.detail).toContain('2026-11-19 01:00:00 UTC');
  });

  it('never claims "before the result": that is not something any check here can show', async () => {
    for (const txs of [good, { ...good, [COMMIT_SIG]: tx(commitMemo, AUTH, null, { blockTime: null }) }]) {
      const v = await run(txs);
      for (const c of v.checks) expect(`${c.label} ${c.detail ?? ''}`).not.toMatch(/before the result|result was known/i);
    }
    const lines = [verdictLine(await run(good)), verdictLine(await run({ ...good, [COMMIT_SIG]: tx(commitMemo, AUTH, null, { blockTime: null }) })), verdictLine({ ok: false, checks: [], commitSignature: null })];
    for (const line of lines) expect(line).not.toMatch(/before the result|result was known/i);
  });

  it('fails when the commit landed in a later slot than the reveal, even though the hash matches', async () => {
    const v = await run({ ...good, [COMMIT_SIG]: tx(commitMemo, AUTH, null, { slot: 110 }) });
    expect(v.ok).toBe(false);
    expect(v.checks.at(-1)).toMatchObject({ id: 'order', ok: false });
    expect(v.checks.find((c) => c.id === 'hash')?.ok).toBe(true);
    expect(v.checks.some((c) => c.id === 'closed')).toBe(false);
  });

  it('fails when the commit and the reveal share a slot: nothing shows which came first', async () => {
    const v = await run({ ...good, [COMMIT_SIG]: tx(commitMemo, AUTH, null, { slot: 105 }) });
    expect(v.ok).toBe(false);
    expect(v.checks.at(-1)).toMatchObject({ id: 'order', ok: false });
  });

  it('fails when the commit\'s clock time is later than the reveal\'s, whatever the slots say', async () => {
    const v = await run({ ...good, [COMMIT_SIG]: tx(commitMemo, AUTH, null, { blockTime: T_REVEAL + 1 }) });
    expect(v.ok).toBe(false);
    expect(v.checks.at(-1)).toMatchObject({ id: 'order', ok: false });
  });

  it('fails when the node does not say which slot a record landed in, rather than assuming', async () => {
    const noSlot = tx(commitMemo) as { slot?: number };
    delete noSlot.slot;
    const v = await run({ ...good, [COMMIT_SIG]: noSlot });
    expect(v.ok).toBe(false);
    expect(v.checks.at(-1)).toMatchObject({ id: 'order', ok: false });
  });

  it('fails when the seal landed after the market closed', async () => {
    const v = await run({ ...good, [COMMIT_SIG]: tx(commitMemo, AUTH, null, { blockTime: CLOSES + 60 }) });
    expect(v.ok).toBe(false);
    expect(v.checks.at(-1)).toMatchObject({ id: 'closed', ok: false, label: 'Sealed before the market closed' });
    expect(v.checks.find((c) => c.id === 'order')?.ok).toBe(true);
  });

  it('a seal in the very second the market closed is too late', async () => {
    const v = await run({ ...good, [COMMIT_SIG]: tx(commitMemo, AUTH, null, { blockTime: CLOSES }) });
    expect(v.checks.at(-1)).toMatchObject({ id: 'closed', ok: false });
  });

  it('with no clock time for the seal, the order is shown by slots and nothing is claimed about the close', async () => {
    const v = await run({ ...good, [COMMIT_SIG]: tx(commitMemo, AUTH, null, { blockTime: null }) });
    expect(v.ok).toBe(true);
    expect(v.checks.some((c) => c.id === 'closed')).toBe(false);
    const order = v.checks.find((c) => c.id === 'order')!;
    expect(order.detail).toBe('Sealed in slot 100; revealed in slot 105. Solana gave no clock time for one of them.');
    expect(verdictLine(v)).toBe('Verified. The call was sealed on Solana before it was revealed, and it was not changed afterwards.');
  });

  it('an event code that carries no close time is checked for order only, and says nothing about the close', async () => {
    for (const event of ['BTCTEST', 'ETH', 'BTC2613190100', 'BTC2611310100']) {
      const call = await callOn(event);
      const v = await run({ [REVEAL_SIG]: tx(call.reveal), [COMMIT_SIG]: tx(call.commit) });
      expect(v.ok, event).toBe(true);
      expect(v.checks.some((c) => c.id === 'closed'), event).toBe(false);
      expect(v.checks.find((c) => c.id === 'order')?.ok, event).toBe(true);
    }
  });

  it('the verdict names the close only when that check ran', async () => {
    expect(verdictLine(await run(good))).toBe('Verified. The call was sealed on Solana before the market closed and before it was revealed, and it was not changed afterwards.');
    expect(verdictLine(await run({ ...good, [COMMIT_SIG]: tx(commitMemo, AUTH, null, { slot: 110 }) }))).toBe('This call did not verify. Treat it as unproven.');
  });
});

describe('who signed it', () => {
  it('does not claim the key was checked independently: it is the key our server names, to compare with the Proof page', async () => {
    const good = { [REVEAL_SIG]: tx(revealMemo), [COMMIT_SIG]: tx(commitMemo) };
    const v = await verifyOnChain(node(good), REVEAL_SIG, AUTH);
    for (const id of ['reveal-signer', 'commit-signer'] as const) {
      const c = v.checks.find((k) => k.id === id)!;
      expect(c.label).toMatch(/signed by the key listed on the Proof page$/);
      expect(c.label).not.toMatch(/our key/i);
      expect(c.detail).toMatch(/the key our server names/);
      expect(c.detail).toContain('Author…1111'); // the key to compare, shortened as the Proof page shortens it
    }
    const bad = await verifyOnChain(node({ ...good, [REVEAL_SIG]: tx(revealMemo, 'Mallory') }), REVEAL_SIG, AUTH);
    expect(bad.checks.at(-1)).toMatchObject({ id: 'reveal-signer', ok: false, detail: 'Signed by a key other than the one our server names.' });
  });
});

describe('the event code\'s close time', () => {
  it('reads YYMMDDHHMM in UTC from the end of the code', () => {
    expect(closeTimeOf('BTC2611190100')).toBe(Date.UTC(2026, 10, 19, 1, 0) / 1000);
    expect(closeTimeOf('ETH2611180000')).toBe(Date.UTC(2026, 10, 18, 0, 0) / 1000);
    expect(closeTimeOf('SMOKE2611190100')).toBe(Date.UTC(2026, 10, 19, 1, 0) / 1000);
    expect(closeTimeOf('NGAS2611302200')).toBe(Date.UTC(2026, 10, 30, 22, 0) / 1000);
  });
  it('is null for anything that is not that shape, or not a real date', () => {
    for (const bad of ['', 'BTC', 'btc2611190100', 'BTC26111901', 'BTC261119010000', 'BTC2613190100', 'BTC2611320100', 'BTC2611310100', 'BTC2611192500', 'BTC2611190160', 'CMB-BTC2611190100']) expect(closeTimeOf(bad), bad).toBeNull();
  });
});

describe('the question a call asked, from what is on Solana', () => {
  const sym = (n: number) => `GEMI-BTC2611190100-HI${n}`;
  const base = { event: 'BTC2611190100', outcome: 1 as const };

  it('a rising parlay: given the lower strike, will it reach the higher', () => {
    const q = callQuestion({ ...base, betId: 'd1a2b3', condition: sym(62500), target: sym(63500) });
    expect(q.text).toBe('Given Bitcoin at $62,500 or above, will it reach $63,500?');
    expect(q.result).toBe('Target reached');
    expect(q.parts.filter((p) => p.em).map((p) => p.text)).toEqual(['Bitcoin', '$62,500', '$63,500']);
  });

  it('a falling parlay: its condition is the higher strike', () => {
    const q = callQuestion({ ...base, betId: 'dn-d1a2b3', condition: sym(64000), target: sym(62500), outcome: 0 });
    expect(q.kind).toEqual({ product: 'parlay', direction: 'down' });
    expect(q.text).toBe('Given Bitcoin stays under $64,000, will it fall below $62,500?');
    expect(q.result).toBe('Fell short');
  });

  it('a range: the first strike is the lower, and the result is inside or outside', () => {
    const q = callQuestion({ ...base, betId: 'rg-d1a2b3', condition: sym(62500), target: sym(64000) });
    expect(q.kind.product).toBe('range');
    expect(q.text).toBe('Will Bitcoin finish between $62,500 and $64,000?');
    expect(q.result).toBe('Finished inside');
    expect(callQuestion({ ...base, betId: 'rg-x', condition: sym(1), target: sym(2), outcome: 0 }).result).toBe('Finished outside');
  });

  it('a breakout: the same two strikes as a range, and outside is the hit', () => {
    const q = callQuestion({ ...base, betId: 'bo-d1a2b3', condition: sym(62500), target: sym(64000) });
    expect(q.kind.product).toBe('breakout');
    expect(q.text).toBe('Will Bitcoin finish outside $62,500 to $64,000?');
    expect(q.parts.filter((p) => p.em).map((p) => p.text)).toEqual(['Bitcoin', '$62,500', '$64,000']);
    expect(q.result).toBe('Finished outside');
    expect(callQuestion({ ...base, betId: 'bo-x', condition: sym(1), target: sym(2), outcome: 0 }).result).toBe('Finished inside');
  });

  it('a symbol it cannot read is shown as committed', () => {
    expect(callQuestion({ ...base, betId: 'x', condition: 'odd', target: sym(2) }).text).toBe('Given Bitcoin at odd or above, will it reach $2?');
  });
});

describe('a node that answers odd numbers', () => {
  const good = { [REVEAL_SIG]: tx(revealMemo), [COMMIT_SIG]: tx(commitMemo) };
  const run = (txs: Record<string, unknown>) => verifyOnChain(node(txs), REVEAL_SIG, AUTH);
  const withTime = (blockTime: unknown) => {
    const t = tx(commitMemo) as { blockTime?: unknown };
    t.blockTime = blockTime;
    return t;
  };

  it('a block time that is not a date is a missing time, not an exception', async () => {
    for (const bad of [Number.NaN, 1e30, -1e30, Infinity, 0, -5, 1.5, '1763440998']) {
      const v = await run({ ...good, [COMMIT_SIG]: withTime(bad) });
      expect(v.ok, String(bad)).toBe(true);
      const order = v.checks.find((c) => c.id === 'order')!;
      expect(order.detail, String(bad)).toBe('Sealed in slot 100; revealed in slot 105. Solana gave no clock time for one of them.');
      expect(v.checks.some((c) => c.id === 'closed'), 'nothing is claimed about the close').toBe(false);
    }
  });

  it('a slot that is not a whole number is a missing slot, so the order is not shown', async () => {
    for (const bad of ['5', 1.5, Number.NaN, -3]) {
      const t = tx(commitMemo) as { slot?: unknown };
      t.slot = bad;
      const v = await run({ ...good, [COMMIT_SIG]: t });
      expect(v.ok, String(bad)).toBe(false);
      expect(v.checks.at(-1)).toMatchObject({ id: 'order', ok: false });
    }
  });

  it('utcTime never throws', () => {
    expect(utcTime(Number.NaN)).toBe('an unknown time');
    expect(utcTime(1e30)).toBe('an unknown time');
  });
});
