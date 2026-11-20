/**
 * A liquidity seeder for Gemini's SANDBOX, run from a second sandbox account (`src/seed.ts` is the command).
 *
 * Why it exists: the sandbox's books are kept by bots, are usually about 19 cents wide and often hold one contract at
 * the best price. Production is about 4 cents wide. On the sandbox the offer rule therefore refuses nearly every pair
 * and the depth guard cuts a $10 bet to about a dollar, so the demo shows neither the price nor the size a real user
 * would get. The seeder rests tight, two-sided quotes around the middle of the bots' own book, so the same executor,
 * with the same rules and no waiver, has something production-like to trade against.
 *
 * What it is not: real liquidity. It is our own second account quoting on a test exchange with test money, and every
 * bet it fills is one of our accounts trading with another. That must be said wherever the demo is shown (README,
 * pitch), and its fills must never be presented as order flow. It refuses to run anywhere but the sandbox.
 *
 * How it prices: for each rung of an "X or above" ladder it takes the middle of the OTHER participants' book (its own
 * resting orders are subtracted from the depth it reads, so it never chases itself), fills gaps between rungs by
 * interpolation, and forces the curve to fall as the strike rises. It then quotes that fair value plus and minus a
 * half spread, never at or through the other side of the existing book, with both of its ladders kept in order.
 *
 * A "sell YES at 0.57" is placed as "buy NO at 0.43": that is how Gemini's contracts are quoted, and when both of a
 * rung's quotes fill Gemini nets the YES against the NO and pays the dollar, so the position closes itself.
 *
 * NOT YET RUN ON THE SANDBOX: no second account or keys were available where this was written. The quoting is tested
 * here and checked against the sandbox's public prices (`--dry-run`); resting orders, cancels and the depth read with
 * our own orders in it are exercised only against stand-ins. docs in executor/README.md say how to do the first run.
 */
import type { OrderRequest, OrderResult, VenueOrder } from './exchange.ts';
import type { DepthSnapshot, GeminiEvent } from './gemini/types.ts';
import { assessPair, ladderInversions } from './offer.ts';
import { ladder } from './pairs.ts';
import type { Rung } from './pairs.ts';
import { PRICE_TICK, ceilToStep, clean, floorToStep } from './pricing.ts';

export interface SeederSettings {
  /** Distance of each quote from fair value. 0.02 gives a 4 cent book, about what production shows. */
  halfSpread: number;
  /** Contracts rested on each side of each rung. */
  size: number;
  /** Most money tied up in resting quotes on one ladder. Sizes shrink, then rungs are dropped, to stay under it. */
  maxDollars: number;
  /** Rungs whose fair value is outside these are not quoted: nothing is bet on near-certain or near-impossible rungs. */
  minFair: number;
  maxFair: number;
  /** Below this many contracts a quote is not worth resting. */
  minSize: number;
}

export const DEFAULTS: SeederSettings = { halfSpread: 0.02, size: 40, maxDollars: 400, minFair: 0.05, maxFair: 0.95, minSize: 5 };

export interface Quote {
  symbol: string;
  strike: number;
  /** The fair value the quote is built around, or null when the rung's value cannot be read. */
  fair: number | null;
  /** YES-space prices to rest at; null means that side is not quoted. */
  bid: number | null;
  ask: number | null;
  size: number;
}

const EPS = 1e-9;

