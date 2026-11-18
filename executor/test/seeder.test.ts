import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrderRequest, OrderResult, VenueOrder } from '../src/exchange.ts';
import type { DepthSnapshot, GeminiEvent } from '../src/gemini/types.ts';
import type { Rung } from '../src/pairs.ts';
import { DEFAULTS, Seeder, TAG_PREFIX, assessBook, fairCurve, othersTop, planQuotes, seededBook } from '../src/seeder.ts';
import type { SeederVenue } from '../src/seeder.ts';

const rung = (strike: number, bid: number | null, ask: number | null, open = true): Rung => ({
  symbol: `GEMI-BTC-HI${strike}`,
  label: `$${strike} or above`,
  strike,
  bid,
  ask,
  open,
  state: open ? 'active/open' : 'active/post_only',
});

/** A sandbox-like ladder: a sensible curve, but every book about 19 cents wide. */
const WIDE = [0.93, 0.84, 0.7, 0.52, 0.34, 0.2, 0.1, 0.04];
const wideLadder = (): Rung[] => WIDE.map((mid, i) => rung(62000 + i * 250, Math.max(0.01, +(mid - 0.095).toFixed(2)), Math.min(0.99, +(mid + 0.095).toFixed(2))));

const falling = (xs: Array<number | null>) => xs.filter((x): x is number => x !== null).every((x, i, a) => i === 0 || x <= a[i - 1]! + 1e-9);

describe('fair value of a ladder', () => {
  it('is the middle of each two-sided book', () => {
    assert.deepEqual(fairCurve([rung(1, 0.6, 0.8), rung(2, 0.3, 0.5)]), [0.7, 0.4]);
  });

  it('fills a rung with no book from its neighbours, by strike, and guesses nothing at the ends', () => {
    const curve = fairCurve([rung(100, null, null), rung(200, 0.7, 0.9), rung(250, null, 0.9), rung(400, 0.3, 0.5), rung(500, null, null)]);
    assert.equal(curve[0], null);
    assert.equal(curve[1], 0.8);
    assert.equal(curve[2], 0.7, 'a quarter of the way from 0.8 to 0.4');
    assert.equal(curve[3], 0.4);
    assert.equal(curve[4], null);
  });

  it('falls as the strike rises even when the books do not', () => {
    // the third rung is priced above the second: a stale book
    const curve = fairCurve([rung(1, 0.8, 0.9), rung(2, 0.4, 0.5), rung(3, 0.6, 0.7), rung(4, 0.1, 0.2)]);
    assert.ok(falling(curve), JSON.stringify(curve));
    assert.equal(curve[1], curve[2], 'the two that disagreed are pooled');
    assert.equal(curve[0], 0.85);
  });
});

