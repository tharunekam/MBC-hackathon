import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { Bet, PlaceBasketRequest, PlaceBasketResponse, PlaceParlayRequest } from '../api/types';
import { basketsFromBets } from './basket';
import { GUARD_IDLE, HOLD_MS, REQUEST_ID, attempts, guardReducer, mayHaveBeenPlaced, newRequestId, sameAttempt, watchUnconfirmed, type GuardEvent, type GuardState, type Watch } from './unconfirmedBet';

describe('after a failed attempt, is it unknown whether the bet was placed?', () => {
  it('a dropped connection or a server error is: the exchange may have taken both orders before the answer was lost', () => {
    expect(mayHaveBeenPlaced(new ApiError(0, null))).toBe(true);
    expect(mayHaveBeenPlaced(new ApiError(500, null))).toBe(true);
    expect(mayHaveBeenPlaced(new ApiError(504, null))).toBe(true);
  });

  it('a refusal is an answer: nothing was bought, and trying again is safe', () => {
    expect(mayHaveBeenPlaced(new ApiError(400, { error: 'Bets are capped at $25.', code: 'stake_too_large' }))).toBe(false);
    expect(mayHaveBeenPlaced(new ApiError(409, { error: 'x', code: 'market_closed' }))).toBe(false);
    expect(mayHaveBeenPlaced(new ApiError(429, null))).toBe(false);
  });

  it('anything that is not an API answer is not treated as one', () => {
    expect(mayHaveBeenPlaced(new Error('boom'))).toBe(false);
    expect(mayHaveBeenPlaced(null)).toBe(false);
  });

  it('the executor’s explicit "paused" answer is an answer: nothing was sent, so nothing may have been placed', () => {
    expect(mayHaveBeenPlaced(new ApiError(503, { error: 'Betting is paused for a moment. Try again soon.', code: 'paused' }))).toBe(false);
    // Any other 503, and a 5xx that carries a code of the executor’s own, still says nothing about the orders.
    expect(mayHaveBeenPlaced(new ApiError(503, null))).toBe(true);
    expect(mayHaveBeenPlaced(new ApiError(503, { error: 'x', code: 'streams_full' }))).toBe(true);
    expect(mayHaveBeenPlaced(new ApiError(500, { error: 'x', code: 'internal_error' }))).toBe(true);
    expect(mayHaveBeenPlaced(new ApiError(502, { error: 'x', code: 'gemini_error' }))).toBe(true);
  });
});

describe('one id for each attempt', () => {
  it('makes ids the executor accepts: 8 to 64 characters from letters, digits, underscore and hyphen', () => {
    for (let i = 0; i < 50; i++) expect(newRequestId()).toMatch(REQUEST_ID);
    expect(new Set(Array.from({ length: 200 }, newRequestId)).size).toBe(200);
  });

  it('still makes one on a page that has no randomUUID (a plain address is not a secure page), and without any crypto at all', () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a.fill(171) });
    expect(newRequestId()).toMatch(REQUEST_ID);
    expect(newRequestId()).toBe('ab'.repeat(16));
    vi.stubGlobal('crypto', undefined);
    const id = newRequestId();
    expect(id).toMatch(REQUEST_ID);
    expect(newRequestId()).not.toBe(id);
    vi.unstubAllGlobals();
  });

  it('gives a retry of the same bet the same id, and any other bet a new one', () => {
    let n = 0;
    const a = attempts(() => `id-${++n}-xxxxxxxx`);
    const first = a.idFor('BTC|C|T|up|10');
    expect(a.idFor('BTC|C|T|up|10')).toBe(first); // the retry after a lost answer
    expect(a.idFor('BTC|C|T|up|10')).toBe(first);
    const other = a.idFor('BTC|C|T|up|12'); // a different stake is a different bet
    expect(other).not.toBe(first);
    expect(a.idFor('BTC|C|T|up|10')).not.toBe(first); // and the first one is not resumed once the person has moved on
  });

  it('gives a new id once an attempt has been answered, even for exactly the same bet', () => {
    const a = attempts();
    const first = a.idFor('BTC|C|T|up|10');
    a.spend(); // the bet was placed (or refused): that attempt is over
    expect(a.idFor('BTC|C|T|up|10')).not.toBe(first);
  });

  it('matches a bet in the list by the id it was placed under, and by the page’s own guess only when it has none', () => {
    expect(sameAttempt({ clientRequestId: 'mine-12345' }, 'mine-12345', false)).toBe(true);
    // A bet placed under another id is not this one, however well it fits the guess.
    expect(sameAttempt({ clientRequestId: 'other-1234' }, 'mine-12345', true)).toBe(false);
    // An older record has no id: the guess decides.
    expect(sameAttempt({}, 'mine-12345', true)).toBe(true);
    expect(sameAttempt({}, 'mine-12345', false)).toBe(false);
    expect(sameAttempt({ clientRequestId: 'x-12345678' }, null, true)).toBe(true);
  });
});