/** The best non-increasing fit to a sequence (pool adjacent violators): "X or above" must get cheaper as X rises. */
function fallingFit(values: number[]): number[] {
  const blocks: Array<{ sum: number; n: number }> = [];
  for (const v of values) {
    blocks.push({ sum: v, n: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!;
      const prev = blocks[blocks.length - 2]!;
      if (last.sum / last.n <= prev.sum / prev.n + EPS) break;
      prev.sum += last.sum;
      prev.n += last.n;
      blocks.pop();
    }
  }
  return blocks.flatMap((b) => Array.from({ length: b.n }, () => b.sum / b.n));
}

/**
 * Fair value of each rung, lowest strike first: the middle of its two-sided book, a straight line between its
 * neighbours when it has none, and then the best falling curve through those. Null where there is nothing to go on
 * (a rung with no book at either end of the ladder is not guessed).
 */
export function fairCurve(rungs: Rung[]): Array<number | null> {
  const mids: Array<number | null> = rungs.map((r) => (r.bid !== null && r.ask !== null && r.ask >= r.bid ? (r.bid + r.ask) / 2 : null));
  const filled = mids.map((m, i) => {
    if (m !== null) return m;
    let lo = i - 1;
    while (lo >= 0 && mids[lo] === null) lo--;
    let hi = i + 1;
    while (hi < mids.length && mids[hi] === null) hi++;
    if (lo < 0 || hi >= mids.length) return null;
    const span = rungs[hi]!.strike - rungs[lo]!.strike;
    const t = span > 0 ? (rungs[i]!.strike - rungs[lo]!.strike) / span : 0.5;
    return mids[lo]! + (mids[hi]! - mids[lo]!) * t;
  });
  const known = filled.flatMap((v, i) => (v === null ? [] : [i]));
  const fit = fallingFit(known.map((i) => filled[i]!));
  const out: Array<number | null> = filled.map(() => null);
  known.forEach((i, k) => {
    out[i] = clean(fit[k]!);
  });
  return out;
}

/** The furthest a quote is moved from its plan to cover a step the other participants left in the ladder. */
const MAX_COVER = 0.05;

/**
 * The quotes to rest on one ladder. `rungs` must carry the OTHER participants' best bid and ask (ours removed).
 *
 * The executor refuses every pair on a ladder where a higher strike is bid, or offered, above a lower one. The book a
 * bettor sees is the better of ours and everyone else's on each rung, so the quotes are planned against that:
 *
 *  - a bid is always below the existing ask and an ask above the existing bid: it never takes liquidity;
 *  - bid < ask on every rung, and a side that would not improve on what already rests is left out;
 *  - our quotes are never the cause of a ladder being out of order;
 *  - where the bots' own books are out of order and a move of at most five cents on our side covers it on every rung
 *    involved, we make that move; otherwise that step is left as it is;
 *  - the money tied up stays within `maxDollars`.
 */
export function planQuotes(rungs: Rung[], settings: Partial<SeederSettings> = {}): Quote[] {
  const s = { ...DEFAULTS, ...settings };
  const sorted = [...rungs].sort((a, b) => a.strike - b.strike);
  const n = sorted.length;
  const fair = fairCurve(sorted);
  const bid: Array<number | null> = sorted.map(() => null);
  const ask: Array<number | null> = sorted.map(() => null);

  // 1. Fair value plus and minus the half spread, strictly inside the other side of the market.
  sorted.forEach((r, i) => {
    const f = fair[i] ?? null;
    if (f === null || !r.open || f < s.minFair - EPS || f > s.maxFair + EPS) return;
    // Centre on the nearest cent, so the book is exactly two half spreads wide even when fair sits on a half cent.
    const centre = clean(Math.round(f / PRICE_TICK) * PRICE_TICK);
    bid[i] = floorToStep(centre - s.halfSpread, PRICE_TICK);
    ask[i] = ceilToStep(centre + s.halfSpread, PRICE_TICK);
    if (r.ask !== null) bid[i] = Math.min(bid[i]!, clean(r.ask - PRICE_TICK));
    if (r.bid !== null) ask[i] = Math.max(ask[i]!, clean(r.bid + PRICE_TICK));
  });

  // 2. Rungs at either end whose value cannot be read (a one-sided book with no neighbour beyond it). The lowest strikes
  //    are worth at least what the first readable rung is, so they can be bid at our bid there; the highest are worth
  //    at most what the last readable rung is, so they can be offered at our ask there. Only where the bots show a
  //    price on that side, which would otherwise sit out of order next to ours.
  const firstBid = bid.findIndex((b) => b !== null);
  for (let i = 0; i < firstBid; i++) {
    const r = sorted[i]!;
    if (fair[i] === null && r.open && r.bid !== null && (r.ask === null || bid[firstBid]! < r.ask - EPS)) bid[i] = bid[firstBid]!;
  }
  const lastAsk = ask.reduce<number>((last, a, i) => (a !== null ? i : last), -1);
  for (let i = n - 1; lastAsk >= 0 && i > lastAsk; i--) {
    const r = sorted[i]!;
    if (fair[i] === null && r.open && r.ask !== null && (r.bid === null || ask[lastAsk]! > r.bid + EPS)) ask[i] = ask[lastAsk]!;
  }

  // 3. Steps the bots left in their own books. A bid at a higher strike can only be put in order by bidding at least as
  //    much on every lower strike; an ask at a lower strike by offering no more on every higher one. All or nothing:
  //    covering some rungs and not others would leave the ladder out of order and our own quotes in a muddle.
  const raises: Array<[number, number]> = [];
  let coverable = true;
  let othersBidAbove = -Infinity;
  for (let i = n - 1; i >= 0 && coverable; i--) {
    const r = sorted[i]!;
    const best = Math.max(bid[i] ?? -Infinity, r.bid ?? -Infinity);
    if (best > -Infinity && best < othersBidAbove - EPS) {
      const room = Math.min(r.ask ?? Infinity, ask[i] ?? Infinity);
      if (r.open && bid[i] !== null && othersBidAbove - bid[i]! <= MAX_COVER + EPS && othersBidAbove < room - EPS) raises.push([i, othersBidAbove]);
      else coverable = false;
    }
    othersBidAbove = Math.max(othersBidAbove, r.bid ?? -Infinity);
  }
  if (coverable) for (const [i, price] of raises) bid[i] = price;

  const cuts: Array<[number, number]> = [];
  coverable = true;
  let othersAskBelow = Infinity;
  for (let i = 0; i < n && coverable; i++) {
    const r = sorted[i]!;
    const best = Math.min(ask[i] ?? Infinity, r.ask ?? Infinity);
    if (best < Infinity && best > othersAskBelow + EPS) {
      const room = Math.max(r.bid ?? -Infinity, bid[i] ?? -Infinity);
      if (r.open && ask[i] !== null && ask[i]! - othersAskBelow <= MAX_COVER + EPS && othersAskBelow > room + EPS) cuts.push([i, othersAskBelow]);
      else coverable = false;
    }
    othersAskBelow = Math.min(othersAskBelow, r.ask ?? Infinity);
  }
  if (coverable) for (const [i, price] of cuts) ask[i] = price;

  // 4. Whatever could not be covered, our own quotes must never be what puts a ladder out of order: no bid of ours above
  //    the best bid on any lower strike, no ask of ours below the best ask on any higher strike. This only lowers bids and
  //    raises asks, so it cannot make anything cross. Repeated because dropping a quote changes what its neighbours see.
  for (let pass = 0; pass < 2 * n + 2; pass++) {
    let allowed = Infinity;
    for (let i = 0; i < n; i++) {
      const r = sorted[i]!;
      if (bid[i] !== null) {
        bid[i] = Math.min(bid[i]!, allowed);
        if (bid[i]! < PRICE_TICK - EPS || (r.bid !== null && bid[i]! < r.bid - EPS)) bid[i] = null; // out of range, or no better than what rests
      }
      const best = Math.max(bid[i] ?? -Infinity, r.bid ?? -Infinity);
      if (best > -Infinity) allowed = Math.min(allowed, best);
    }
    let needed = -Infinity;
    for (let i = n - 1; i >= 0; i--) {
      const r = sorted[i]!;
      if (ask[i] !== null) {
        ask[i] = Math.max(ask[i]!, needed);
        if (ask[i]! > 1 - PRICE_TICK + EPS || (r.ask !== null && ask[i]! > r.ask + EPS)) ask[i] = null;
      }
      const best = Math.min(ask[i] ?? Infinity, r.ask ?? Infinity);
      if (best < Infinity) needed = Math.max(needed, best);
    }
    let dropped = false;
    // Where the bots show nothing on a side, a quote of ours is a new price on the ladder, so it also has to fit with
    // the strikes on its other flank: a bid no lower than any bid above it, an ask no higher than any ask below it.
    let bidAbove = -Infinity;
    for (let i = n - 1; i >= 0; i--) {
      const r = sorted[i]!;
      if (bid[i] !== null && r.bid === null && bid[i]! < bidAbove - EPS) {
        bid[i] = null;
        dropped = true;
      }
      bidAbove = Math.max(bidAbove, bid[i] ?? -Infinity, r.bid ?? -Infinity);
    }
    let askBelow = Infinity;
    for (let i = 0; i < n; i++) {
      const r = sorted[i]!;
      if (ask[i] !== null && r.ask === null && ask[i]! > askBelow + EPS) {
        ask[i] = null;
        dropped = true;
      }
      askBelow = Math.min(askBelow, ask[i] ?? Infinity, r.ask ?? Infinity);
    }
    for (let i = 0; i < n; i++) {
      if (bid[i] !== null && ask[i] !== null && bid[i]! >= ask[i]! - EPS) {
        bid[i] = null;
        ask[i] = null;
        dropped = true;
      }
    }
    if (!dropped) break;
  }

  const quotes: Quote[] = sorted.map((r, i) => ({ symbol: r.symbol, strike: r.strike, fair: fair[i] ?? null, bid: bid[i] ?? null, ask: ask[i] ?? null, size: 0 }));

  // 5. Size, within the budget. A bid of 0.41 ties up 41 cents a contract; an ask of 0.45 is a NO bid of 0.55.
  const perContract = (q: Quote) => (q.bid ?? 0) + (q.ask !== null ? 1 - q.ask : 0);
  const live = () => quotes.filter((q) => q.bid !== null || q.ask !== null);
  const cost = (size: number) => live().reduce((sum, q) => sum + perContract(q) * size, 0);
  let size = s.size;
  if (cost(size) > s.maxDollars) size = Math.floor((s.size * s.maxDollars) / cost(s.size));
  if (size < s.minSize) {
    // Too many rungs for the budget: keep the ones bets are made on (nearest an even chance) at the smallest useful size.
    size = s.minSize;
    const byUse = live().sort((a, b) => Math.abs((b.fair ?? 0.5) - 0.5) - Math.abs((a.fair ?? 0.5) - 0.5));
    while (cost(size) > s.maxDollars && byUse.length > 0) {
      const drop = byUse.shift()!;
      drop.bid = null;
      drop.ask = null;
    }
  }
  for (const q of quotes) q.size = q.bid !== null || q.ask !== null ? size : 0;
  return quotes;
}

/** The book a bettor would see with these quotes resting: the better of ours and everyone else's on each side. */
export function seededBook(rungs: Rung[], quotes: Quote[]): Rung[] {
  const by = new Map(quotes.map((q) => [q.symbol, q]));
  return rungs.map((r) => {
    const q = by.get(r.symbol);
    const bid = q?.bid != null ? (r.bid === null ? q.bid : Math.max(r.bid, q.bid)) : r.bid;
    const ask = q?.ask != null ? (r.ask === null ? q.ask : Math.min(r.ask, q.ask)) : r.ask;
    return { ...r, bid, ask };
  });
}

export interface BookReport {
  pairs: number;
  ok: number;
  warn: number;
  refused: number;
  refusedBy: Record<string, number>;
  outOfOrder: number;
  /** Median width of the two-sided open rungs, or null when there are none. */
  medianSpread: number | null;
}

/** What the offer rule, exactly as the executor applies it with no waiver, makes of a ladder's book. */
export function assessBook(rungs: Rung[]): BookReport {
  const sorted = [...rungs].sort((a, b) => a.strike - b.strike);
  const report: BookReport = { pairs: 0, ok: 0, warn: 0, refused: 0, refusedBy: {}, outOfOrder: ladderInversions(sorted).length, medianSpread: null };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const offer = assessPair(sorted, sorted[i]!, sorted[j]!);
      report.pairs++;
      if (offer.verdict === 'ok') report.ok++;
      else if (offer.verdict === 'warn') report.warn++;
      else {
        report.refused++;
        for (const reason of offer.reasons) report.refusedBy[reason.code] = (report.refusedBy[reason.code] ?? 0) + 1;
      }
    }
  }
  const widths = sorted.filter((r) => r.open && r.bid !== null && r.ask !== null).map((r) => clean(r.ask! - r.bid!)).sort((a, b) => a - b);
  if (widths.length > 0) report.medianSpread = widths.length % 2 ? widths[(widths.length - 1) / 2]! : clean((widths[widths.length / 2 - 1]! + widths[widths.length / 2]!) / 2);
  return report;
}