describe('the quotes it plans', () => {
  it('turns a 19 cent sandbox book into a 4 cent one, inside the existing prices', () => {
    const rungs = wideLadder();
    const quotes = planQuotes(rungs);
    const quoted = quotes.filter((q) => q.bid !== null && q.ask !== null);
    assert.ok(quoted.length >= 6, `quoted ${quoted.length} rungs`);
    for (const q of quoted) {
      const r = rungs.find((x) => x.symbol === q.symbol)!;
      assert.ok(Math.abs(q.ask! - q.bid! - 0.04) < 1e-9, `${q.symbol} is ${q.ask! - q.bid!} wide`);
      assert.ok(q.bid! > r.bid! && q.bid! < r.ask!, 'the bid improves the book and does not reach the ask');
      assert.ok(q.ask! < r.ask! && q.ask! > r.bid!, 'the ask improves the book and does not reach the bid');
      assert.equal(q.size, DEFAULTS.size);
    }
    assert.ok(falling(quotes.map((q) => q.bid)), 'our bids fall as the strike rises');
    assert.ok(falling(quotes.map((q) => q.ask)), 'our asks fall as the strike rises');
  });

  it('leaves near-certain and near-impossible rungs, and rungs that are not open, alone', () => {
    const rungs = [rung(1, 0.96, 0.99), rung(2, 0.6, 0.8), rung(3, 0.3, 0.5, false), rung(4, 0.01, 0.05)];
    const quotes = planQuotes(rungs);
    assert.deepEqual(quotes.map((q) => [q.bid, q.ask]), [[null, null], [0.68, 0.72], [null, null], [null, null]]);
    assert.equal(quotes[2]!.fair, 0.4, 'a closed rung still informs the curve');
  });

  it('never quotes at or through the other side, whatever the fair value says', () => {
    // The curve is pooled across two rungs that disagree, which puts fair outside one rung's own book.
    const rungs = [rung(1, 0.3, 0.34), rung(2, 0.6, 0.64), rung(3, 0.1, 0.2)];
    for (const q of planQuotes(rungs)) {
      const r = rungs.find((x) => x.symbol === q.symbol)!;
      if (q.bid !== null) assert.ok(q.bid < r.ask!, `${q.symbol}: bid ${q.bid} reaches the ask ${r.ask}`);
      if (q.ask !== null) assert.ok(q.ask > r.bid!, `${q.symbol}: ask ${q.ask} reaches the bid ${r.bid}`);
      if (q.bid !== null && q.ask !== null) assert.ok(q.bid < q.ask);
    }
  });

  it('does not quote a side where it would not improve on what already rests', () => {
    // already a 2 cent book: there is nothing to add
    const quotes = planQuotes([rung(1, 0.69, 0.71), rung(2, 0.39, 0.41)]);
    assert.deepEqual(quotes.map((q) => [q.bid, q.ask]), [[null, null], [null, null]]);
    assert.deepEqual(quotes.map((q) => q.size), [0, 0]);
  });

  it('a wider half spread gives a wider book', () => {
    const [q] = planQuotes([rung(1, 0.3, 0.7)], { halfSpread: 0.05 });
    assert.deepEqual([q!.bid, q!.ask], [0.45, 0.55]);
  });

  it('stays within its budget: smaller sizes first, then fewer rungs, keeping the ones bets are made on', () => {
    const rungs = wideLadder();
    const tiedUp = (quotes: ReturnType<typeof planQuotes>) => quotes.reduce((sum, q) => sum + ((q.bid ?? 0) + (q.ask !== null ? 1 - q.ask : 0)) * q.size, 0);
    const full = planQuotes(rungs, { maxDollars: 10_000 });
    assert.equal(full.find((q) => q.size > 0)!.size, 40);

    const smaller = planQuotes(rungs, { maxDollars: 100 });
    assert.ok(tiedUp(smaller) <= 100, `ties up ${tiedUp(smaller)}`);
    const size = smaller.find((q) => q.size > 0)!.size;
    assert.ok(size < 40 && size >= 5, `size ${size}`);
    assert.equal(smaller.filter((q) => q.size > 0).length, full.filter((q) => q.size > 0).length, 'every rung is still quoted');

    const tiny = planQuotes(rungs, { maxDollars: 12 });
    assert.ok(tiedUp(tiny) <= 12, `ties up ${tiedUp(tiny)}`);
    const kept = tiny.filter((q) => q.size > 0);
    assert.ok(kept.length >= 1 && kept.length < full.filter((q) => q.size > 0).length);
    assert.ok(kept.every((q) => q.size === 5));
    assert.ok(kept.every((q) => Math.abs(q.fair! - 0.5) <= 0.2), `kept ${kept.map((q) => q.fair)}`);
  });
});

