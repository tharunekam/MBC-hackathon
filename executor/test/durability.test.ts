/**
 * The money path's durability rules, checked at the FILE level, not in memory:
 *  - an order is on disk before it leaves for Gemini (so a crash can always be reconciled by its tag);
 *  - a crash between the two legs leaves a ledger that recovery can finish;
 *  - a damaged ledger is never silently replaced by an empty one.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { placeConditionalBet, recoverBets } from '../src/bets.ts';
import type { Exchange, OrderRequest, OrderResult } from '../src/exchange.ts';
import { Ledger, LedgerError } from '../src/ledger.ts';
import { createLimiter } from '../src/limiter.ts';
import { FakeExchange } from './fake.ts';

const TIGHT = [
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.4, ask: 0.41 },
];
const dir = () => mkdtempSync(join(tmpdir(), 'given-dur-'));
const request = (ex: FakeExchange) => ({ user: 'primary', eventTicker: 'ETHTEST', conditionSymbol: ex.symbol(1800), targetSymbol: ex.symbol(1820), stake: 10, slippageTicks: 0 });

/** Wraps an exchange and, at the instant an order is placed, reads what is ALREADY on disk. */
class Spy implements Exchange {
  readonly seenOnDisk: Array<{ tag: string; status: string | undefined }> = [];
  /** Throw after this many placeOrder calls, as a crash between the legs would. */
  crashAfter: number | null = null;
  private placed = 0;
  private readonly inner: FakeExchange;
  private readonly ledgerPath: string;
  constructor(inner: FakeExchange, ledgerPath: string) {
    this.inner = inner;
    this.ledgerPath = ledgerPath;
  }
  getEvent = (t: string) => this.inner.getEvent(t);
  findOrder = (t: string) => this.inner.findOrder(t);
  cancelOrder = (_id: string) => this.inner.cancelOrder();
  cash = () => this.inner.cash();
  allOrders = () => this.inner.allOrders();
  watchBook = (s: string, f: Parameters<Exchange['watchBook']>[1]) => this.inner.watchBook(s, f);
  topOfBook = (s: string) => this.inner.topOfBook(s);
  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const onDisk = JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as { bets: Array<{ legs: Array<{ clientOrderId: string; status: string }> }> };
    const leg = onDisk.bets.flatMap((b) => b.legs).find((l) => l.clientOrderId === req.clientOrderId);
    this.seenOnDisk.push({ tag: req.clientOrderId, status: leg?.status });
    if (this.crashAfter !== null && this.placed >= this.crashAfter) throw new Error('process killed');
    this.placed++;
    return this.inner.placeOrder(req);
  }
}

describe('write before send', () => {
  it('every order is already on disk, as "sent", when it leaves for the exchange', async () => {
    const path = join(dir(), 'ledger.json');
    const fake = new FakeExchange('ETHTEST', TIGHT);
    const spy = new Spy(fake, path);
    const ledger = new Ledger(path);
    await placeConditionalBet({ exchange: spy, ledger, waiveMarkup: false }, request(fake));
    assert.equal(spy.seenOnDisk.length, 2, 'two orders');
    for (const s of spy.seenOnDisk) assert.equal(s.status, 'sent', `leg ${s.tag} was not on disk before it was sent`);
  });

  it('a crash between the two legs leaves a ledger that recovery can read and act on', async () => {
    const path = join(dir(), 'ledger.json');
    const fake = new FakeExchange('ETHTEST', TIGHT);
    const spy = new Spy(fake, path);
    spy.crashAfter = 1; // the first leg is placed, the second never is
    const ledger = new Ledger(path);
    await placeConditionalBet({ exchange: spy, ledger, waiveMarkup: false }, request(fake)).catch(() => undefined);

    // a brand-new process reads the file from disk
    const reborn = new Ledger(path);
    const bet = reborn.data.bets[0]!;
    assert.ok(bet, 'the bet survived');
    assert.ok(bet.legs.length >= 1 && bet.legs[0]!.clientOrderId, 'the first leg is recorded with its tag');
    const fixed = await recoverBets({ exchange: fake, ledger: reborn, feeCoef: 0 }, 'primary');
    assert.ok(fixed >= 0);
    assert.ok(!reborn.data.bets.some((b) => b.status === 'placing'), 'nothing is left half-done after recovery');
  });
});

describe('the ledger file', () => {
  const populated = async () => {
    const path = join(dir(), 'ledger.json');
    const fake = new FakeExchange('ETHTEST', TIGHT);
    const ledger = new Ledger(path);
    await placeConditionalBet({ exchange: fake, ledger, waiveMarkup: false }, request(fake));
    ledger.save();
    return { path, ledger };
  };

  it('keeps the previous good copy and restores it, loudly, if the file is damaged', async () => {
    const { path, ledger } = await populated();
    const id = ledger.data.bets[0]!.id;
    writeFileSync(path, '{"version":1,"bets":[');
    const warned: string[] = [];
    const recovered = new Ledger(path, (l) => warned.push(l));
    assert.equal(recovered.data.bets[0]!.id, id);
    assert.match(warned.join('\n'), /damaged; restored the previous copy/);
    assert.match(warned.join('\n'), /reconcile/i, 'it tells the operator what to do next');
  });

  it('REFUSES to start when the ledger and its backup are both unusable', async () => {
    const { path } = await populated();
    writeFileSync(path, 'not json');
    writeFileSync(`${path}.bak`, '{"version":2}');
    assert.throws(() => new Ledger(path, () => {}), (e: unknown) => e instanceof LedgerError && /forget every order/.test((e as Error).message));
    assert.equal(readFileSync(path, 'utf8'), 'not json', 'left for a human, not overwritten');
  });

  it('a wrong-shaped file is damaged, not empty', () => {
    const path = join(dir(), 'ledger.json');
    writeFileSync(path, JSON.stringify({ hello: 'world' }));
    assert.throws(() => new Ledger(path, () => {}), LedgerError);
  });

  it('a first run is fine, and the file is owner-only (it holds order ids and cash)', () => {
    const path = join(dir(), 'ledger.json');
    const l = new Ledger(path);
    l.save();
    assert.equal(statSync(path).mode & 0o077, 0);
  });

  it('never replaces a good backup with a damaged file', async () => {
    const { path, ledger } = await populated();
    const good = readFileSync(`${path}.bak`, 'utf8');
    writeFileSync(path, 'garbage');
    ledger.save();
    assert.equal(readFileSync(`${path}.bak`, 'utf8'), good);
  });
});

describe('the rate limiter', () => {
  it('sweeps idle clients, so distinct addresses cannot grow it without bound', () => {
    let t = 0;
    const l = createLimiter({ max: 3, windowMs: 1000 }, () => t);
    for (let i = 0; i < 3000; i++) l.limited(`198.51.${i >> 8}.${i & 255}`);
    assert.equal(l.size(), 3000);
    t = 2000;
    l.limited('x');
    assert.equal(l.size(), 1);
  });
});
