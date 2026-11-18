// The call service's rules, with the chain and the executor replaced by fakes.
// scripts/e2e-local.ts runs the same flow against the real program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Bet } from '../src/bets.ts';
import { ApiError, CallService, CallStore, handleFor, type CallView } from '../src/calls.ts';
import { ChainError, type ChainApi } from '../src/chain.ts';
import { commitHash, type CallAccount, type CallDetails } from '../src/codec.ts';
import { buildLeaderboard } from '../src/receipts.ts';
import { createFeedServer } from '../src/server.ts';
import { ReceiptStore, type Receipt } from '../src/store.ts';

const EXPIRY = Date.parse('2026-11-18T00:00:00Z');

class FakeChain implements ChainApi {
  readonly records = new Map<string, { state: 'committed' | 'revealed'; targetHit: boolean }>();
  readonly sent: string[] = [];
  clock = EXPIRY - 3_600_000;
  /** Makes the next commit land on chain and then fail to report back. */
  dropNextReply = false;

  async commit(commit: string): Promise<string> {
    this.records.set(commit, { state: 'committed', targetHit: false });
    this.sent.push('commit');
    if (this.dropNextReply) {
      this.dropNextReply = false;
      throw new Error('connection reset');
    }
    return `commit-sig-${this.sent.length}`;
  }

  async reveal(details: CallDetails, salt: string, targetHit: boolean): Promise<string> {
    const record = this.records.get(commitHash(details, salt));
    if (!record) throw new ChainError('The revealed call does not match the committed hash', 'HashMismatch');
    if (this.clock < Number(details.expiry) * 1000) throw new ChainError('The event has not closed yet', 'NotExpiredYet');
    Object.assign(record, { state: 'revealed', targetHit });
    this.sent.push('reveal');
    return `reveal-sig-${this.sent.length}`;
  }

  async call(commit: string): Promise<CallAccount | null> {
    const record = this.records.get(commit);
    return record ? ({ commit, ...record } as CallAccount) : null;
  }

  async lastSignature(): Promise<string | null> {
    return 'found-on-chain';
  }
}

const bet = (id: string, user: string, status: string, extra: Partial<Bet> = {}): Bet => ({
  id,
  user,
  createdAt: '2026-11-17T22:00:00.000Z',
  eventTicker: 'ETH2611180000',
  eventTitle: 'ETH price on Nov 18',
  expiry: '2026-11-18T00:00:00.000Z',
  condition: { symbol: 'GEMI-ETH2611180000-HI1800', label: '$1,800 or above' },
  target: { symbol: 'GEMI-ETH2611180000-HI1820', label: '$1,820 or above' },
  status,
  legs: [
    { clientOrderId: `gv-${id}-b`, orderId: `o-${id}-b`, symbol: 'GEMI-ETH2611180000-HI1820', side: 'buy', outcome: 'yes', quantityFilled: 8, avgPrice: 0.5 },
    { clientOrderId: `gv-${id}-a`, orderId: `o-${id}-a`, symbol: 'GEMI-ETH2611180000-HI1800', side: 'buy', outcome: 'no', quantityFilled: 5, avgPrice: 0.2 },
  ],
  payoffs: { conditionalPrice: 0.65 },
  offer: { fairPrice: 0.625 },
  ...extra,
});
const settled = (c: 'yes' | 'no', t: 'yes' | 'no'): Partial<Bet> => ({ settlement: { conditionResolved: c, targetResolved: t } });

function setup(bets: Bet[], withChain = true) {
  const chain = new FakeChain();
  const ledger = { bets };
  const service = new CallService({
    store: new CallStore(undefined, 'test-handle-salt'),
    chain: withChain ? chain : null,
    bets: { list: async () => ledger.bets },
    now: () => new Date(chain.clock),
  });
  return { chain, ledger, service };
}

const rejects = (p: Promise<unknown>, status: number, code: string) =>
  assert.rejects(p, (err: unknown) => err instanceof ApiError && err.status === status && err.code === code);

test('commit puts a hash on chain and keeps everything else private', async () => {
  const { chain, service } = setup([bet('aaaa0001', 'alice', 'open')]);
  const call = await service.commit('aaaa0001');

  assert.deepEqual(Object.keys(call).sort(), ['betId', 'commitHash', 'commitSignature', 'committedAt', 'handle', 'id', 'state']);
  assert.equal(call.state, 'committed');
  assert.equal(call.handle, handleFor('alice', 'test-handle-salt'));
  assert.match(call.commitHash, /^[0-9a-f]{64}$/);
  assert.deepEqual([...chain.records.keys()], [call.commitHash]);

  // Asking again is not a second commitment.
  assert.deepEqual(await service.commit('aaaa0001'), call);
  assert.deepEqual(chain.sent, ['commit']);
  assert.deepEqual(service.get(call.id), call);
});

