/**
 * Recording a session and replaying it with nothing behind it.
 *   - the pure part: how a recording is followed (scripts/lib/replay.mjs);
 *   - the real thing: scripts/serve.mjs records a whole bet (place, call, settle, reveal) against the local test exchange,
 *     then a second server with NO backends replays it.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Replayer, describeStep, entry, header, keyOf, parseRecording, recordable, sample } from '../lib/replay.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('what identifies a request', () => {
  it('the same question asked with its parts in another order is the same question', () => {
    assert.equal(keyOf('GET', '/api/quote?stake=10&event=E&condition=A&target=B'), keyOf('get', '/api/quote?event=E&target=B&condition=A&stake=10'));
    assert.equal(keyOf('POST', '/api/bets', '{"stake":10,"event":"E"}'), keyOf('POST', '/api/bets/', '{"event":"E","stake":10}'));
  });

  it('the account a browser names is not part of it, but the bet is', () => {
    assert.equal(keyOf('POST', '/api/bets', '{"user":"primary","event":"E","stake":10}'), keyOf('POST', '/api/bets', '{"user":"mallory","event":"E","stake":10}'));
    assert.equal(keyOf('GET', '/api/bets?user=primary'), keyOf('GET', '/api/bets'));
    // The page sends a fresh random requestId with every attempt: it must not make a replayed click look like a different request.
    assert.equal(keyOf('POST', '/api/bets', '{"event":"E","stake":10,"requestId":"aaaaaaaa-1111"}'), keyOf('POST', '/api/bets', '{"requestId":"bbbbbbbb-2222","stake":10,"event":"E"}'));
    assert.equal(keyOf('POST', '/api/bets', '{"event":"E","stake":10,"requestId":"aaaaaaaa-1111"}'), keyOf('POST', '/api/bets', '{"event":"E","stake":10}'));
    assert.notEqual(keyOf('POST', '/api/bets', '{"event":"E","stake":10}'), keyOf('POST', '/api/bets', '{"event":"E","stake":25}'));
    assert.notEqual(keyOf('GET', '/api/bets'), keyOf('POST', '/api/bets'));
  });

  it('streams and QuickNode deliveries are not recorded', () => {
    assert.equal(recordable('/api/stream'), false);
    assert.equal(recordable('/chain/events'), false);
    assert.equal(recordable('/chain/hooks/quicknode'), false);
    assert.equal(recordable('/api/markets'), true);
    assert.equal(recordable('/chain/calls/abc/reveal'), true);
  });
});

/** A tiny recording: prices move, a bet is placed and its call recorded, the result arrives, it is checked. */
function tape() {
  let seq = 0;
  const lines = [header('2026-11-19T01:00:00.000Z', 'test')];
  const add = (method, url, req, status, body) => lines.push(entry(++seq, `2026-11-19T01:00:${String(seq).padStart(2, '0')}.000Z`, method, url, req === null ? '' : JSON.stringify(req), status, JSON.stringify(body)));
  add('GET', '/api/health', null, 200, { ok: true, venue: 'Gemini sandbox', sandbox: true });
  for (let i = 1; i <= 30; i++) add('GET', '/api/markets', null, 200, { tick: i });
  add('GET', '/api/bets', null, 200, { bets: [] });
  add('POST', '/api/bets', { user: 'primary', event: 'BTC2611190200', condition: 'GEMI-BTC2611190200-HI62500', target: 'GEMI-BTC2611190200-HI63500', stake: 10 }, 201, { bet: { id: 'b1', status: 'open' } });
  add('POST', '/chain/calls', { betId: 'b1' }, 201, { id: 'c1', state: 'committed' });
  add('GET', '/api/bets', null, 200, { bets: [{ id: 'b1', status: 'open' }] });
  for (let i = 31; i <= 40; i++) add('GET', '/api/markets', null, 200, { tick: i });
  add('GET', '/api/bets', null, 200, { bets: [{ id: 'b1', status: 'settled' }] });
  add('POST', '/api/settle', null, 200, { settled: [{ id: 'b1' }], needsReview: [], stillOpen: 0 });
  add('GET', '/chain/leaderboard', null, 200, { rows: [] });
  add('POST', '/chain/calls/c1/reveal', null, 200, { id: 'c1', state: 'revealed' });
  add('GET', '/chain/leaderboard', null, 200, { rows: [{ handle: 'quiet-otter-42' }] });
  return parseRecording(lines.join('\n'));
}
const BET = JSON.stringify({ user: 'primary', event: 'BTC2611190200', condition: 'GEMI-BTC2611190200-HI62500', target: 'GEMI-BTC2611190200-HI63500', stake: 10 });