// ------------------------------------------------------------------ running it

/** What the seeder needs from the venue. `src/seed.ts` adapts the Gemini client to this; tests use a stand-in. */
export interface SeederVenue {
  getEvent(ticker: string): Promise<GeminiEvent>;
  /** The top price levels of one contract, in YES prices, with sizes. Includes our own resting orders. */
  depth(symbol: string): Promise<DepthSnapshot>;
  place(req: OrderRequest): Promise<OrderResult>;
  cancel(orderId: string): Promise<void>;
  /** This account's orders that are still resting. */
  openOrders(): Promise<VenueOrder[]>;
  cash(): Promise<number>;
}

interface Resting {
  orderId: string;
  clientOrderId: string;
  /** YES-space price. */
  price: number;
  size: number;
  filled: number;
}

interface Slot {
  bid?: Resting;
  ask?: Resting;
}

export interface SeederOptions {
  settings?: Partial<SeederSettings>;
  /** Distinguishes this run's orders. Every seeder order's tag starts with TAG_PREFIX. */
  runId?: string;
  /** Stop quoting and cancel this long before the ladder closes. */
  stopBeforeExpirySec?: number;
  /** A quote is replaced when its target moves at least this many cents. Smaller moves are left, to avoid churn. */
  repriceTicks?: number;
  /** Orders placed and cancelled in one pass, so a burst cannot run into Gemini's rate limits. */
  maxActionsPerCycle?: number;
  /** Stop placing when the account's cash falls below this. */
  minCash?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** Every order the seeder places is tagged with this, so its orders can always be found and cancelled. */
export const TAG_PREFIX = 'gvs-';

/** The other participants' best bid and ask: the depth with our own resting size taken out. */
export function othersTop(depth: DepthSnapshot, mine: { bid?: { price: number; size: number }; ask?: { price: number; size: number } }): { bid: number | null; ask: number | null } {
  const without = (levels: Array<[number, number]>, own?: { price: number; size: number }) =>
    levels.map(([p, q]): [number, number] => (own && Math.abs(p - own.price) < EPS ? [p, q - own.size] : [p, q])).filter(([, q]) => q > EPS);
  const bids = without(depth.bids, mine.bid);
  const asks = without(depth.asks, mine.ask);
  return {
    bid: bids.length ? Math.max(...bids.map(([p]) => p)) : null,
    ask: asks.length ? Math.min(...asks.map(([p]) => p)) : null,
  };
}

export class Seeder {
  readonly stats = { cycles: 0, placed: 0, cancelled: 0, filled: 0, skippedRungs: 0, errors: 0 };
  private readonly venue: SeederVenue;
  private readonly settings: Partial<SeederSettings>;
  private readonly runId: string;
  private readonly stopBeforeExpiryMs: number;
  private readonly repriceTicks: number;
  private readonly maxActions: number;
  private readonly minCash: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly slots = new Map<string, Slot>();
  private seq = 0;