test('commit refuses bets that cannot be scored', async () => {
  const { chain, service } = setup([
    bet('fail0001', 'alice', 'failed'),
    bet('rvw00001', 'alice', 'needs_review'),
    bet('nopr0001', 'alice', 'open', { offer: { fairPrice: null }, payoffs: { conditionalPrice: null } }),
    bet('noex0001', 'alice', 'open', { expiry: null }),
    bet('late0001', 'alice', 'open'),
  ]);
  await rejects(service.commit('nosuch01'), 404, 'not_found');
  await rejects(service.commit('fail0001'), 409, 'not_filled');
  await rejects(service.commit('rvw00001'), 409, 'not_filled');
  await rejects(service.commit('nopr0001'), 409, 'no_fair_price');
  await rejects(service.commit('noex0001'), 409, 'no_expiry');
  // Once the event has closed the result may be known, so a commitment would prove nothing.
  chain.clock = EXPIRY + 1000;
  await rejects(service.commit('late0001'), 409, 'too_late');
  assert.deepEqual(chain.sent, []);

  const offline = setup([bet('aaaa0001', 'alice', 'open')], false);
  await rejects(offline.service.commit('aaaa0001'), 503, 'chain_unavailable');
});

test('a commit that landed but was not confirmed is adopted, not repeated', async () => {
  const { chain, service } = setup([bet('aaaa0001', 'alice', 'open')]);
  chain.dropNextReply = true;
  await rejects(service.commit('aaaa0001'), 502, 'chain_error');
  assert.equal(await service.list().then((c) => c.length), 0);

  const call = await service.commit('aaaa0001');
  assert.equal(call.commitSignature, 'found-on-chain');
  assert.deepEqual(chain.sent, ['commit']);
  assert.deepEqual([...chain.records.keys()], [call.commitHash]);
});

test('reveal: only a settled call whose condition held, scored against the fair price', async () => {
  const { chain, ledger, service } = setup([
    bet('hit00001', 'alice', 'open'),
    bet('miss0001', 'alice', 'open', { offer: { fairPrice: null } }), // falls back to the price paid
    bet('void0001', 'alice', 'open'),
    bet('rvw00001', 'alice', 'open'),
  ]);
  const [hit, miss, refunded, review] = await Promise.all(['hit00001', 'miss0001', 'void0001', 'rvw00001'].map((id) => service.commit(id)));
  assert.ok(hit && miss && refunded && review);

  await rejects(service.reveal('nosuchcall'), 404, 'not_found');
  await rejects(service.reveal(hit.id), 409, 'not_settled');

  chain.clock = EXPIRY + 120_000;
  ledger.bets = [
    bet('hit00001', 'alice', 'settled', settled('yes', 'yes')),
    bet('miss0001', 'alice', 'settled', { ...settled('yes', 'no'), offer: { fairPrice: null } }),
    bet('void0001', 'alice', 'settled', settled('no', 'no')),
    bet('rvw00001', 'alice', 'needs_review'),
  ];
  await rejects(service.reveal(refunded.id), 409, 'void_call');
  await rejects(service.reveal(review.id), 409, 'not_scorable');

  const won = await service.reveal(hit.id);
  assert.equal(won.state, 'revealed');
  assert.deepEqual(won.reveal, {
    signature: won.reveal!.signature,
    revealedAt: '2026-11-18T00:02:00.000Z',
    eventTitle: 'ETH price on Nov 18',
    conditionLabel: '$1,800 or above',
    targetLabel: '$1,820 or above',
    fairPriceAtEntry: 0.625,
    outcome: 1,
    edge: 0.375,
  });
  const lost = await service.reveal(miss.id);
  assert.deepEqual([lost.reveal!.fairPriceAtEntry, lost.reveal!.outcome, lost.reveal!.edge], [0.65, 0, -0.65]);

  // Revealing twice changes nothing and sends nothing.
  assert.deepEqual(await service.reveal(hit.id), won);
  assert.deepEqual(chain.sent.filter((s) => s === 'reveal').length, 2);

  const states = Object.fromEntries((await service.list('alice')).map((c) => [c.betId, c.state]));
  assert.deepEqual(states, { hit00001: 'revealed', miss0001: 'revealed', void0001: 'void', rvw00001: 'committed' });
  assert.deepEqual(await service.list('bob'), []);
});

