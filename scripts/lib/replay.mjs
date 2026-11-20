/**
 * Record a real session, and replay it later with nothing behind it.
 *
 * RECORDING: while the hosted server (scripts/serve.mjs) runs normally with GIVEN_RECORD=<file>, every answer the web app
 * receives from the executor and the chain service is appended to that file: what was asked, and exactly what came back.
 *
 * REPLAY: with GIVEN_MODE=replay and GIVEN_REPLAY=<file> the same server starts no executor and no chain service and
 * needs no keys, no Gemini and no Solana. It answers the web app from the file. This is the fallback for a stage with no
 * network: the app shows a session that really happened on Gemini's sandbox, and says so. Every answer is real recorded
 * data; nothing is invented. /health carries `replay`, the app shows "Replay" in the nav, and no order is placed.
 *
 * How a recording is followed. The steps that changed something (placing a bet, recording its call, checking results,
 * revealing) were POSTs; they divide the recording into stretches. In replay they must be repeated in the same order,
 * with the same choices: asking for a different bet gets a plain refusal naming the recorded one. Between two steps, each
 * thing the page reads (the ladders, the bet list, the leaderboard) plays through what it showed in that stretch, a
 * sample at a time, and then holds at the last of it until the next step is taken. A long wait in the recording (an hour
 * until a market closed) is therefore a few polls in replay, and nothing appears before the step that caused it.
 *
 * Pure: no network, no clock, no files, so it is tested as plain functions.
 */

export const VERSION = 1;
/** Live update streams are not recorded or replayed: with none, the app falls back to refreshing by itself. */
export const STREAMS = new Set(['/api/stream', '/chain/events']);
/** Deliveries from QuickNode are not part of what a visitor did. */
const NOT_RECORDED = new Set([...STREAMS, '/chain/hooks/quicknode']);

export const recordable = (path) => !NOT_RECORDED.has(path.replace(/\/+$/, '') || '/');

/**
 * The pages the recorder reads by itself when a session starts and again after every step, whatever the person recording
 * happened to look at. It is what lets a presenter open My bets or the leaderboard at any point of a replay and see the
 * state as it was at that point. (The Proof page's check and a call's own proof page are read only when someone opens
 * them: do that once while recording.)
 */
export const SNAPSHOT = ['/api/health', '/api/markets', '/api/bets', '/api/flow', '/chain/health', '/chain/calls', '/chain/leaderboard'];

const canonical = (v) => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
};

const parse = (text) => {
  if (text === undefined || text === null || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return String(text);
  }
};

/**
 * What identifies a request: the method, the path, its query in a fixed order, and for a POST its body with keys in a
 * fixed order. The `user` a browser sends is left out: the hosted server pins the account whatever it says. So is the
 * `requestId`: the page makes a fresh random one for every attempt, so two identical clicks never carry the same one.
 */
export function keyOf(method, url, bodyText) {
  const [rawPath, rawQuery = ''] = String(url).split('?');
  const path = rawPath.replace(/\/+$/, '') || '/';
  const query = [...new URLSearchParams(rawQuery)].filter(([k]) => k !== 'user').sort(([a], [b]) => a.localeCompare(b));
  let key = `${method.toUpperCase()} ${path}${query.length ? `?${new URLSearchParams(query)}` : ''}`;
  if (method.toUpperCase() !== 'GET') {
    const body = parse(bodyText);
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const { user: _user, requestId: _requestId, ...rest } = body;
      if (Object.keys(rest).length > 0) key += ` ${JSON.stringify(canonical(rest))}`;
    } else if (body !== null) key += ` ${JSON.stringify(body)}`;
  }
  return key;
}

/** The first line of a recording. */
export const header = (startedAt, note = '') => JSON.stringify({ given: 'recording', version: VERSION, startedAt, note });

/** One recorded exchange, as a line of the file. */
export function entry(seq, at, method, url, requestBody, status, responseBody) {
  return JSON.stringify({ seq, at, method: method.toUpperCase(), url, key: keyOf(method, url, requestBody), request: parse(requestBody), status, body: parse(responseBody) });
}

export function parseRecording(text) {
  const lines = String(text).split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('The recording is empty.');
  let meta;
  try {
    meta = JSON.parse(lines[0]);
  } catch {
    throw new Error('The recording\'s first line is not readable.');
  }
  if (meta?.given !== 'recording') throw new Error('This file is not a Given recording.');
  if (meta.version !== VERSION) throw new Error(`This recording is version ${meta.version}; this server reads version ${VERSION}.`);
  const entries = [];
  for (const l of lines.slice(1)) {
    try {
      const e = JSON.parse(l);
      if (typeof e.key === 'string' && typeof e.status === 'number') entries.push(e);
    } catch {
      // A line cut short by a crash while recording: everything before it is still good.
    }
  }
  if (entries.length === 0) throw new Error('The recording has no answers in it.');
  return { meta, entries };
}

const money = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : 'some amount');
const strike = (symbol) => {
  const m = /-HI([0-9.]+)$/.exec(String(symbol ?? ''));
  return m ? `$${Number(m[1]).toLocaleString('en-US')}` : String(symbol ?? '?');
};