  constructor(venue: SeederVenue, opts: SeederOptions = {}) {
    this.venue = venue;
    this.settings = opts.settings ?? {};
    this.runId = opts.runId ?? Math.random().toString(36).slice(2, 8);
    this.stopBeforeExpiryMs = (opts.stopBeforeExpirySec ?? 120) * 1000;
    this.repriceTicks = opts.repriceTicks ?? 2;
    this.maxActions = opts.maxActionsPerCycle ?? 16;
    this.minCash = opts.minCash ?? 50;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** What is resting right now, for display and tests. */
  resting(): Array<{ symbol: string; side: 'bid' | 'ask'; price: number; size: number; orderId: string }> {
    const out: Array<{ symbol: string; side: 'bid' | 'ask'; price: number; size: number; orderId: string }> = [];
    for (const [symbol, slot] of this.slots) {
      if (slot.bid) out.push({ symbol, side: 'bid', price: slot.bid.price, size: slot.bid.size - slot.bid.filled, orderId: slot.bid.orderId });
      if (slot.ask) out.push({ symbol, side: 'ask', price: slot.ask.price, size: slot.ask.size - slot.ask.filled, orderId: slot.ask.orderId });
    }
    return out;
  }

  /**
   * One pass over one ladder: learn what filled, read the other participants' book, plan, cancel what is stale and
   * place what is missing. Returns 'stopped' once the ladder is closed or about to close (its quotes are cancelled).
   */
  async cycle(ticker: string): Promise<'quoting' | 'stopped'> {
    this.stats.cycles++;
    const event = await this.venue.getEvent(ticker);
    const rungs = ladder(event);
    const closes = event.expiryDate ? new Date(event.expiryDate).getTime() : null;
    if (event.status !== 'active' || (closes !== null && closes - this.now() <= this.stopBeforeExpiryMs)) {
      await this.cancelSymbols(rungs.map((r) => r.symbol));
      return 'stopped';
    }

    // What became of the orders we think are resting.
    const open = new Map((await this.venue.openOrders()).map((o) => [o.clientOrderId, o]));
    for (const r of rungs) {
      const slot = this.slots.get(r.symbol);
      if (!slot) continue;
      for (const side of ['bid', 'ask'] as const) {
        const mine = slot[side];
        if (!mine) continue;
        const seen = open.get(mine.clientOrderId);
        if (!seen) {
          // No longer resting: it filled (or was cancelled by hand). Either way the slot is free.
          this.stats.filled += mine.size - mine.filled;
          delete slot[side];
        } else if (seen.filledQuantity > mine.filled) {
          this.stats.filled += seen.filledQuantity - mine.filled;
          mine.filled = seen.filledQuantity;
        }
      }
    }

    // The other participants' book on each open rung. A rung whose depth cannot be read keeps what it has this pass.
    const unread = new Set<string>();
    const others: Rung[] = [];
    for (const r of rungs) {
      if (!r.open) {
        others.push(r);
        continue;
      }
      try {
        const slot = this.slots.get(r.symbol) ?? {};
        const top = othersTop(await this.venue.depth(r.symbol), {
          bid: slot.bid && { price: slot.bid.price, size: slot.bid.size - slot.bid.filled },
          ask: slot.ask && { price: slot.ask.price, size: slot.ask.size - slot.ask.filled },
        });
        others.push({ ...r, bid: top.bid, ask: top.ask });
      } catch {
        unread.add(r.symbol);
        this.stats.skippedRungs++;
        others.push({ ...r, bid: null, ask: null });
      }
    }

    const quotes = planQuotes(others, this.settings);
    const book = new Map(others.map((r) => [r.symbol, r]));
    let actions = 0;
    const cancels: Array<{ symbol: string; side: 'bid' | 'ask' }> = [];
    const places: Array<{ q: Quote; side: 'bid' | 'ask'; price: number }> = [];
    for (const q of quotes) {
      if (unread.has(q.symbol)) continue;
      const slot = this.slots.get(q.symbol) ?? {};
      const r = book.get(q.symbol)!;
      for (const side of ['bid', 'ask'] as const) {
        const want = q[side];
        const have = slot[side];
        if (have) {
          const crossed = side === 'bid' ? r.ask !== null && have.price >= r.ask - EPS : r.bid !== null && have.price <= r.bid + EPS;
          const moved = want === null || Math.abs(have.price - want) >= this.repriceTicks * PRICE_TICK - EPS;
          const thin = have.size - have.filled < Math.max(1, have.size / 2);
          if (crossed || moved || thin) cancels.push({ symbol: q.symbol, side });
          else continue;
        }
        if (want !== null && q.size > 0) places.push({ q, side, price: want });
      }
    }

    for (const c of cancels) {
      if (actions >= this.maxActions) break;
      actions++;
      await this.cancelSlot(c.symbol, c.side);
    }
    const cash = places.length > 0 ? await this.venue.cash().catch(() => null) : null;
    if (cash !== null && cash < this.minCash) {
      this.log(`cash is ${cash.toFixed(2)}, below ${this.minCash}: placing nothing more`);
      return 'quoting';
    }
    for (const p of places) {
      if (actions >= this.maxActions) break;
      const slot = this.slots.get(p.q.symbol) ?? {};
      if (slot[p.side]) continue; // its cancel did not happen this pass
      actions++;
      await this.placeSlot(p.q.symbol, p.side, p.price, p.q.size);
    }
    return 'quoting';
  }

  private async placeSlot(symbol: string, side: 'bid' | 'ask', price: number, size: number): Promise<void> {
    const clientOrderId = `${TAG_PREFIX}${this.runId}-${(++this.seq).toString(36)}`;
    try {
      // Our ask in YES prices is a bid for NO at one minus it.
      const res = await this.venue.place({
        symbol,
        side: 'buy',
        outcome: side === 'bid' ? 'yes' : 'no',
        limitPrice: side === 'bid' ? price : clean(1 - price),
        quantity: size,
        tif: 'GTC',
        clientOrderId,
      });
      this.stats.placed++;
      this.stats.filled += res.filledQuantity;
      if (!res.open) return; // it traded at once (the book moved under us): nothing is resting
      const slot = this.slots.get(symbol) ?? {};
      slot[side] = { orderId: res.orderId, clientOrderId, price, size, filled: res.filledQuantity };
      this.slots.set(symbol, slot);
    } catch (err) {
      this.stats.errors++;
      this.log(`could not place ${side} ${price.toFixed(2)} on ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async cancelSlot(symbol: string, side: 'bid' | 'ask'): Promise<void> {
    const slot = this.slots.get(symbol);
    const mine = slot?.[side];
    if (!slot || !mine) return;
    try {
      await this.venue.cancel(mine.orderId);
      this.stats.cancelled++;
      delete slot[side];
    } catch (err) {
      // Left in place: the next pass sees whether it is still resting and tries again.
      this.stats.errors++;
      this.log(`could not cancel ${side} on ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async cancelSymbols(symbols: string[]): Promise<void> {
    for (const symbol of symbols) {
      await this.cancelSlot(symbol, 'bid');
      await this.cancelSlot(symbol, 'ask');
    }
  }

  /**
   * Cancels everything the seeder has resting: what this run placed, then any order on the account carrying the
   * seeder's tag (left by a run that was killed). Returns how many cancels were sent. Safe to call twice.
   */
  async cancelAll(): Promise<number> {
    const before = this.stats.cancelled;
    await this.cancelSymbols([...this.slots.keys()]);
    let swept = 0;
    for (const o of await this.venue.openOrders()) {
      if (!o.clientOrderId.startsWith(TAG_PREFIX) || !o.open) continue;
      try {
        await this.venue.cancel(o.orderId);
        swept++;
      } catch (err) {
        this.stats.errors++;
        this.log(`could not cancel ${o.clientOrderId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.stats.cancelled += swept;
    this.slots.clear();
    return this.stats.cancelled - before;
  }
}