test('a reveal the chain says is too early reads as not settled', async () => {
  const { ledger, service } = setup([bet('aaaa0001', 'alice', 'open')]);
  const call = await service.commit('aaaa0001');
  // The executor says settled, but the chain's clock has not reached the close yet.
  ledger.bets = [bet('aaaa0001', 'alice', 'settled', settled('yes', 'yes'))];
  await rejects(service.reveal(call.id), 409, 'not_settled');
});

test('handles are stable, pseudonymous and fit the on-chain field', () => {
  const handle = handleFor('alice', 'salt-one');
  assert.equal(handleFor('alice', 'salt-one'), handle);
  assert.notEqual(handleFor('alice', 'salt-two'), handle);
  assert.match(handle, /^[a-z]+-[a-z]+-\d\d$/);
  assert.ok(!handle.includes('alice'));
  for (let i = 0; i < 500; i++) assert.ok(Buffer.byteLength(handleFor(`user-${i}`, 'salt')) <= 24);
});

test('sync commits filled bets by itself and reveals only for users who opted in', async () => {
  const { chain, ledger, service } = setup([
    bet('aaaa0001', 'alice', 'open'),
    bet('bbbb0001', 'bob', 'unhedged'),
    bet('cccc0001', 'alice', 'placing'),
  ]);
  assert.deepEqual(await service.sync({ autoCommit: true }), { committed: 2, revealed: 0 });
  assert.deepEqual(await service.sync({ autoCommit: true }), { committed: 0, revealed: 0 });

  chain.clock = EXPIRY + 60_000;
  ledger.bets = [bet('aaaa0001', 'alice', 'settled', settled('yes', 'yes')), bet('bbbb0001', 'bob', 'settled', settled('yes', 'no'))];
  assert.deepEqual(await service.sync({ autoCommit: true, autoRevealUsers: new Set(['bob']) }), { committed: 0, revealed: 1 });
  const states = Object.fromEntries((await service.list()).map((c) => [c.betId, c.state]));
  assert.deepEqual(states, { aaaa0001: 'committed', bbbb0001: 'revealed' });
});

test('http: the routes and error bodies the web app is written against', async (t) => {
  const { chain, ledger, service } = setup([bet('aaaa0001', 'primary', 'open')]);
  const server = createFeedServer({
    programId: 'Rcpt111111111111111111111111111111111111111',
    securityToken: 'token',
    store: new ReceiptStore(),
    decode: () => null,
    score: (receipts) => buildLeaderboard(receipts),
    calls: service,
    defaultUser: 'primary',
    corsOrigins: ['https://given.example'],
  }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = async (method: string, path: string, body?: unknown, origin?: string) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null, headers: res.headers };
  };

  assert.deepEqual((await send('POST', '/calls', {})).body, { error: 'Say which bet: "betId" is required.', code: 'missing_bet' });
  assert.deepEqual([(await send('POST', '/calls', { betId: 'nosuch01' })).status], [404]);

  // A page on some other site cannot record or publish a user's call.
  const foreign = await send('POST', '/calls', { betId: 'aaaa0001' }, 'https://evil.example');
  assert.deepEqual([foreign.status, foreign.body?.code], [403, 'forbidden_origin']);
  assert.deepEqual(chain.sent, []);

  const preflight = await fetch(`${base}/calls`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } });
  assert.deepEqual([preflight.status, preflight.headers.get('access-control-allow-origin')], [204, 'http://localhost:5173']);

  const committed = await send('POST', '/calls', { betId: 'aaaa0001' }, 'https://given.example');
  assert.equal(committed.status, 200);
  assert.equal(committed.headers.get('access-control-allow-origin'), 'https://given.example');
  const call = committed.body as unknown as CallView;
  assert.equal(call.state, 'committed');

  assert.deepEqual((await send('GET', '/calls')).body, { calls: [call] });
  assert.deepEqual((await send('GET', '/calls?user=someone-else')).body, { calls: [] });
  assert.deepEqual((await send('GET', `/calls/${call.id}`)).body, call);
  assert.equal((await send('GET', '/calls/nosuchcall')).status, 404);

  const early = await send('POST', `/calls/${call.id}/reveal`);
  assert.deepEqual([early.status, early.body], [409, { error: 'This bet has not settled yet, so there is nothing to reveal.', code: 'not_settled' }]);

  chain.clock = EXPIRY + 60_000;
  ledger.bets = [bet('aaaa0001', 'primary', 'settled', settled('yes', 'yes'))];
  const revealed = await send('POST', `/calls/${call.id}/reveal`);
  assert.deepEqual([revealed.status, revealed.body?.state], [200, 'revealed']);

  // The listener the internet can reach: reads and the webhook, never a user's calls.
  const open = createFeedServer({
    programId: 'Rcpt111111111111111111111111111111111111111', securityToken: 'token', store: new ReceiptStore(),
    decode: () => null, score: (receipts) => buildLeaderboard(receipts), calls: service, publicOnly: true,
  }).listen(0);
  t.after(() => open.close());
  const outside = (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${(open.address() as AddressInfo).port}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => r.status);
  assert.deepEqual(
    [await outside('POST', '/calls', { betId: 'aaaa0001' }), await outside('POST', `/calls/${call.id}/reveal`), await outside('GET', '/calls')],
    [404, 404, 404],
  );
  assert.deepEqual([await outside('GET', `/calls/${call.id}`), await outside('GET', '/leaderboard'), await outside('POST', '/hooks/quicknode', {})], [200, 200, 401]);

  const health = await send('GET', '/health');
  assert.deepEqual(health.body, { ok: true, receipts: 0, calls: true });
});