describe('what the offer rule makes of the book, with no waiver', () => {
  it('refuses the sandbox as it is, and offers pairs once the quotes rest', () => {
    const rungs = wideLadder();
    const before = assessBook(rungs);
    assert.ok(before.medianSpread! > 0.15);
    assert.equal(before.ok + before.warn, 0, 'a 19 cent book passes nothing');
    assert.ok((before.refusedBy.markup_too_high ?? 0) > 0);

    // A 4 cent book, about what production shows: some pairs now pass, each still flagged as costing 5 to 8 cents
    // over fair, because Gemini's production fee is counted on top of the spread.
    const after = assessBook(seededBook(rungs, planQuotes(rungs)));
    assert.equal(after.medianSpread, 0.04);
    assert.ok(after.ok + after.warn >= 6, `${after.ok} ok and ${after.warn} warn of ${after.pairs}`);
    assert.equal(after.outOfOrder, 0);

    // A 2 cent book passes more, and some without a warning. Tighter than production: say so if it is used.
    const tighter = assessBook(seededBook(rungs, planQuotes(rungs, { halfSpread: 0.01 })));
    assert.equal(tighter.medianSpread, 0.02);
    assert.ok(tighter.ok + tighter.warn > after.ok + after.warn);
    assert.ok(tighter.ok > 0);
  });

  it('seeding puts a ladder the bots left out of order back in order', () => {
    // rung 3's bid sits above rung 2's: the executor refuses every pair on such a ladder
    const rungs = [rung(1, 0.7, 0.9), rung(2, 0.3, 0.6), rung(3, 0.35, 0.55), rung(4, 0.05, 0.25)];
    assert.ok(assessBook(rungs).outOfOrder > 0);
    const after = seededBook(rungs, planQuotes(rungs));
    assert.equal(assessBook(after).outOfOrder, 0, JSON.stringify(after.map((r) => [r.bid, r.ask])));
  });
});

describe('books seen on the real sandbox (2026-11-18)', () => {
  const from = (rows: Array<[number, number | null, number | null]>) => rows.map(([k, b, a]) => rung(k, b, a));

  it('ETH: one rung bid above the rung below it. Our bids step up to cover it and the ladder is in order', () => {
    const rungs = from([[1680, 0.82, 0.97], [1700, 0.8, 0.97], [1720, 0.9, 0.97], [1740, 0.84, 0.97], [1760, 0.2, 0.38], [1780, 0.03, null], [1800, 0.03, 0.18], [1820, 0.03, 0.18]]);
    assert.ok(assessBook(rungs).outOfOrder > 0);
    const quotes = planQuotes(rungs);
    const after = assessBook(seededBook(rungs, quotes));
    assert.equal(after.outOfOrder, 0, JSON.stringify(quotes.map((q) => [q.bid, q.ask])));
    assert.ok(after.ok + after.warn > 0, 'and pairs are on offer where none were');
    assert.ok(quotes[0]!.bid! >= 0.9 && quotes[1]!.bid! >= 0.9, 'the two lower rungs bid at least what the third does');
  });

  it('BTC: asks that rise with the strike. Our asks come down to cover them', () => {
    const rungs = from([[62100, 0.03, null], [62200, 0.03, 0.2], [62300, 0.03, 0.18], [62400, 0.03, 0.18], [62500, 0.03, 0.1], [62600, 0.03, 0.2], [62700, 0.03, 0.1], [62800, 0.03, 0.1]]);
    assert.ok(assessBook(rungs).outOfOrder > 0);
    assert.equal(assessBook(seededBook(rungs, planQuotes(rungs))).outOfOrder, 0);
  });

  it('whatever the bots show, seeding never crosses them, never inverts its own quotes and never makes the order worse', () => {
    // a small fixed-seed generator, so a failure can be reproduced
    let seed = 20261118;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const cent = (x: number) => Math.round(x * 100) / 100;
    for (let trial = 0; trial < 1500; trial++) {
      const rungs = Array.from({ length: 3 + Math.floor(rand() * 7) }, (_, i) => {
        const mid = 0.02 + rand() * 0.96;
        const half = 0.01 + rand() * 0.12;
        const bid = rand() < 0.1 ? null : cent(Math.max(0.01, mid - half));
        const ask = rand() < 0.1 ? null : cent(Math.min(0.99, Math.max((bid ?? 0) + 0.01, mid + half)));
        return rung(100 + i, bid, ask, rand() > 0.1);
      });
      const quotes = planQuotes(rungs, { halfSpread: rand() < 0.5 ? 0.02 : 0.01 });
      const note = `trial ${trial}: ${JSON.stringify(rungs.map((r) => [r.bid, r.ask, r.open]))} -> ${JSON.stringify(quotes.map((q) => [q.bid, q.ask]))}`;
      quotes.forEach((q, i) => {
        const r = rungs[i]!;
        if (q.bid !== null) {
          assert.ok(r.open, `bid on a closed rung. ${note}`);
          assert.ok(q.bid >= 0.01 - 1e-9 && Math.abs(q.bid * 100 - Math.round(q.bid * 100)) < 1e-6, `bid off the grid. ${note}`);
          if (r.ask !== null) assert.ok(q.bid < r.ask - 1e-9, `bid reaches the ask. ${note}`);
          if (r.bid !== null) assert.ok(q.bid >= r.bid - 1e-9, `bid below the market's. ${note}`);
        }
        if (q.ask !== null) {
          assert.ok(r.open, `ask on a closed rung. ${note}`);
          assert.ok(q.ask <= 0.99 + 1e-9 && Math.abs(q.ask * 100 - Math.round(q.ask * 100)) < 1e-6, `ask off the grid. ${note}`);
          if (r.bid !== null) assert.ok(q.ask > r.bid + 1e-9, `ask reaches the bid. ${note}`);
          if (r.ask !== null) assert.ok(q.ask <= r.ask + 1e-9, `ask above the market's. ${note}`);
        }
        if (q.bid !== null && q.ask !== null) assert.ok(q.bid < q.ask - 1e-9, `our own quotes cross. ${note}`);
        assert.equal(q.size > 0, q.bid !== null || q.ask !== null, `size and quotes disagree. ${note}`);
      });
      assert.ok(falling(quotes.map((q) => q.bid)), `our bids rise with the strike. ${note}`);
      assert.ok(falling(quotes.map((q) => q.ask)), `our asks rise with the strike. ${note}`);
      assert.ok(assessBook(seededBook(rungs, quotes)).outOfOrder <= assessBook(rungs).outOfOrder, `the order got worse. ${note}`);
    }
  });
});