/** A recorded step in words, for the refusal that tells a presenter what the recording did next. */
export function describeStep(e) {
  const path = e.url.split('?')[0].replace(/\/+$/, '');
  if (path === '/api/bets') return `a ${money(e.request?.stake)} bet on ${e.request?.event ?? 'a ladder'}: given ${strike(e.request?.condition)} or above, reach ${strike(e.request?.target)}`;
  if (path === '/api/settle') return 'checking results (the "Check results" button on My bets)';
  if (path === '/api/cashout') return `cashing out bet ${e.request?.bet ?? '?'} (the "Sell for" button on My bets)`;
  if (path === '/chain/calls') return 'recording a bet\'s call on Solana (it follows a bet by itself)';
  if (/\/reveal$/.test(path)) return 'revealing a call (the "Reveal" button on My bets)';
  return `${e.method} ${path}`;
}

/** At most `n` of `items`, evenly spread, always ending on the last one. */
export function sample(items, n) {
  if (items.length <= n) return items;
  const out = [];
  for (let i = 0; i < n; i++) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

export class Replayer {
  /** @param {{meta: object, entries: object[]}} recording  @param {{steps?: number}} [opts] reads played per stretch before holding */
  constructor(recording, opts = {}) {
    this.meta = recording.meta;
    this.entries = recording.entries;
    this.steps = Math.max(2, opts.steps ?? 12);
    this.gates = this.entries.filter((e) => e.method !== 'GET');
    this.done = 0; // how many of the recorded steps have been repeated
    this.cursors = new Map(); // `${stretch} ${key}` -> how many reads of that key have been served in that stretch
    this.plays = new Map(); // `${stretch} ${key}` -> the sampled answers for it
  }

  /** The recorded answers to `key` between step `stretch - 1` and step `stretch`, sampled. */
  playFor(stretch, key) {
    const id = `${stretch} ${key}`;
    if (!this.plays.has(id)) {
      const from = stretch === 0 ? -Infinity : this.gates[stretch - 1].seq;
      const to = stretch < this.gates.length ? this.gates[stretch].seq : Infinity;
      // A page that was polled for an hour while nothing changed showed one thing, not four hundred: runs of the same
      // answer count once. So a result that "arrived by itself" in the recording arrives on the next look in a replay.
      const seen = this.entries.filter((e) => e.method === 'GET' && e.key === key && e.seq > from && e.seq < to);
      const changes = seen.filter((e, i) => i === 0 || JSON.stringify(e.body) !== JSON.stringify(seen[i - 1].body) || e.status !== seen[i - 1].status);
      this.plays.set(id, sample(changes, this.steps));
    }
    return this.plays.get(id);
  }

  read(key) {
    const play = this.playFor(this.done, key);
    if (play.length > 0) {
      const id = `${this.done} ${key}`;
      const at = Math.min(this.cursors.get(id) ?? 0, play.length - 1);
      this.cursors.set(id, at + 1);
      return play[at];
    }
    // Not read during this stretch of the recording: what it last showed still stands. If it was only ever read later,
    // there is nothing honest to show yet (a later answer would put a result on screen before the step that caused it).
    // The recorder snapshots the main pages at the start and after every step, so this is rare.
    const boundary = this.done === 0 ? -Infinity : this.gates[this.done - 1].seq;
    const earlier = this.entries.filter((e) => e.method === 'GET' && e.key === key && e.seq < boundary);
    return earlier.length > 0 ? earlier[earlier.length - 1] : null;
  }

  /** Answers one request from the recording: { status, body }. */
  answer(method, url, bodyText) {
    const m = method.toUpperCase();
    const key = keyOf(m, url, bodyText);
    const path = url.split('?')[0].replace(/\/+$/, '') || '/';
    const when = this.meta.startedAt;
    if (m === 'GET') {
      const hit = this.read(key);
      if (!hit) return { status: 404, body: { error: 'This was not looked at in the recorded session, so there is nothing to show for it.', code: 'not_in_recording' } };
      // Health is where the app learns what it is talking to: a recording, and of when.
      if (path === '/api/health' || path === '/chain/health') return { status: hit.status, body: { ...hit.body, replay: { recordedAt: when } } };
      return { status: hit.status, body: hit.body };
    }
    const next = this.gates[this.done];
    if (!next) return { status: 409, body: { error: 'This is a replay of a recorded session, and the recording ends here. Nothing was placed.', code: 'replay_ended' } };
    if (next.key !== key) {
      return {
        status: 409,
        body: { error: `This is a replay of a recorded session, so it can only repeat what was done then. Next in the recording: ${describeStep(next)}. Nothing was placed.`, code: 'replay_mismatch', expected: describeStep(next) },
      };
    }
    this.done++;
    return { status: next.status, body: next.body };
  }

  /** Where the replay stands, for /healthz and the log. */
  progress() {
    return { stepsDone: this.done, steps: this.gates.length, next: this.gates[this.done] ? describeStep(this.gates[this.done]) : null };
  }
}
