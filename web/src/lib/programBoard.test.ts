import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import devnet from './fixtures/devnet-caller-stats.json';
import devnetCalls from './fixtures/devnet-call-records.json';
import { CALL_DISCRIMINATOR, base58, boardRows, callFilters, callsFromAnswer, compareBoards, comparisonLine, decodeCallRecord, decodeCallerStats, edgeTolerance, explorerAddress, readProblem, readProgramBoard, sealedByHandle, statsFilters, statsFromAnswer, STATS_DISCRIMINATOR } from './programBoard';
import type { CallerStats } from './programBoard';
import type { Rpc } from './verify';

// The fixture is what https://api.devnet.solana.com answered on 2026-11-19 to getProgramAccounts for the deployed
// program, once per authority key, with the two filters `statsFilters` builds. Nothing in it was written by hand.
//
// The expected figures below were NOT produced by the decoder under test. They came from the chain service's own
// decoder (chain/src/program.ts, `decodeStatsAccount`) run over the same bytes, and each account's address was
// re-derived from (program, authority, handle) and matched the address the node returned.
const PROGRAM = devnet.program;
const KEY_A = '2QfQ15Ha5VxvvwWqdsDdCyf6n8uxKfVDHh9GHZdFHeHz'; // gitleaks:allow (a public Solana address)
const KEY_B = '9GVno5tV2moikfXqZyZAuxw2pmqGZ4nmU9DKXhiDhM4X'; // gitleaks:allow (a public Solana address)
const KEY_C = '5fE6B5sFJQURtKiJJepzqvHshJZR9SkKSMgeKB3oaGsN'; // gitleaks:allow (a public Solana address)
const answers: Record<string, { pubkey: string; account: { data: string[]; owner: string } }[]> = devnet.answers;

const ON_DEVNET: CallerStats[] = [
  { authority: KEY_A, handle: 'north-tern-98', calls: 1, hits: 1, edgeSum: 590_000, lastRevealedAt: 1794979161 },
  { authority: KEY_B, handle: 'steady-finch-56', calls: 4, hits: 2, edgeSum: 780_163, lastRevealedAt: 1794987089 },
  { authority: KEY_B, handle: 'north-tern-98', calls: 1, hits: 1, edgeSum: 590_000, lastRevealedAt: 1794979832 },
  { authority: KEY_C, handle: 'brisk-heron-69', calls: 2, hits: 2, edgeSum: 1_180_000, lastRevealedAt: 1795038723 },
  { authority: KEY_C, handle: 'north-tern-98', calls: 1, hits: 1, edgeSum: 590_000, lastRevealedAt: 1794976999 },
];

/** Decoded with Node's Buffer, so the test does not lean on the `atob` path it is checking elsewhere. */
const bytesOf = (base64: string) => Uint8Array.from(Buffer.from(base64, 'base64'));
const realBytes = (authority: string, i = 0) => bytesOf(answers[authority]![i]!.account.data[0]!);

/**
 * A record laid out by hand from the Rust struct (receipts-program/programs/given_receipts/src/state.rs). Used only for
 * cases devnet does not hold yet, and every test that uses it says so.
 */
function handBuilt(o: { handle: Uint8Array; calls: number; hits: number; edgeSum: bigint; lastRevealedAt: bigint; size?: number }): Uint8Array {
  const out = new Uint8Array(o.size ?? 101);
  const view = new DataView(out.buffer);
  out.set(STATS_DISCRIMINATOR, 0);
  out.set(realBytes(KEY_A).subarray(8, 40), 8);
  view.setUint32(40, o.handle.length, true);
  out.set(o.handle, 44);
  const at = 44 + o.handle.length;
  view.setUint32(at, o.calls, true);
  view.setUint32(at + 4, o.hits, true);
  view.setBigInt64(at + 8, o.edgeSum, true);
  view.setBigInt64(at + 16, o.lastRevealedAt, true);
  out[at + 24] = 254;
  return out;
}
const text = (s: string) => new TextEncoder().encode(s);