describe('following a recording', () => {
  it('reads play through what was seen, a sample at a time, and then hold', () => {
    const r = new Replayer(tape(), { steps: 5 });
    const seen = Array.from({ length: 8 }, () => r.answer('GET', '/api/markets').body.tick);
    assert.deepEqual(seen.slice(0, 5), [1, 8, 16, 23, 30], 'thirty recorded readings become five');
    assert.deepEqual(seen.slice(5), [30, 30, 30], 'then it holds at the last one before the next step');
  });

  it('an hour of polling while nothing changed is one look, so a result that arrived by itself arrives on the next look', () => {
    let seq = 0;
    const lines = [header('2026-11-19T01:00:00.000Z')];
    const add = (method, url, status, body) => lines.push(entry(++seq, 't', method, url, '', status, JSON.stringify(body)));
    add('POST', '/api/bets', 201, { bet: { id: 'b1' } });
    for (let i = 0; i < 400; i++) add('GET', '/api/bets', 200, { bets: [{ id: 'b1', status: 'open' }] });
    for (let i = 0; i < 50; i++) add('GET', '/api/bets', 200, { bets: [{ id: 'b1', status: 'settled' }] });
    const r = new Replayer(parseRecording(lines.join('\n')));
    r.answer('POST', '/api/bets', '');
    assert.equal(r.answer('GET', '/api/bets').body.bets[0].status, 'open');
    assert.equal(r.answer('GET', '/api/bets').body.bets[0].status, 'settled');
    assert.equal(r.answer('GET', '/api/bets').body.bets[0].status, 'settled');
  });

  it('nothing appears before the step that caused it', () => {
    const r = new Replayer(tape());
    for (let i = 0; i < 50; i++) assert.deepEqual(r.answer('GET', '/api/bets').body, { bets: [] }, 'however long the presenter waits, there is no bet yet');
    assert.equal(r.answer('POST', '/api/bets', BET).status, 201);
    assert.deepEqual(r.answer('GET', '/api/bets').body, { bets: [] }, 'the bet list was not read between the bet and its call in the recording, so it has not changed yet');
    assert.equal(r.answer('POST', '/chain/calls', '{"betId":"b1"}').body.state, 'committed');
    assert.equal(r.answer('GET', '/api/bets').body.bets[0].status, 'open');
    assert.equal(r.answer('GET', '/api/bets').body.bets[0].status, 'settled', 'the hour until the market closed is one more look');
    assert.equal(r.answer('GET', '/api/markets').body.tick, 31, 'and prices carry on from after the bet');
  });

  it('the steps must be repeated in order, with the same choices, and a different one is refused in words a presenter can act on', () => {
    const r = new Replayer(tape());
    const other = r.answer('POST', '/api/bets', JSON.stringify({ event: 'BTC2611190200', condition: 'GEMI-BTC2611190200-HI62500', target: 'GEMI-BTC2611190200-HI63500', stake: 25 }));
    assert.equal(other.status, 409);
    assert.equal(other.body.code, 'replay_mismatch');
    assert.match(other.body.error, /a \$10\.00 bet on BTC2611190200: given \$62,500 or above, reach \$63,500/);
    assert.match(other.body.error, /Nothing was placed/);
    const early = r.answer('POST', '/api/settle');
    assert.equal(early.body.code, 'replay_mismatch', 'checking results before the bet is out of order');
    assert.deepEqual(r.progress(), { stepsDone: 0, steps: 4, next: describeStep(tape().entries.find((e) => e.method === 'POST')) });

    assert.equal(r.answer('POST', '/api/bets', BET).status, 201, 'the recorded bet still goes through after the refusals');
    assert.equal(r.answer('POST', '/chain/calls', '{"betId":"b1"}').status, 201);
    assert.equal(r.answer('POST', '/api/settle').body.settled.length, 1);
    assert.equal(r.answer('POST', '/chain/calls/c1/reveal').body.state, 'revealed');
    assert.equal(r.answer('GET', '/chain/leaderboard').body.rows.length, 1);
    const past = r.answer('POST', '/api/settle');
    assert.equal(past.status, 409);
    assert.equal(past.body.code, 'replay_ended');
  });

  it('health says it is a recording and of when; everything else is exactly what was recorded', () => {
    const r = new Replayer(tape());
    assert.deepEqual(r.answer('GET', '/api/health').body, { ok: true, venue: 'Gemini sandbox', sandbox: true, replay: { recordedAt: '2026-11-19T01:00:00.000Z' } });
  });

  it('something looked at earlier keeps its last answer; something never looked at has none', () => {
    const r = new Replayer(tape());
    r.answer('POST', '/api/bets', BET);
    r.answer('POST', '/chain/calls', '{"betId":"b1"}');
    r.answer('POST', '/api/settle');
    assert.equal(r.answer('GET', '/api/bets').body.bets[0].status, 'settled', 'not read after the check in the recording: what it last showed stands');
    assert.equal(r.answer('GET', '/api/health').body.venue, 'Gemini sandbox');
    const never = r.answer('GET', '/api/flow');
    assert.equal(never.status, 404);
    assert.equal(never.body.code, 'not_in_recording');
  });

  it('a page only looked at later in the recording is not shown early: that would put a result on screen before its cause', () => {
    const r = new Replayer(tape());
    assert.equal(r.answer('GET', '/chain/leaderboard').body.code, 'not_in_recording');
    r.answer('POST', '/api/bets', BET);
    r.answer('POST', '/chain/calls', '{"betId":"b1"}');
    r.answer('POST', '/api/settle');
    assert.deepEqual(r.answer('GET', '/chain/leaderboard').body, { rows: [] }, 'at the point it was looked at, it is there');
  });
});

