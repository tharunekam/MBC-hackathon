import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/api.ts';
import { Ledger } from '../src/ledger.ts';
import { FakeExchange } from './fake.ts';

export const near = (actual: number, expected: number, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);

/** Offerable as it stands: fair 0.50, 4.1 cents over at production fees. */
export const TIGHT = [
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.4, ask: 0.41 },
];
/** The sandbox's bot book: about 18 cents over fair. */
export const WIDE = [
  { strike: 1800, bid: 0.83, ask: 0.97 },
  { strike: 1820, bid: 0.35, ask: 0.54 },
];

export type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Runs the real HTTP handler on a spare local port, backed by the in-memory exchange. */
export async function start(strikes: ConstructorParameters<typeof FakeExchange>[1], opts: { waiveMarkup?: boolean; seeded?: boolean; adminToken?: string } = {}) {
  const exchange = new FakeExchange('ETHTEST', strikes);
  const other = new FakeExchange('ETHTEST', strikes); // a second user's account
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-api-')), 'ledger.json'));
  let clock = new Date('2026-11-17T23:10:00Z');
  let n = 0;
  let sessionsOpened = 0;
  const sessions = new Map<string, FakeExchange>();
  const api = createApi({
    ledger,
    users: ['primary', 'alice'],
    exchangeFor: (user) => {
      if (!sessions.has(user)) {
        sessionsOpened++;
        sessions.set(user, user === 'primary' ? exchange : other);
      }
      return sessions.get(user)!;
    },
    isConnected: (user) => sessions.has(user),
    markets: { listEvents: () => exchange.listEvents(), getEvent: (t) => exchange.getEvent(t) },
    isSandbox: true,
    feeCoef: 0,
    waiveMarkup: opts.waiveMarkup ?? false,
    seeded: opts.seeded,
    adminToken: opts.adminToken,
    marketsCacheMs: 0,
    now: () => clock,
    newId: () => `api${++n}`,
  });
  const server = createServer(api);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : null) as Json };
  };
  const betBody = (extra: object = {}) => ({
    user: 'primary',
    event: 'ETHTEST',
    condition: exchange.symbol(1800),
    target: exchange.symbol(1820),
    stake: 10,
    slippageTicks: 0,
    ...extra,
  });
  return {
    exchange,
    other,
    ledger,
    call,
    betBody,
    setClock: (iso: string) => (clock = new Date(iso)),
    sessionsOpened: () => sessionsOpened,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