describe('reading the book without our own orders in it', () => {
  const depth: DepthSnapshot = { symbol: 'X', bids: [[0.5, 40], [0.42, 3], [0.4, 10]], asks: [[0.54, 40], [0.61, 7]] };

  it('takes our resting size out of the level it sits on', () => {
    assert.deepEqual(othersTop(depth, { bid: { price: 0.5, size: 40 }, ask: { price: 0.54, size: 40 } }), { bid: 0.42, ask: 0.61 });
  });

  it('keeps a level that someone else is on too', () => {
    assert.deepEqual(othersTop(depth, { bid: { price: 0.5, size: 25 } }), { bid: 0.5, ask: 0.54 });
  });

  it('with nothing of ours resting it is just the top of the book, and an empty side is null', () => {
    assert.deepEqual(othersTop(depth, {}), { bid: 0.5, ask: 0.54 });
    assert.deepEqual(othersTop({ symbol: 'X', bids: [], asks: [[0.3, 1]] }, {}), { bid: null, ask: 0.3 });
  });
});

// ------------------------------------------------------------------ a venue to run it against

interface Mine {
  orderId: string;
  req: OrderRequest;
  filled: number;
  open: boolean;
}

/** A venue with other participants' books, our own orders resting among them, fills, and faults. */
class SimVenue implements SeederVenue {
  others = new Map<string, { bid: number | null; ask: number | null }>();
  orders: Mine[] = [];
  status = 'active';
  expiry = new Date(Date.UTC(2026, 10, 19, 1, 0, 0)).toISOString();
  money = 1000;
  failDepthFor = new Set<string>();
  failPlaceFor = new Set<string>();
  closed = new Set<string>();
  private n = 0;

  constructor(rungs: Rung[]) {
    for (const r of rungs) this.others.set(r.symbol, { bid: r.bid, ask: r.ask });
  }

  /** Our price in YES space: a NO bid at p is an ask at 1 - p. */
  private static yes(o: Mine): { side: 'bid' | 'ask'; price: number } {
    return o.req.outcome === 'yes' ? { side: 'bid', price: o.req.limitPrice } : { side: 'ask', price: +(1 - o.req.limitPrice).toFixed(2) };
  }