test('leaderboard: ranked by edge, quiet handles left off, no size or profit anywhere', () => {
  let n = 0;
  const reveal = (handle: string, targetHit: boolean, fairPrice: number, source: Receipt['source'] = 'quicknode-stream'): Receipt => {
    n++;
    return {
      id: `sig${n}:0`, signature: `sig${n}`, slot: n, blockTime: null, data: '', source,
      decoded: { type: 'CallRevealed', commit: `c${n}`, handle, targetHit, fairPrice, edge: (targetHit ? 1 : 0) - fairPrice, revealedAt: 1_794_960_000 + n },
    };
  };
  const commitOnly: Receipt = { id: 'x:0', signature: 'x', slot: 0, blockTime: null, data: '', source: 'quicknode-stream', decoded: { type: 'CallCommitted', commit: 'hidden' } };
  const receipts = [
    commitOnly,
    reveal('steady-otter-11', true, 0.6), reveal('steady-otter-11', true, 0.7), reveal('steady-otter-11', false, 0.2),
    reveal('lucky-lynx-42', true, 0.1), reveal('lucky-lynx-42', false, 0.5), reveal('lucky-lynx-42', false, 0.5),
    reveal('quiet-newt-77', true, 0.05),
  ];
  const board = buildLeaderboard(receipts, { now: () => new Date('2026-11-18T01:00:00Z') });

  assert.deepEqual(board.rows.map((r) => [r.rank, r.handle, r.calls, r.edge, r.hitRate]), [
    [1, 'steady-otter-11', 3, 0.5, 2 / 3],
    [2, 'lucky-lynx-42', 3, -0.1, 1 / 3],
  ]);
  assert.deepEqual([board.minCalls, board.source], [3, 'quicknode-stream']);
  assert.deepEqual(board.totals, { committed: 8, revealed: 7, handles: 3 });
  assert.deepEqual(Object.keys(board.rows[0]!).sort(), ['calls', 'edge', 'handle', 'hitRate', 'lastRevealedAt', 'rank']);

  // The same reveal delivered twice counts once; one read back from RPC is declared.
  const again = { ...receipts[1]!, id: 'redelivered:0' };
  assert.equal(buildLeaderboard([...receipts, again]).rows[0]!.calls, 3);
  assert.equal(buildLeaderboard([...receipts, reveal('steady-otter-11', true, 0.9, 'rpc')]).source, 'rpc');
});

test('receipt store: an event first read from RPC is re-marked when the Stream delivers it', () => {
  const store = new ReceiptStore();
  const r = (source: Receipt['source']): Receipt => ({ id: 'sig:0', signature: 'sig', slot: 1, blockTime: null, data: '', decoded: null, source });
  assert.equal(store.add(r('rpc')), true);
  assert.equal(store.hasSignature('sig'), true);
  assert.equal(store.add(r('quicknode-stream')), false);
  assert.deepEqual(store.all().map((x) => x.source), ['quicknode-stream']);
  assert.equal(store.add(r('rpc')), false);
  assert.deepEqual(store.all().map((x) => x.source), ['quicknode-stream']);
});