// ------------------------------------------------------------------ fault injection: the answer is lost

/** The executor's contract for a request id, with the faults a network has: an answer that never arrives, and a list that lags. */
class FakeExecutor {
  bets: Bet[] = [];
  /** How many placements to take and then drop the answer to (the bet is placed; the page hears nothing). */
  lostAnswers = 0;
  /** How many requests never arrive (nothing is placed). */
  lostRequests = 0;
  /** When set, a request is refused with this code. */
  refuseWith: string | null = null;
  /** True while the list of bets does not show what was placed yet. */
  listLags = false;
  placements = 0;

  async placeBet(req: PlaceParlayRequest): Promise<{ bet: Bet; repeated?: boolean }> {
    if (this.lostRequests > 0) {
      this.lostRequests--;
      throw new ApiError(0, null);
    }
    if (this.refuseWith) throw new ApiError(422, { error: 'The live price is 0.493 per $1, above your limit of 0.480.', code: this.refuseWith, refused: true });
    const seen = req.requestId ? this.bets.find((b) => b.clientRequestId === req.requestId) : undefined;
    if (seen) return { bet: seen, repeated: true };
    this.placements++;
    const bet = { id: `bet-${this.placements}`, clientRequestId: req.requestId, status: 'open' } as unknown as Bet;
    this.bets.push(bet);
    if (this.lostAnswers > 0) {
      this.lostAnswers--;
      throw new ApiError(504, null);
    }
    return { bet };
  }

  async listBets(): Promise<Bet[]> {
    if (this.listLags) return [];
    return [...this.bets];
  }
}

const REQ = (id: string): PlaceParlayRequest => ({ user: 'primary', event: 'BTC', condition: 'C', target: 'T', direction: 'up', stake: 10, requestId: id });