  async getEvent(ticker: string): Promise<GeminiEvent> {
    return {
      id: '1',
      title: 'BTC price today at 8pm EST',
      ticker,
      category: 'crypto',
      status: this.status,
      expiryDate: this.expiry,
      contracts: [...this.others].map(([symbol, b]) => ({
        id: symbol,
        label: symbol,
        ticker: symbol,
        instrumentSymbol: symbol,
        status: 'active',
        marketState: this.closed.has(symbol) ? 'post_only' : 'open',
        strike: { type: 'above', value: symbol.replace(/^.*HI/, '') },
        prices: { bestBid: b.bid === null ? null : String(b.bid), bestAsk: b.ask === null ? null : String(b.ask) },
      })),
    };
  }

  async depth(symbol: string): Promise<DepthSnapshot> {
    if (this.failDepthFor.has(symbol)) throw new Error('No order-book depth arrived');
    const o = this.others.get(symbol)!;
    const bids: Array<[number, number]> = o.bid === null ? [] : [[o.bid, 3]];
    const asks: Array<[number, number]> = o.ask === null ? [] : [[o.ask, 3]];
    for (const mine of this.orders.filter((m) => m.open && m.req.symbol === symbol)) {
      const y = SimVenue.yes(mine);
      (y.side === 'bid' ? bids : asks).push([y.price, mine.req.quantity - mine.filled]);
    }
    return { symbol: symbol.toUpperCase(), bids: bids.sort((a, b) => b[0] - a[0]), asks: asks.sort((a, b) => a[0] - b[0]) };
  }

  async place(req: OrderRequest): Promise<OrderResult> {
    if (this.failPlaceFor.has(req.symbol)) throw new Error('order.place: 429 rate limit');
    const mine: Mine = { orderId: `9${String(++this.n).padStart(17, '0')}`, req, filled: 0, open: true };
    const o = this.others.get(req.symbol)!;
    const y = SimVenue.yes(mine);
    // An order that reaches the other side trades instead of resting.
    if ((y.side === 'bid' && o.ask !== null && y.price >= o.ask) || (y.side === 'ask' && o.bid !== null && y.price <= o.bid)) {
      mine.filled = req.quantity;
      mine.open = false;
    }
    this.orders.push(mine);
    return { orderId: mine.orderId, filledQuantity: mine.filled, avgPrice: mine.filled ? req.limitPrice : null, open: mine.open };
  }

  async cancel(orderId: string): Promise<void> {
    const mine = this.orders.find((m) => m.orderId === orderId);
    if (!mine || !mine.open) throw new Error('order not open');
    mine.open = false;
  }

  async openOrders(): Promise<VenueOrder[]> {
    return this.orders
      .filter((m) => m.open)
      .map((m) => ({ orderId: m.orderId, filledQuantity: m.filled, avgPrice: null, open: true, clientOrderId: m.req.clientOrderId, symbol: m.req.symbol, side: m.req.side, createdAt: null }));
  }

  async cash(): Promise<number> {
    return this.money;
  }

  /** Someone trades against one of our resting orders. */
  hit(symbol: string, side: 'bid' | 'ask', quantity: number): void {
    const mine = this.orders.find((m) => m.open && m.req.symbol === symbol && SimVenue.yes(m).side === side)!;
    mine.filled = Math.min(mine.req.quantity, mine.filled + quantity);
    if (mine.filled >= mine.req.quantity) mine.open = false;
  }
  live(): Mine[] {
    return this.orders.filter((m) => m.open);
  }
}

const NOW = Date.UTC(2026, 10, 19, 0, 20, 0); // forty minutes before the ladder closes
const boot = (rungs: Rung[] = wideLadder(), opts: ConstructorParameters<typeof Seeder>[1] = {}) => {
  const venue = new SimVenue(rungs);
  const seeder = new Seeder(venue, { runId: 'test01', now: () => NOW, ...opts });
  return { venue, seeder, rungs };
};
const SYM = (i: number) => `GEMI-BTC-HI${62000 + i * 250}`;

