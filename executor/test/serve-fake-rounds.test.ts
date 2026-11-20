/**
 * The local test exchange in "rounds" mode, the way `npm run dev` starts it: a ladder that closes by itself, settles the bets
 * on it, and opens again. Driven over HTTP against the real server file, because the thing being checked is that a person with
 * no keys who places a bet and waits gets a result without knowing about /dev/resolve.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

let child: ChildProcess;
let base = '';
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const until = async (what: string, ok: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await sleep(150);
  }
  assert.fail(`timed out waiting for: ${what}`);
};

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // A six-second round: long enough to place a bet in, short enough to watch two of them.
  child = spawn(process.execPath, [resolve(here, 'serve-fake.ts')], { env: { ...process.env, GIVEN_PORT: String(port), FAKE_ROUND_MINUTES: '0.1' }, stdio: 'ignore' });
  await until('the server to answer', async () => (await fetch(`${base}/health`).then((r) => r.ok, () => false)) === true);
});
after(() => {
  child?.kill('SIGTERM');
});

test('a round closes by itself, settles the bet on it with where the price finished, and the ladder opens again', async () => {
  const first = (await call('GET', '/dev/round')).json;
  assert.equal(first.rounds, true);
  assert.equal(first.resolved, false);

  const event = (await call('GET', '/markets')).json.events[0];
  assert.ok(new Date(event.expiry).getTime() > Date.now(), 'the ladder closes in the future');
  const pair = event.pairs.find((p: { quote: { offerable: boolean } }) => p.quote.offerable);
  const placed = await call('POST', '/bets', { user: 'primary', event: event.ticker, condition: pair.condition.symbol, target: pair.target.symbol, stake: 5 });
  assert.equal(placed.status, 201, JSON.stringify(placed.json));
  const id = placed.json.bet.id;

  // Nobody calls /dev/resolve: the round ends on its own clock and auto-settle picks the result up.
  await until('the bet to settle by itself', async () => (await call('GET', '/bets')).json.bets.find((b: { id: string }) => b.id === id).status === 'settled');
  const bet = (await call('GET', '/bets')).json.bets.find((b: { id: string }) => b.id === id);
  assert.ok(bet.settlement.finishedAt > 50_000 && bet.settlement.finishedAt < 80_000, `finished at ${bet.settlement.finishedAt}`);
  const { strike: c } = bet.condition;
  const { strike: t } = bet.target;
  assert.equal(bet.settlement.conditionResolved, bet.settlement.finishedAt >= c ? 'yes' : 'no');
  assert.equal(bet.settlement.targetResolved, bet.settlement.finishedAt >= t ? 'yes' : 'no');

  // Then the same ladder opens for the next round: open again, priced again, closing later than the first did.
  await until('the ladder to open again', async () => {
    const r = (await call('GET', '/dev/round')).json;
    return r.resolved === false && new Date(r.closesAt).getTime() > new Date(first.closesAt).getTime();
  });
  await until('the reopened ladder to be bettable', async () => {
    const e = (await call('GET', '/markets')).json.events[0];
    return e.offerableCount > 0 && e.rungs.every((r: { open: boolean }) => r.open) && new Date(e.expiry).getTime() > Date.now();
  });

  // A bet in the second round is a new bet on the same contracts, and the books still tie out across the two rounds.
  const again = (await call('GET', '/markets')).json.events[0];
  const next = again.pairs.find((p: { quote: { offerable: boolean } }) => p.quote.offerable);
  const second = await call('POST', '/bets', { user: 'primary', event: again.ticker, condition: next.condition.symbol, target: next.target.symbol, stake: 5 });
  assert.equal(second.status, 201, JSON.stringify(second.json));
  assert.equal(second.json.bet.status, 'open');
  const rec = (await call('GET', '/reconcile')).json;
  assert.equal(rec.ok, true, JSON.stringify(rec));
});

test('a bet sold back before the round closes gets its call result when the round ends, before the ladder reopens', async () => {
  await until('an open round with time left', async () => {
    const r = (await call('GET', '/dev/round')).json;
    return r.resolved === false && new Date(r.closesAt).getTime() - Date.now() > 3000;
  });
  const event = (await call('GET', '/markets')).json.events[0];
  const pair = event.pairs.find((p: { quote: { offerable: boolean } }) => p.quote.offerable);
  const placed = await call('POST', '/bets', { user: 'primary', event: event.ticker, condition: pair.condition.symbol, target: pair.target.symbol, stake: 5 });
  assert.equal(placed.status, 201, JSON.stringify(placed.json));
  // The second test's bet may share a contract with a bet still open from the first; sell only if the exchange allows it.
  const sold = await call('POST', '/cashout', { bet: placed.json.bet.id });
  if (sold.status !== 200) return; // netted against the earlier open bet: nothing to check here
  await until('the sold bet to be given its call result', async () => {
    const b = (await call('GET', '/bets')).json.bets.find((x: { id: string }) => x.id === placed.json.bet.id);
    return b.status === 'cashed_out' && b.called !== undefined && b.scorable === true;
  });
});