describe('base58', () => {
  it('writes the discriminator as the text the devnet node accepted as a filter', () => {
    // This exact string was the memcmp filter in the request that returned the fixture.
    expect(base58(STATS_DISCRIMINATOR)).toBe('jPVhWXFTu4g');
  });
  it('writes a leading zero byte as a 1', () => {
    expect(base58(new Uint8Array(32))).toBe('1'.repeat(32)); // the System Program's address
    expect(base58(Uint8Array.of(0, 0, 1))).toBe('112');
    expect(base58(new Uint8Array(0))).toBe('');
  });
  it('agrees with the usual test vector', () => {
    expect(base58(text('Hello World!'))).toBe('2NEpo7TZRRrLZSi2U');
  });
  it('turns the 32 key bytes of a real account back into the key the node filtered by', () => {
    for (const key of [KEY_A, KEY_B, KEY_C]) expect(base58(realBytes(key).subarray(8, 40))).toBe(key);
  });
});

describe('the CallerStats discriminator', () => {
  it('is the first 8 bytes of sha256("account:CallerStats"), as Anchor defines it', () => {
    expect([...STATS_DISCRIMINATOR]).toEqual([...createHash('sha256').update('account:CallerStats').digest().subarray(0, 8)]);
  });
});

describe('decodeCallerStats, on real devnet accounts', () => {
  it('reads every score account the three keys have written', () => {
    const decoded = [KEY_A, KEY_B, KEY_C].flatMap((key) => answers[key]!.map((row) => decodeCallerStats(bytesOf(row.account.data[0]!))));
    expect(decoded).toEqual(ON_DEVNET);
  });
  it('reads the record from the front of the 101-byte account and ignores the unused bytes after it', () => {
    const whole = realBytes(KEY_B);
    expect(whole.length).toBe(101);
    // steady-finch-56 is 15 bytes, so the record ends at 44 + 15 + 25.
    expect(decodeCallerStats(whole.subarray(0, 84))).toEqual(ON_DEVNET[1]);
  });
  it('reads from a view into a larger buffer, not only from offset 0', () => {
    const whole = realBytes(KEY_C);
    const padded = new Uint8Array(whole.length + 7);
    padded.set(whole, 7);
    expect(decodeCallerStats(padded.subarray(7))).toEqual(ON_DEVNET[3]);
  });
});

describe('decodeCallerStats, on data that is not a score account', () => {
  it('rejects a wrong discriminator', () => {
    const flipped = realBytes(KEY_A);
    flipped[0] = flipped[0]! ^ 1;
    expect(decodeCallerStats(flipped)).toBeNull();
    // The program's other account kind: same bytes after the first 8, a different name hashed in front.
    const asCall = realBytes(KEY_A);
    asCall.set(createHash('sha256').update('account:CallRecord').digest().subarray(0, 8), 0);
    expect(decodeCallerStats(asCall)).toBeNull();
    expect(decodeCallerStats(new Uint8Array(101))).toBeNull();
  });
  it('rejects data cut short at any point before the end of the record', () => {
    const whole = realBytes(KEY_A); // north-tern-98 is 13 bytes, so the record is 44 + 13 + 25 = 82 bytes
    for (let length = 0; length < 82; length++) expect(decodeCallerStats(whole.subarray(0, length)), `cut to ${length} bytes`).toBeNull();
    expect(decodeCallerStats(whole.subarray(0, 82))).toEqual(ON_DEVNET[0]);
  });
  it('rejects a handle length the program could not have written', () => {
    const tooLong = realBytes(KEY_A);
    new DataView(tooLong.buffer).setUint32(40, 33, true);
    expect(decodeCallerStats(tooLong)).toBeNull();
    const absurd = realBytes(KEY_A);
    new DataView(absurd.buffer).setUint32(40, 0xffffffff, true);
    expect(decodeCallerStats(absurd)).toBeNull();
  });
  it('rejects a handle that is not UTF-8, and more hits than calls (hand-built: devnet holds neither)', () => {
    expect(decodeCallerStats(handBuilt({ handle: Uint8Array.of(0xff, 0xfe, 0xfd), calls: 1, hits: 1, edgeSum: 1n, lastRevealedAt: 1n }))).toBeNull();
    expect(decodeCallerStats(handBuilt({ handle: text('wry-hare-33'), calls: 1, hits: 2, edgeSum: 1n, lastRevealedAt: 1n }))).toBeNull();
  });
});