describe('the file', () => {
  it('survives a last line cut short by a crash, and refuses what is not a recording', () => {
    const good = [header('2026-11-19T01:00:00.000Z'), entry(1, 't', 'GET', '/api/health', '', 200, '{"ok":true}')].join('\n');
    assert.equal(parseRecording(`${good}\n{"seq":2,"key":"GET /api/mar`).entries.length, 1);
    assert.throws(() => parseRecording(''), /empty/);
    assert.throws(() => parseRecording('{"hello":1}\n{}'), /not a Given recording/);
    assert.throws(() => parseRecording(header('t')), /no answers/);
    assert.throws(() => parseRecording(`${JSON.stringify({ given: 'recording', version: 99 })}\n{}`), /version 99/);
  });

  it('sampling keeps the first and the last', () => {
    assert.deepEqual(sample([1, 2, 3], 5), [1, 2, 3]);
    assert.deepEqual(sample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3), [1, 6, 10]);
  });
});

// ------------------------------------------------------------------ the real server, recording then replaying

const freePort = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

const running = [];
async function serve(extraEnv) {
  const dist = mkdtempSync(join(tmpdir(), 'given-replay-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><title>Given</title><body><div id="root"></div></body></html>');
  const [port, ex, ch] = [await freePort(), await freePort(), await freePort()];
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', GIVEN_INTERNAL_EXECUTOR_PORT: String(ex), GIVEN_INTERNAL_CHAIN_PORT: String(ch), GIVEN_WEB_DIST: dist, GIVEN_DATA_ROOT: mkdtempSync(join(tmpdir(), 'given-replay-data-')), ...extraEnv };
  for (const k of ['GEMINI_API_KEY', 'GEMINI_API_SECRET', 'GIVEN_PROGRAM_ID', 'GIVEN_EDGE_TRUST_PROXY', 'GIVEN_SEEDER']) delete env[k];
  const proc = spawn('node', ['scripts/serve.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.push(proc);
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const end = Date.now() + 40_000;
  while (!/Given is up/.test(log)) {
    if (proc.exitCode !== null) throw new Error(`serve exited early:\n${log}`);
    if (Date.now() > end) throw new Error(`serve did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
  };
  const stop = async () => {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 4000))]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  };
  return { base, call, stop, internal: `http://127.0.0.1:${ex}`, ports: { ex, ch }, log: () => log };
}
after(() => {
  for (const p of running) if (p.exitCode === null) p.kill('SIGKILL');
});

describe('a whole bet, recorded through the hosted server and replayed with nothing behind it', () => {
  it('replays the session it recorded, says it is a replay, and refuses anything the recording did not do', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'given-tape-')), 'session.jsonl');

    // ---- record: the real executor and chain service (local test exchange), through the real proxy
    const live = await serve({ GIVEN_MODE: 'fake', GIVEN_RECORD: file });
    const health = (await live.call('GET', '/api/health')).json;
    assert.equal(health.replay, undefined);
    const markets = (await live.call('GET', '/api/markets')).json;
    const event = markets.events.find((e) => e.pairs.some((p) => p.quote.offerable));
    const pair = event.pairs.find((p) => p.quote.offerable);
    const want = { user: 'primary', event: event.ticker, condition: pair.condition.symbol, target: pair.target.symbol, stake: 10 };
    await live.call('GET', `/api/quote?event=${want.event}&condition=${want.condition}&target=${want.target}&stake=10`);
    const placed = await live.call('POST', '/api/bets', want);
    assert.equal(placed.status, 201);
    const committed = await live.call('POST', '/chain/calls', { betId: placed.json.bet.id });
    assert.equal(committed.status, 201);
    await live.call('GET', '/api/bets');
    await live.call('GET', '/chain/calls');
    // the market closes with both halves happening (an operator action on the test exchange, not part of the session)
    await fetch(`${live.internal}/dev/resolve?spot=99999999`, { method: 'POST' });
    const settled = await live.call('POST', '/api/settle');
    assert.equal(settled.json.settled.length, 1);
    await live.call('GET', '/api/bets');
    const revealed = await live.call('POST', `/chain/calls/${committed.json.id}/reveal`);
    assert.equal(revealed.json.state, 'revealed');
    const board = (await live.call('GET', '/chain/leaderboard')).json;
    assert.equal(board.rows.length, 1);
    await live.call('GET', '/api/flow');
    await live.stop();

    const tapeText = readFileSync(file, 'utf8');
    const recorded = parseRecording(tapeText);
    assert.equal(recorded.entries.filter((e) => e.method === 'POST').length, 4, 'bet, call, settle, reveal');
    assert.ok(!/secret|apiKey|api_key|"salt"/i.test(tapeText), 'a recording holds what the page was shown, never a key or a salt');

    // ---- replay: no executor, no chain service, no keys
    const replay = await serve({ GIVEN_MODE: 'replay', GIVEN_REPLAY: file });
    for (const port of [replay.ports.ex, replay.ports.ch]) {
      await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }), 'no backend is running behind a replay');
    }
    const hz = (await replay.call('GET', '/healthz')).json;
    assert.equal(hz.ok, true);
    assert.equal(hz.mode, 'replay');

    const h2 = (await replay.call('GET', '/api/health')).json;
    assert.equal(h2.venue, health.venue);
    assert.ok(h2.replay && typeof h2.replay.recordedAt === 'string', 'the app is told it is a recording');
    assert.equal((await replay.call('GET', '/api/health')).headers.get('x-given-replay'), '1');
    assert.deepEqual((await replay.call('GET', '/api/markets')).json.events.map((e) => e.ticker), markets.events.map((e) => e.ticker));
    assert.deepEqual((await replay.call('GET', '/api/bets')).json.bets, [], 'no bet yet');

    // a different bet, and a step out of order, are refused in words
    const wrong = await replay.call('POST', '/api/bets', { ...want, stake: 25 });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.json.code, 'replay_mismatch');
    assert.match(wrong.json.error, /Next in the recording: a \$10\.00 bet on/);
    assert.equal((await replay.call('POST', '/api/settle')).json.code, 'replay_mismatch');

    // the recorded session, step for step, gives the recorded answers
    const p2 = await replay.call('POST', '/api/bets', want);
    assert.equal(p2.status, 201);
    assert.equal(p2.json.bet.id, placed.json.bet.id);
    assert.deepEqual(p2.json.bet.legs.map((l) => l.orderId), placed.json.bet.legs.map((l) => l.orderId), 'the same two order ids as on the day');
    assert.equal((await replay.call('POST', '/chain/calls', { betId: placed.json.bet.id })).json.commitSignature, committed.json.commitSignature);
    assert.equal((await replay.call('GET', '/api/bets')).json.bets[0].status, 'open');
    assert.equal((await replay.call('POST', '/api/settle')).json.settled[0].id, placed.json.bet.id);
    assert.equal((await replay.call('GET', '/api/bets')).json.bets[0].status, 'settled');
    assert.equal((await replay.call('POST', `/chain/calls/${committed.json.id}/reveal`)).json.reveal.signature, revealed.json.reveal.signature);
    assert.deepEqual((await replay.call('GET', '/chain/leaderboard')).json.rows, board.rows);
    assert.equal((await replay.call('POST', '/api/settle')).json.code, 'replay_ended');

    // live streams are not part of a recording; the app refreshes by itself without them
    assert.equal((await replay.call('GET', '/api/stream?topics=markets')).status, 404);
    // and the routes the hosted server never forwards are still not there
    assert.equal((await replay.call('POST', '/api/review', {})).json.code, 'not_found');
    await replay.stop();
  });

  it('replay mode will not start without a recording it can read', async () => {
    const run = (extra) =>
      new Promise((done) => {
        const dist = mkdtempSync(join(tmpdir(), 'given-replay-dist-'));
        writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Given</title>');
        const p = spawn('node', ['scripts/serve.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '0', HOST: '127.0.0.1', GIVEN_WEB_DIST: dist, GIVEN_MODE: 'replay', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (out += d));
        const timer = setTimeout(() => p.kill('SIGKILL'), 15_000);
        p.on('exit', (code) => {
          clearTimeout(timer);
          done({ code, out });
        });
      });
    const none = await run({ GIVEN_REPLAY: '' });
    assert.notEqual(none.code, 0);
    assert.match(none.out, /GIVEN_REPLAY/);
    const junk = join(mkdtempSync(join(tmpdir(), 'given-tape-')), 'junk.jsonl');
    writeFileSync(junk, '{"hello":1}\n');
    const bad = await run({ GIVEN_REPLAY: junk });
    assert.notEqual(bad.code, 0);
    assert.match(bad.out, /not a Given recording/);
  });
});