describe('a placement whose answer is lost', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Starts the guard the way the pages do, with the same request kept to send again. */
  function guard(exec: FakeExecutor, req: PlaceParlayRequest, over: Partial<Watch> = {}) {
    const log = { found: [] as Bet[], refused: [] as unknown[], released: 0 };
    const stop = watchUnconfirmed({
      read: () => exec.listBets(),
      match: (b) => sameAttempt(b, req.requestId ?? null, false),
      found: (b) => log.found.push(b),
      resend: () => exec.placeBet(req).then((r) => r.bet),
      refused: (e) => log.refused.push(e),
      release: () => log.released++,
      ...over,
    });
    return { log, stop };
  }

  it('finds the bet in the list at the first look, and sends nothing again', async () => {
    const exec = new FakeExecutor();
    exec.lostAnswers = 1;
    const req = REQ('attempt-0001');
    await expect(exec.placeBet(req)).rejects.toMatchObject({ status: 504 });
    const { log } = guard(exec, req);
    await vi.advanceTimersByTimeAsync(3000);
    expect(log.found.map((b) => b.id)).toEqual(['bet-1']);
    expect(log.released).toBe(1);
    expect(exec.placements).toBe(1);
  });

  it('when the list does not show it yet, sends the same request again under the same id: the bet that was placed comes back, and no second one is bought', async () => {
    const exec = new FakeExecutor();
    exec.lostAnswers = 1;
    exec.listLags = true;
    const req = REQ('attempt-0002');
    await expect(exec.placeBet(req)).rejects.toMatchObject({ status: 504 });
    expect(exec.bets).toHaveLength(1); // placed, and the page never heard
    const { log } = guard(exec, req);
    await vi.advanceTimersByTimeAsync(3000);
    expect(log.found.map((b) => b.id)).toEqual(['bet-1']);
    expect(log.released).toBe(1);
    // The whole point: one bet in the account, however many requests it took to find out.
    expect(exec.bets).toHaveLength(1);
    expect(exec.placements).toBe(1);
  });

  it('when the first request never arrived, the repeat places it, once', async () => {
    const exec = new FakeExecutor();
    exec.lostRequests = 1;
    const req = REQ('attempt-0003');
    await expect(exec.placeBet(req)).rejects.toMatchObject({ status: 0 });
    expect(exec.bets).toHaveLength(0);
    const { log } = guard(exec, req);
    await vi.advanceTimersByTimeAsync(3000);
    expect(log.found).toHaveLength(1);
    expect(exec.bets).toHaveLength(1);
    // And nothing more goes out for the rest of the hold.
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(exec.placements).toBe(1);
    expect(log.found).toHaveLength(1);
  });

  it('sends the repeat even when the list cannot be read, because the id makes it safe', async () => {
    const exec = new FakeExecutor();
    exec.lostAnswers = 1;
    const req = REQ('attempt-0004');
    await expect(exec.placeBet(req)).rejects.toMatchObject({ status: 504 });
    const { log } = guard(exec, req, { read: () => Promise.reject(new ApiError(0, null)) });
    await vi.advanceTimersByTimeAsync(3000);
    expect(log.found.map((b) => b.id)).toEqual(['bet-1']);
    expect(exec.bets).toHaveLength(1);
  });

  it('sends the repeat once only: a repeat that is lost too leaves the hold to run its course', async () => {
    const exec = new FakeExecutor();
    exec.lostAnswers = 1;
    exec.listLags = true;
    const req = REQ('attempt-0005');
    await expect(exec.placeBet(req)).rejects.toMatchObject({ status: 504 });
    let sends = 0;
    const { log } = guard(exec, req, {
      resend: () => {
        sends++;
        return Promise.reject(new ApiError(0, null));
      },
    });
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(sends).toBe(1);
    expect(log.found).toHaveLength(0);
    expect(log.refused).toHaveLength(0);
    expect(log.released).toBe(1); // the button is let go, with the person pointed at My bets
    expect(exec.bets).toHaveLength(1);
  });

  it('finds the bet at the second look when the repeat could not be heard either', async () => {
    const exec = new FakeExecutor();
    exec.lostAnswers = 1;
    exec.listLags = true;
    const req = REQ('attempt-0006');
    await expect(exec.placeBet(req)).rejects.toMatchObject({ status: 504 });
    const { log } = guard(exec, req, { resend: () => Promise.reject(new ApiError(504, null)) });
    await vi.advanceTimersByTimeAsync(3000);
    expect(log.found).toHaveLength(0);
    exec.listLags = false; // the list catches up
    await vi.advanceTimersByTimeAsync(5000);
    expect(log.found.map((b) => b.id)).toEqual(['bet-1']);
    expect(log.released).toBe(1);
  });

  it('a refusal of the repeat is an answer: it is handed over, the hold is released, and nothing was bought', async () => {
    const exec = new FakeExecutor();
    exec.lostRequests = 1;
    const req = REQ('attempt-0007');
    await expect(exec.placeBet(req)).rejects.toMatchObject({ status: 0 });
    exec.refuseWith = 'price_above_limit';
    const { log } = guard(exec, req);
    await vi.advanceTimersByTimeAsync(3000);
    expect(log.refused).toHaveLength(1);
    expect((log.refused[0] as ApiError).code).toBe('price_above_limit');
    expect(log.found).toHaveLength(0);
    expect(log.released).toBe(1);
    expect(exec.bets).toHaveLength(0);
  });

  it('without a repeat to send, only looks and holds, as before', async () => {
    const exec = new FakeExecutor();
    exec.lostRequests = 1;
    const req = REQ('attempt-0008');
    await expect(exec.placeBet(req)).rejects.toMatchObject({ status: 0 });
    const { log } = guard(exec, req, { resend: undefined });
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(exec.placements).toBe(0);
    expect(log.found).toHaveLength(0);
    expect(log.released).toBe(1);
  });

  it('does nothing once stopped: the person left the page, or released the hold themselves', async () => {
    const exec = new FakeExecutor();
    exec.lostAnswers = 1;
    exec.listLags = true;
    const req = REQ('attempt-0009');
    await expect(exec.placeBet(req)).rejects.toMatchObject({ status: 504 });
    const { log, stop } = guard(exec, req);
    stop();
    await vi.advanceTimersByTimeAsync(HOLD_MS * 2);
    expect(log.found).toHaveLength(0);
    expect(log.released).toBe(0);
    expect(exec.placements).toBe(1);
  });

  it('a person who presses Place bet again after the hold gets the same bet, not another, because the page reuses the id', async () => {
    const exec = new FakeExecutor();
    exec.lostAnswers = 1;
    const ids = attempts();
    const key = 'BTC|C|T|up|10';
    // First try: placed, answer lost. The page keeps the id because it did not get an answer.
    await expect(exec.placeBet(REQ(ids.idFor(key)))).rejects.toMatchObject({ status: 504 });
    // The hold passes; the person presses the button again on the same bet.
    const second = await exec.placeBet(REQ(ids.idFor(key)));
    expect(second.repeated).toBe(true);
    expect(exec.bets).toHaveLength(1);
    ids.spend();
    // A new bet, afterwards, is a new attempt.
    await exec.placeBet(REQ(ids.idFor(key)));
    expect(exec.bets).toHaveLength(2);
    expect(new Set(exec.bets.map((b) => b.clientRequestId)).size).toBe(2);
  });

  it('without the id (the old behaviour), the same two presses buy the bet twice: the fault this closes', async () => {
    const exec = new FakeExecutor();
    exec.lostAnswers = 1;
    await expect(exec.placeBet({ ...REQ('x'), requestId: undefined })).rejects.toMatchObject({ status: 504 });
    await exec.placeBet({ ...REQ('x'), requestId: undefined });
    expect(exec.bets).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ the note outlives the hold

describe('the note that sends the person to My bets', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** The guard as a page runs it: the reducer holds the two flags, and the watcher feeds it. */
  function page(over: Partial<Watch> = {}) {
    let state: GuardState = GUARD_IDLE;
    const log: GuardEvent[] = [];
    const dispatch = (e: GuardEvent) => {
      log.push(e);
      state = guardReducer(state, e);
    };
    const found: Bet[] = [];
    const start = () => {
      dispatch({ type: 'hold', on: true });
      return watchUnconfirmed({
        read: () => Promise.resolve([]),
        match: () => false,
        found: (b) => {
          dispatch({ type: 'resolved' });
          found.push(b);
        },
        // The server keeps answering 503: the repeat is never answered either.
        resend: () => Promise.reject(new ApiError(503, null)),
        refused: () => dispatch({ type: 'resolved' }),
        release: () => dispatch({ type: 'released' }),
        ...over,
      });
    };
    return { start, dispatch, found, get: () => state };
  }

  it('is still there after the button has been let go: the person is told exactly when they need it', async () => {
    const p = page();
    p.start();
    expect(p.get()).toEqual({ holding: true, unresolved: true });
    await vi.advanceTimersByTimeAsync(HOLD_MS + 1);
    // The fault the review found: at ten seconds the button came back and the note was gone, with nothing said.
    expect(p.get().holding).toBe(false);
    expect(p.get().unresolved).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.get().unresolved).toBe(true);
  });

  it('goes when the person starts a new attempt', async () => {
    const p = page();
    p.start();
    await vi.advanceTimersByTimeAsync(HOLD_MS + 1);
    p.dispatch({ type: 'hold', on: false });
    expect(p.get()).toEqual(GUARD_IDLE);
  });

  it('goes when the bet turns up: it is an answer', async () => {
    const bet = { id: 'bet-1', clientRequestId: 'attempt-1111' } as unknown as Bet;
    const p = page({ read: () => Promise.resolve([bet]), match: (b) => b.clientRequestId === 'attempt-1111' });
    p.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(p.found).toHaveLength(1);
    expect(p.get()).toEqual(GUARD_IDLE);
  });

  it('goes when the repeat request is refused: nothing was bought', async () => {
    const p = page({ resend: () => Promise.reject(new ApiError(422, { error: 'x', code: 'price_above_limit' })) });
    p.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(p.get()).toEqual(GUARD_IDLE);
  });

  it('a hold that ends with nothing to release changes nothing', () => {
    expect(guardReducer(GUARD_IDLE, { type: 'released' })).toBe(GUARD_IDLE);
    expect(guardReducer(GUARD_IDLE, { type: 'resolved' })).toBe(GUARD_IDLE);
  });
});

// ------------------------------------------------------------------ a basket whose answer is lost

/** The executor's contract for a basket: every bet carries the request id, and a repeat of an id returns the basket it placed. */
class FakeBasketExecutor {
  bets: Bet[] = [];
  /** Answers to drop after placing (the basket is placed; the page hears nothing). */
  lostAnswers = 0;
  /** Requests that never arrive. */
  lostRequests = 0;
  /** True while the list does not show the basket yet. */
  listLags = false;
  /** Legs to leave out of the list, as when the third is still being placed. */
  hideLast = 0;
  placements = 0;

  async placeBasket(req: PlaceBasketRequest): Promise<PlaceBasketResponse & { repeated?: boolean }> {
    if (this.lostRequests > 0) {
      this.lostRequests--;
      throw new ApiError(0, null);
    }
    const seen = this.bets.filter((b) => b.clientRequestId === req.requestId);
    if (seen.length > 0) return { basket: { id: seen[0]!.basket!.id, name: null, size: seen.length, failed: null, clientRequestId: req.requestId }, bets: seen, repeated: true };
    this.placements++;
    const id = `bk-${this.placements}`;
    const placed = req.legs.map(
      (_, index) => ({ id: `${id}-${index}`, clientRequestId: req.requestId, status: 'open', basket: { id, index, size: req.legs.length }, legs: [] }) as unknown as Bet,
    );
    this.bets.push(...placed);
    if (this.lostAnswers > 0) {
      this.lostAnswers--;
      throw new ApiError(504, null);
    }
    return { basket: { id, name: null, size: placed.length, failed: null, clientRequestId: req.requestId }, bets: placed };
  }

  async listBets(): Promise<Bet[]> {
    if (this.listLags) return [];
    return this.hideLast > 0 ? this.bets.slice(0, this.bets.length - this.hideLast) : [...this.bets];
  }
}

const BASKET = (id: string): PlaceBasketRequest => ({
  user: 'primary',
  requestId: id,
  legs: [
    { event: 'BTC', condition: 'C', target: 'T', direction: 'up', stake: 10, maxPrice: 0.49 },
    { product: 'range', event: 'ETH', low: 'L', high: 'H', stake: 10, maxPrice: 0.4 },
    { product: 'breakout', event: 'SOL', low: 'L', high: 'H', stake: 10, maxPrice: 0.3 },
  ],
});

describe('a basket placement whose answer is lost', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** The guard the way the Basket page runs it: the list is read as baskets, and the same request is sent again. */
  function guard(exec: FakeBasketExecutor, req: PlaceBasketRequest) {
    const log = { found: [] as PlaceBasketResponse[], refused: [] as unknown[], released: 0 };
    watchUnconfirmed<PlaceBasketResponse>({
      read: () => exec.listBets().then(basketsFromBets),
      match: (r) => r.basket.clientRequestId === req.requestId,
      found: (r) => log.found.push(r),
      resend: () => exec.placeBasket(req),
      refused: (e) => log.refused.push(e),
      release: () => log.released++,
    });
    return log;
  }

  it('finds the basket in the list by the id its bets carry, and sends nothing again', async () => {
    const exec = new FakeBasketExecutor();
    exec.lostAnswers = 1;
    const req = BASKET('basket-0001');
    await expect(exec.placeBasket(req)).rejects.toMatchObject({ status: 504 });
    const log = guard(exec, req);
    await vi.advanceTimersByTimeAsync(3000);
    expect(log.found).toHaveLength(1);
    expect(log.found[0]!.bets.map((b) => b.id)).toEqual(['bk-1-0', 'bk-1-1', 'bk-1-2']);
    expect(log.released).toBe(1);
    expect(exec.placements).toBe(1);
  });

  it('when the list does not show it yet, the repeat under the same id brings the same basket back: one basket in the account', async () => {
    const exec = new FakeBasketExecutor();
    exec.lostAnswers = 1;
    exec.listLags = true;
    const req = BASKET('basket-0002');
    await expect(exec.placeBasket(req)).rejects.toMatchObject({ status: 504 });
    const log = guard(exec, req);
    await vi.advanceTimersByTimeAsync(3000);
    expect(log.found).toHaveLength(1);
    expect(exec.bets).toHaveLength(3);
    expect(exec.placements).toBe(1);
  });

  it('a list that shows only some of the legs is not taken for the basket: the executor’s own answer is', async () => {
    const exec = new FakeBasketExecutor();
    exec.lostAnswers = 1;
    exec.hideLast = 1; // the third bet is still being placed as the list is read
    const req = BASKET('basket-0003');
    await expect(exec.placeBasket(req)).rejects.toMatchObject({ status: 504 });
    const log = guard(exec, req);
    await vi.advanceTimersByTimeAsync(3000);
    expect(log.found).toHaveLength(1);
    expect(log.found[0]!.bets).toHaveLength(3); // all three, not the two the list showed
    expect(log.found[0]!.basket.failed).toBeNull();
    expect(exec.placements).toBe(1);
  });

  it('when the first request never arrived, the repeat places the basket, once', async () => {
    const exec = new FakeBasketExecutor();
    exec.lostRequests = 1;
    const req = BASKET('basket-0004');
    await expect(exec.placeBasket(req)).rejects.toMatchObject({ status: 0 });
    const log = guard(exec, req);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(log.found).toHaveLength(1);
    expect(exec.bets).toHaveLength(3);
    expect(exec.placements).toBe(1);
  });

  it('a basket that was not placed at all and is refused on the repeat is handed over as a refusal: nothing was placed', async () => {
    const exec = new FakeBasketExecutor();
    exec.lostRequests = 1;
    const req = BASKET('basket-0005');
    await expect(exec.placeBasket(req)).rejects.toMatchObject({ status: 0 });
    exec.placeBasket = () => Promise.reject(new ApiError(422, { error: 'Leg 2: the price moved.', code: 'price_above_limit', leg: 1 }));
    const log = guard(exec, req);
    await vi.advanceTimersByTimeAsync(3000);
    expect(log.found).toHaveLength(0);
    expect(log.refused).toHaveLength(1);
    expect(exec.bets).toHaveLength(0);
  });
});