describe('decodeCallerStats, on cases devnet does not hold yet (hand-built from the Rust layout)', () => {
  it('reads a losing total as a negative number', () => {
    const s = decodeCallerStats(handBuilt({ handle: text('wry-hare-33'), calls: 2, hits: 0, edgeSum: -1_200_000n, lastRevealedAt: 1794979161n }));
    expect(s).toEqual({ authority: KEY_A, handle: 'wry-hare-33', calls: 2, hits: 0, edgeSum: -1_200_000, lastRevealedAt: 1794979161 });
  });
  it('reads a handle of the full 32 bytes, which fills the account exactly', () => {
    const handle = 'a-handle-of-exactly-32-bytes-000';
    const data = handBuilt({ handle: text(handle), calls: 7, hits: 3, edgeSum: 123_456n, lastRevealedAt: 1794979161n });
    expect(data.length).toBe(101);
    expect(decodeCallerStats(data)?.handle).toBe(handle);
    expect(decodeCallerStats(data.subarray(0, 100))).toBeNull();
  });
});

describe('statsFromAnswer', () => {
  it('reads a real getProgramAccounts answer', () => {
    expect(statsFromAnswer(answers[KEY_B], PROGRAM, KEY_B)).toEqual([ON_DEVNET[1], ON_DEVNET[2]]);
  });
  it('does not count an account the program does not own, or a record that names another key', () => {
    const stranger = answers[KEY_B]!.map((row) => ({ ...row, account: { ...row.account, owner: '11111111111111111111111111111111' } }));
    expect(statsFromAnswer(stranger, PROGRAM, KEY_B)).toEqual([]);
    // A node that ignored the filter and sent key B's accounts when asked for key A.
    expect(statsFromAnswer(answers[KEY_B], PROGRAM, KEY_A)).toEqual([]);
  });
  it('skips entries it cannot read and keeps the rest', () => {
    const good = answers[KEY_A]![0]!;
    const junk = [null, {}, { account: { owner: PROGRAM, data: 'not a pair' } }, { account: { owner: PROGRAM, data: [good.account.data[0], 'base58'] } }, { account: { owner: PROGRAM, data: ['***', 'base64'] } }, good];
    expect(statsFromAnswer(junk, PROGRAM, KEY_A)).toEqual([ON_DEVNET[0]]);
  });
  it('refuses an answer that is not a list, so a broken node is an error and not an empty board', () => {
    expect(() => statsFromAnswer(null, PROGRAM, KEY_A)).toThrow(/cannot read/);
    expect(() => statsFromAnswer({ value: [] }, PROGRAM, KEY_A)).toThrow(/cannot read/);
  });
});

describe('boardRows', () => {
  const one = (handle: string, calls: number, hits: number, edgeSum: number, lastRevealedAt = 1000): CallerStats => ({ authority: KEY_A, handle, calls, hits, edgeSum, lastRevealedAt });

  it('orders by edge, then by number of calls, then by handle: the server\'s order', () => {
    // The same three players as the chain service's own leaderboard test, plus a full tie.
    const rows = boardRows([one('wry-hare-33', 2, 0, -1_200_000), one('bold-lynx-22', 1, 1, 800_000), one('calm-fox-11', 3, 2, 800_000), one('able-wren-44', 1, 1, 800_000)]);
    expect(rows.map((r) => [r.handle, r.calls, r.edge])).toEqual([
      ['calm-fox-11', 3, 0.8],
      ['able-wren-44', 1, 0.8],
      ['bold-lynx-22', 1, 0.8],
      ['wry-hare-33', 2, -1.2],
    ]);
  });
  it('gives each row its hit rate and the time of its latest reveal', () => {
    expect(boardRows([ON_DEVNET[1]!])).toEqual([{ handle: 'steady-finch-56', calls: 4, hits: 2, hitRate: 0.5, edge: 0.780163, lastRevealedAt: '2026-11-18T07:31:29.000Z' }]);
  });
  it('adds up one handle\'s accounts under different keys, as the server does when it trusts several', () => {
    expect(boardRows(ON_DEVNET).map((r) => [r.handle, r.calls, r.hits, r.edge, r.lastRevealedAt])).toEqual([
      ['north-tern-98', 3, 3, 1.77, '2026-11-18T05:30:32.000Z'],
      ['brisk-heron-69', 2, 2, 1.18, '2026-11-18T21:52:03.000Z'],
      ['steady-finch-56', 4, 2, 0.780163, '2026-11-18T07:31:29.000Z'],
    ]);
  });
  it('holds back players below the minimum number of calls, and never shows a player with none', () => {
    expect(boardRows(ON_DEVNET.slice(1, 3), 2).map((r) => r.handle)).toEqual(['steady-finch-56']);
    expect(boardRows([one('new-crow-55', 0, 0, 0)], 0)).toEqual([]);
  });
});