describe('running the seeder', () => {
  it('rests a bid and an ask on every eligible rung: buy YES at the bid, buy NO at one minus the ask, good till cancelled, tagged', async () => {
    const { venue, seeder } = boot();
    assert.equal(await seeder.cycle('BTC2611190100'), 'quoting');
    const live = venue.live();
    const planned = planQuotes(wideLadder()).filter((q) => q.size > 0);
    assert.equal(live.length, planned.length * 2);
    for (const q of planned) {
      const bid = live.find((m) => m.req.symbol === q.symbol && m.req.outcome === 'yes')!;
      const ask = live.find((m) => m.req.symbol === q.symbol && m.req.outcome === 'no')!;
      assert.equal(bid.req.limitPrice, q.bid);
      assert.equal(ask.req.limitPrice, +(1 - q.ask!).toFixed(2));
      for (const o of [bid, ask]) {
        assert.equal(o.req.side, 'buy');
        assert.equal(o.req.tif, 'GTC');
        assert.equal(o.req.quantity, 40);
        assert.ok(o.req.clientOrderId.startsWith(`${TAG_PREFIX}test01-`) && o.req.clientOrderId.length <= 36);
      }
    }
    assert.equal(new Set(live.map((m) => m.req.clientOrderId)).size, live.length, 'every tag is different');
  });

  it('a second pass over an unchanged market does nothing: it does not chase its own quotes', async () => {
    const { venue, seeder } = boot();
    await seeder.cycle('E');
    const placed = venue.orders.length;
    await seeder.cycle('E');
    await seeder.cycle('E');
    assert.equal(venue.orders.length, placed);
    assert.equal(seeder.stats.cancelled, 0);
  });

  it('a one cent move is left alone, a three cent move is followed', async () => {
    const { venue, seeder } = boot();
    await seeder.cycle('E');
    const before = venue.live().find((m) => m.req.symbol === SYM(3) && m.req.outcome === 'yes')!;
    venue.others.set(SYM(3), { bid: 0.44, ask: 0.62 }); // middle up one cent
    await seeder.cycle('E');
    assert.equal(seeder.stats.cancelled, 0);
    assert.ok(before.open);

    venue.others.set(SYM(3), { bid: 0.46, ask: 0.64 }); // middle up three cents
    await seeder.cycle('E');
    assert.equal(before.open, false, 'the old bid was cancelled');
    const now = venue.live().find((m) => m.req.symbol === SYM(3) && m.req.outcome === 'yes')!;
    assert.ok(now.req.limitPrice > before.req.limitPrice);
  });

  it('a resting quote that the market has moved through is pulled even if the plan has barely changed', async () => {
    const { venue, seeder } = boot([rung(62000, 0.3, 0.7)]);
    await seeder.cycle('E');
    const bid = venue.live().find((m) => m.req.outcome === 'yes')!;
    assert.equal(bid.req.limitPrice, 0.48);
    venue.others.set(SYM(0), { bid: 0.3, ask: 0.48 }); // someone now offers at our bid
    await seeder.cycle('E');
    assert.equal(bid.open, false);
    for (const m of venue.live().filter((x) => x.req.outcome === 'yes')) assert.ok(m.req.limitPrice < 0.48);
  });

  it('replaces a quote that filled, and tops up one that is more than half gone', async () => {
    const { venue, seeder } = boot();
    await seeder.cycle('E');
    venue.hit(SYM(3), 'ask', 40); // a bettor buys YES on the target: our whole ask
    venue.hit(SYM(2), 'bid', 30); // and hedges with NO on the condition: most of our bid
    venue.hit(SYM(4), 'bid', 10); // a small fill elsewhere
    await seeder.cycle('E');
    const on = (i: number, outcome: 'yes' | 'no') => venue.live().filter((m) => m.req.symbol === SYM(i) && m.req.outcome === outcome);
    assert.equal(on(3, 'no').length, 1);
    assert.equal(on(3, 'no')[0]!.filled, 0, 'a fresh ask rests where the old one filled');
    assert.equal(on(2, 'yes').length, 1);
    assert.equal(on(2, 'yes')[0]!.filled, 0, 'the mostly-filled bid was replaced by a full one');
    assert.equal(on(4, 'yes')[0]!.filled, 10, 'a lightly-filled quote is left to work');
    assert.equal(seeder.stats.filled, 80);
  });

  it('stops and cancels everything two minutes before the ladder closes, and when the event is no longer active', async () => {
    let now = NOW;
    const { venue, seeder } = boot(wideLadder(), { now: () => now });
    await seeder.cycle('E');
    assert.ok(venue.live().length > 0);
    now = Date.UTC(2026, 10, 19, 0, 58, 30);
    assert.equal(await seeder.cycle('E'), 'stopped');
    assert.equal(venue.live().length, 0);

    const second = boot();
    await second.seeder.cycle('E');
    second.venue.status = 'settled';
    assert.equal(await second.seeder.cycle('E'), 'stopped');
    assert.equal(second.venue.live().length, 0);
  });

  it('cancelAll also sweeps orders an earlier, killed run left behind, and touches nothing else on the account', async () => {
    const { venue, seeder } = boot();
    await venue.place({ symbol: SYM(3), side: 'buy', outcome: 'yes', limitPrice: 0.2, quantity: 5, tif: 'GTC', clientOrderId: `${TAG_PREFIX}oldrun-1` });
    await venue.place({ symbol: SYM(3), side: 'buy', outcome: 'yes', limitPrice: 0.2, quantity: 5, tif: 'GTC', clientOrderId: 'gv-abc123-b1' });
    await seeder.cycle('E');
    const sent = await seeder.cancelAll();
    assert.ok(sent >= 13);
    assert.deepEqual(venue.live().map((m) => m.req.clientOrderId), ['gv-abc123-b1'], 'a bet\'s own order is not the seeder\'s to cancel');
    assert.equal(await seeder.cancelAll(), 0, 'calling it again is harmless');
    assert.deepEqual(seeder.resting(), []);
  });

  it('sends only so many orders in one pass, and finishes on the next', async () => {
    const { venue, seeder } = boot(wideLadder(), { maxActionsPerCycle: 5 });
    await seeder.cycle('E');
    assert.equal(venue.orders.length, 5);
    const wanted = planQuotes(wideLadder()).filter((q) => q.size > 0).length * 2;
    for (let pass = 0; pass < Math.ceil(wanted / 5); pass++) await seeder.cycle('E');
    assert.equal(venue.live().length, wanted);
    assert.equal(venue.orders.length, wanted, 'and nothing was placed twice');
  });

  it('a rung whose depth cannot be read is left exactly as it is, and the rest carry on', async () => {
    const { venue, seeder } = boot();
    await seeder.cycle('E');
    const untouched = venue.live().filter((m) => m.req.symbol === SYM(3)).map((m) => m.orderId);
    venue.failDepthFor.add(SYM(3));
    venue.others.set(SYM(3), { bid: 0.1, ask: 0.3 }); // moved a long way, but we cannot see it
    venue.others.set(SYM(4), { bid: 0.3, ask: 0.49 });
    await seeder.cycle('E');
    assert.deepEqual(venue.live().filter((m) => m.req.symbol === SYM(3)).map((m) => m.orderId), untouched);
    assert.ok(seeder.stats.cancelled > 0, 'the rung that could be read was repriced');
    assert.equal(seeder.stats.skippedRungs, 1);
  });

  it('places nothing more when the account is nearly out of cash', async () => {
    const { venue, seeder } = boot(wideLadder(), { minCash: 50 });
    venue.money = 20;
    await seeder.cycle('E');
    assert.equal(venue.orders.length, 0);
  });

  it('an order the venue refuses is counted and does not stop the others', async () => {
    const { venue, seeder } = boot();
    venue.failPlaceFor.add(SYM(3));
    await seeder.cycle('E');
    assert.equal(seeder.stats.errors, 2);
    assert.ok(venue.live().length >= 10);
    assert.equal(venue.live().filter((m) => m.req.symbol === SYM(3)).length, 0);
    venue.failPlaceFor.clear();
    await seeder.cycle('E');
    assert.equal(venue.live().filter((m) => m.req.symbol === SYM(3)).length, 2, 'it is tried again on the next pass');
  });

  it('does not quote a rung that is not open for trading', async () => {
    const { venue, seeder } = boot();
    venue.closed.add(SYM(3));
    await seeder.cycle('E');
    assert.equal(venue.live().filter((m) => m.req.symbol === SYM(3)).length, 0);
    assert.ok(venue.live().length > 0);
  });
});