describe('readProgramBoard', () => {
  /** A node holding what devnet held: score accounts for every key, and the call accounts fetched for KEY_B. */
  const devnetNode = (asked: unknown[][] = []): Rpc => async (method, params) => {
    asked.push([method, ...params]);
    const { filters } = params[1] as { filters: { memcmp: { bytes: string } }[] };
    const [kind, key] = [filters[0]!.memcmp.bytes, filters[1]!.memcmp.bytes];
    if (kind === base58(CALL_DISCRIMINATOR)) return key === devnetCalls.authority ? devnetCalls.accounts : [];
    return answers[key] ?? [];
  };

  it('asks the node once per key for that key\'s score accounts, then once per key for its calls, and builds the board from the answers', async () => {
    const asked: unknown[][] = [];
    const rows = await readProgramBoard(devnetNode(asked), PROGRAM, [KEY_B, KEY_C, KEY_B]);
    const ask = (kind: string, key: string) => ['getProgramAccounts', PROGRAM, { encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: kind } }, { memcmp: { offset: 8, bytes: key } }] }];
    expect(asked).toEqual([ask('jPVhWXFTu4g', KEY_B), ask('jPVhWXFTu4g', KEY_C), ask('RnFVmNVZyfW', KEY_B), ask('RnFVmNVZyfW', KEY_C)]);
    expect(rows.map((r) => [r.handle, r.calls, r.edge])).toEqual([
      ['brisk-heron-69', 2, 1.18],
      ['north-tern-98', 2, 1.18],
      ['steady-finch-56', 4, 0.780163],
    ]);
  });
  it('says how many calls each player sealed, from the program\'s own call accounts', async () => {
    const rows = await readProgramBoard(devnetNode(), PROGRAM, [KEY_B]);
    // On devnet steady-finch-56 sealed five calls under this key and revealed four: the fifth was refunded and can never be.
    expect(rows.map((r) => [r.handle, r.calls, r.sealed])).toEqual([
      ['steady-finch-56', 4, 5],
      ['north-tern-98', 1, 1],
    ]);
  });
  it('still shows the scores when the second read is turned away, only without the sealed counts', async () => {
    const rationed: Rpc = async (method, params) => {
      const { filters } = params[1] as { filters: { memcmp: { bytes: string } }[] };
      if (filters[0]!.memcmp.bytes === base58(CALL_DISCRIMINATOR)) throw new Error('The Solana node answered 429.');
      return devnetNode()(method, params);
    };
    const rows = await readProgramBoard(rationed, PROGRAM, [KEY_B]);
    expect(rows.map((r) => [r.handle, r.calls, r.sealed])).toEqual([
      ['steady-finch-56', 4, undefined],
      ['north-tern-98', 1, undefined],
    ]);
  });
  it('is an empty board when the key has written nothing', async () => {
    expect(await readProgramBoard(async () => [], PROGRAM, [KEY_A])).toEqual([]);
  });
  it('passes a node failure on, so the page can say what happened', async () => {
    const down: Rpc = async () => {
      throw new Error('The Solana node answered 429.');
    };
    await expect(readProgramBoard(down, PROGRAM, [KEY_A])).rejects.toThrow('429');
  });
  it('reads a call account: who sealed it, under which key, and whether it has been revealed', () => {
    // What https://api.devnet.solana.com answered on 2026-11-19 for the call accounts KEY_B has written: six calls, 147 bytes each.
    const bytes = (i: number) => Uint8Array.from(Buffer.from(devnetCalls.accounts[i]!.account.data[0]!, 'base64'));
    const calls = devnetCalls.accounts.map((_, i) => decodeCallRecord(bytes(i))!);
    expect(calls.map((c) => [c.handle, c.revealed])).toEqual([
      ['steady-finch-56', true],
      ['steady-finch-56', true],
      ['steady-finch-56', false],
      ['north-tern-98', true],
      ['steady-finch-56', true],
      ['steady-finch-56', true],
    ]);
    expect(calls.every((c) => c.authority === KEY_B && c.committedAt > 1_794_000_000 && c.committedAt < 1_796_000_000)).toBe(true);
    expect(callsFromAnswer(devnetCalls.accounts, PROGRAM, KEY_B)).toHaveLength(6);
    expect(callsFromAnswer(devnetCalls.accounts, PROGRAM, KEY_A)).toHaveLength(0); // another key's calls are not counted
    expect(callsFromAnswer(devnetCalls.accounts, KEY_A, KEY_B)).toHaveLength(0); // nor accounts some other program owns
    expect([...sealedByHandle(calls)]).toEqual([
      ['steady-finch-56', { sealed: 5, revealed: 4 }],
      ['north-tern-98', { sealed: 1, revealed: 1 }],
    ]);

    // Not a call account: a score account's bytes, bytes cut short, and a state that is neither sealed nor revealed.
    expect(decodeCallRecord(realBytes(KEY_A))).toBeNull();
    expect(decodeCallRecord(bytes(0).subarray(0, 100))).toBeNull();
    const odd = bytes(0);
    odd[76 + new DataView(odd.buffer).getUint32(72, true) + 16] = 7;
    expect(decodeCallRecord(odd)).toBeNull();
  });
  it('names the call account by the hash of its name, as Anchor does', () => {
    expect([...CALL_DISCRIMINATOR]).toEqual([...createHash('sha256').update('account:CallRecord').digest().subarray(0, 8)]);
    expect(callFilters(KEY_B)).toEqual([{ memcmp: { offset: 0, bytes: 'RnFVmNVZyfW' } }, { memcmp: { offset: 8, bytes: KEY_B } }]);
  });
  it('builds the same filters as the chain service', () => {
    expect(statsFilters(KEY_A)).toEqual([{ memcmp: { offset: 0, bytes: 'jPVhWXFTu4g' } }, { memcmp: { offset: 8, bytes: KEY_A } }]);
  });
});

describe('comparing with the server\'s table', () => {
  const program = boardRows(ON_DEVNET.slice(1, 3)); // key B: steady-finch-56 and north-tern-98 gitleaks:allow
  const server = [
    { handle: 'north-tern-98', calls: 1, hitRate: 1, edge: 0.59 },
    // The server rounds edge to four decimals; the program keeps 0.780163.
    { handle: 'steady-finch-56', calls: 4, hitRate: 0.5, edge: 0.7802 },
  ];

  it('counts a player as matching when calls, hits and edge agree', () => {
    const c = compareBoards(program, server);
    expect(c).toEqual({ total: 2, same: 2, differing: [] });
    expect(comparisonLine(c)).toBe('Matches the table above for 2 of 2 players.');
  });
  it('names a player whose figures differ', () => {
    for (const changed of [{ calls: 5, hitRate: 0.4 }, { hitRate: 0.75 }, { edge: 0.7812 }]) {
      const c = compareBoards(program, [server[0]!, { ...server[1]!, ...changed }]);
      expect(c).toEqual({ total: 2, same: 1, differing: ['steady-finch-56'] });
    }
  });
  it('counts an honest player as matching however many calls they have, when the server adds in millionths and rounds the total once', () => {
    // A call at a fair price of 0.123456 that hit: the program adds 876_544 millionths, and so does the server.
    for (const calls of [1, 3, 5, 10, 20, 50, 100, 500]) {
      const row = boardRows([{ authority: KEY_A, handle: 'honest-player-1', calls, hits: calls, edgeSum: calls * 876_544, lastRevealedAt: 1 }]);
      const rounded = Math.round((calls * 876_544) / 100) / 1e4;
      expect(compareBoards(row, [{ handle: 'honest-player-1', calls, hitRate: 1, edge: rounded }]), `${calls} calls`).toEqual({ total: 1, same: 1, differing: [] });
    }
  });
  it('still names a player whose edge really differs, at any number of calls', () => {
    for (const calls of [1, 10, 100]) {
      const row = boardRows([{ authority: KEY_A, handle: 'honest-player-1', calls, hits: calls, edgeSum: calls * 876_544, lastRevealedAt: 1 }]);
      const off = Math.round((calls * 0.876544 + 0.01 * (1 + calls / 100)) * 1e4) / 1e4; // a cent or so per $1 away: more than rounding can explain
      expect(compareBoards(row, [{ handle: 'honest-player-1', calls, hitRate: 1, edge: off }]).differing, `${calls} calls`).toEqual(['honest-player-1']);
    }
  });
  it('allows only the one rounding of the total, however many calls there are', () => {
    expect(edgeTolerance()).toBeCloseTo(0.0001, 7);
  });
  it('does not let a long record be inflated unseen: 200 calls and a server edge 0.01 too high is named', () => {
    const calls = 200;
    const row = boardRows([{ authority: KEY_A, handle: 'long-record-1', calls, hits: calls, edgeSum: calls * 500_000, lastRevealedAt: 1 }]);
    const honest = compareBoards(row, [{ handle: 'long-record-1', calls, hitRate: 1, edge: 100 }]);
    const inflated = compareBoards(row, [{ handle: 'long-record-1', calls, hitRate: 1, edge: 100.01 }]);
    expect(honest.differing).toEqual([]);
    expect(inflated.differing).toEqual(['long-record-1']);
  });
  it('names a player who is on one table only: a Memo-only call on the server\'s, or a row the server has not indexed', () => {
    const c = compareBoards(program, [server[0]!, { handle: 'calm-fox-11', calls: 2, hitRate: 0.5, edge: 0.1 }]);
    expect(c).toEqual({ total: 3, same: 1, differing: ['steady-finch-56', 'calm-fox-11'] });
    expect(comparisonLine(c)).toBe('Matches the table above for 1 of 3 players. Different or on one side only: steady-finch-56, calm-fox-11.');
  });
  it('keeps the sentence short when many differ, and gets one player right', () => {
    expect(comparisonLine({ total: 6, same: 1, differing: ['a', 'b', 'c', 'd', 'e'] })).toBe('Matches the table above for 1 of 6 players. Different or on one side only: a, b, c and 2 more.');
    expect(comparisonLine({ total: 1, same: 1, differing: [] })).toBe('Matches the table above for 1 of 1 player.');
  });
});

describe('readProblem', () => {
  it('names a rate limit, which public devnet nodes often answer this request with', () => {
    expect(readProblem(new Error('The Solana node answered 429.'))).toMatch(/busy.*try again/i);
    expect(readProblem(new Error('Too many requests for a specific RPC call'))).toMatch(/busy/);
  });
  it('says the node could not be reached when fetch itself failed', () => {
    expect(readProblem(new TypeError('Failed to fetch'))).toMatch(/Could not reach/);
  });
  it('never puts what the node said on the page: anything else is the app\'s own sentence', () => {
    expect(readProblem(new Error('The Solana node answered 503.'))).toBe('Something went wrong. Try again in a moment.');
    expect(readProblem(new Error('Transaction version (0) is not supported by the requesting client'))).toBe('Something went wrong. Try again in a moment.');
    expect(readProblem('nope')).toBe('Something went wrong. Try again in a moment.');
  });
});

describe('explorerAddress', () => {
  it('links to the program on the devnet explorer', () => {
    expect(explorerAddress(PROGRAM)).toBe('https://explorer.solana.com/address/8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK?cluster=devnet');
  });
});
