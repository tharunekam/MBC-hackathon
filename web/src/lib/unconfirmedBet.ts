import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ApiError } from '../api/client';
import type { Bet } from '../api/types';

/**
 * The executor's own 5xx answers that say, before anything is sent, that nothing was bought: its kill switch. Any other 5xx
 * is a failure somewhere along the way and says nothing about the orders.
 */
const NOTHING_SENT: ReadonlySet<string> = new Set(['paused']);

/**
 * Whether a failed attempt to place a bet leaves it unknown if the bet was placed. A refusal (a 4xx) is an answer: nothing was
 * bought. A dropped connection or a server error is not: the exchange may have taken both orders before the answer was lost,
 * and trying again then buys the bet twice. The one exception is an explicit "paused" answer, which is an answer too.
 */
export const mayHaveBeenPlaced = (err: unknown): boolean =>
  err instanceof ApiError && (err.status === 0 || err.status >= 500) && !NOTHING_SENT.has(err.code);

// ------------------------------------------------------------------ one id for each attempt

/** What the executor accepts as a request id: 8 to 64 characters from these. */
export const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * A new id for one attempt to place a bet. `randomUUID` exists only on a secure page (https, or localhost); a page opened by a
 * plain address still has to be able to bet, so the id is then made from random bytes the same way.
 */
export function newRequestId(): string {
  const c = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface Attempts {
  /**
   * The id for the attempt that `key` describes (the bet's market, levels, direction and stake, or a basket's legs). The same
   * key gets the same id, so a retry after a lost answer is recognised by the executor as the same attempt and places nothing
   * twice; a different key is a different bet and gets a new id.
   */
  idFor(key: string): string;
  /** An answer has come (the bet was placed, or refused): the next attempt, even for the same bet, is a new one. */
  spend(): void;
}

/** Tracks the one attempt that is open. `mint` is for tests. */
export function attempts(mint: () => string = newRequestId): Attempts {
  let open: { key: string; id: string } | null = null;
  return {
    idFor(key) {
      if (open?.key !== key) open = { key, id: mint() };
      return open.id;
    },
    spend() {
      open = null;
    },
  };
}

/** One `Attempts` for the life of a page. */
export function useAttempts(): Attempts {
  const ref = useRef<Attempts | null>(null);
  if (ref.current === null) ref.current = attempts();
  return ref.current;
}

/**
 * Whether a bet in the list is the one this attempt placed. A bet that carries the id it was placed under is matched by it;
 * an older record has none, and then `fallback` (the page's own guess from the levels and the time) decides.
 */
export const sameAttempt = (bet: Pick<Bet, 'clientRequestId'>, id: string | null, fallback: boolean): boolean =>
  bet.clientRequestId !== undefined && id !== null ? bet.clientRequestId === id : fallback;

// ------------------------------------------------------------------ while the answer is unknown

/**
 * What is being waited for is a `Bet` (the single-bet pages) or, for a basket, the one result its bets make together: `T` is
 * whichever the page places, and the list it reads is made of the same thing.
 */
export interface Watch<T = Bet> {
  /** What the person has placed, as My bets reads it. */
  read: () => Promise<T[]>;
  /** Whether one of those is the one that was being placed. */
  match: (item: T) => boolean;
  /** It was found, either in the list or in the answer to the one repeat request. */
  found: (item: T) => void;
  /**
   * Sends the same request again, with the same request id. The executor places nothing a second time for an id it has seen,
   * so this is safe whether or not the first attempt got through. Left out, the guard only looks and holds.
   */
  resend?: () => Promise<T>;
  /** The repeat request was refused (an answer, not a lost connection): nothing was bought. */
  refused?: (err: unknown) => void;
  /** The guard is done: found, refused, or out of time. The button is released. */
  release: () => void;
}

/** When the list is read, the repeat request goes out with the first read, and the hold is let go. */
export const LOOK_AT = [3000, 8000] as const;
export const HOLD_MS = 10000;

/**
 * Runs while it is unknown whether a bet was placed: reads the list of bets to see if it is there, and once (with the first
 * read) sends the request again under the same id, so a bet that was placed but never answered comes back as that bet and one
 * that was not placed is placed now, exactly once. After `HOLD_MS` the hold is let go, with the person pointed at My bets in
 * the meantime. Returns what stops it.
 */
export function watchUnconfirmed<T = Bet>(w: Watch<T>): () => void {
  let alive = true;
  let done = false;
  let resent = false;
  const finish = (then: () => void) => {
    if (!alive || done) return;
    done = true;
    w.release();
    then();
  };
  const repeat = () => {
    if (!w.resend || resent || done) return;
    resent = true;
    w.resend().then(
      (item) => finish(() => w.found(item)),
      // A refusal is the executor's answer to the repeat: nothing was bought. A lost connection leaves it as it was, and the
      // second read and the end of the hold carry on.
      (err) => {
        if (!mayHaveBeenPlaced(err)) finish(() => w.refused?.(err));
      },
    );
  };
  const look = (first: boolean) =>
    w.read().then(
      (items) => {
        const hit = alive && !done ? items.find((x) => w.match(x)) : undefined;
        if (hit) finish(() => w.found(hit));
        else if (first) repeat();
      },
      () => {
        // The list could not be read either: the repeat still goes out on the first look, and the hold runs its course.
        if (first) repeat();
      },
    );
  const timers = [setTimeout(() => look(true), LOOK_AT[0]), setTimeout(() => look(false), LOOK_AT[1]), setTimeout(() => finish(() => undefined), HOLD_MS)];
  return () => {
    alive = false;
    timers.forEach((t) => clearTimeout(t));
  };
}

/**
 * The two things a page shows while a placement is unconfirmed. `holding` is the button's hold, which ends by itself after
 * `HOLD_MS`. `unresolved` is the note that sends the person to My bets: it starts with the hold and outlives it, so the advice is
 * still on the page when the button comes back to life, and ends only when the bet is found, the repeat is refused, or the page
 * starts a new attempt (the person pressed Place again).
 */
export interface GuardState {
  holding: boolean;
  unresolved: boolean;
}

export const GUARD_IDLE: GuardState = { holding: false, unresolved: false };

export type GuardEvent =
  /** The page's own switch: on when an answer was lost, off when a new attempt starts. */
  | { type: 'hold'; on: boolean }
  /** The hold ran out, with nothing found and nothing refused: the button is let go, the note stays. */
  | { type: 'released' }
  /** The bet was found, or the repeat was refused: either is an answer, and the note has nothing left to say. */
  | { type: 'resolved' };

export function guardReducer(s: GuardState, e: GuardEvent): GuardState {
  switch (e.type) {
    case 'hold':
      return { holding: e.on, unresolved: e.on };
    case 'released':
      return s.holding ? { ...s, holding: false } : s;
    case 'resolved':
      return s.unresolved || s.holding ? { holding: false, unresolved: false } : s;
  }
}

/**
 * While it is unknown whether a bet was placed, the Place bet button is held (see `watchUnconfirmed`). `retry`, when given,
 * sends the same request once more under the same id and says what to do with a refusal.
 *
 * Returns `[holding, hold, unresolved]` (see `GuardState`). The page disables its button while `holding`, shows the note that
 * points at My bets while `unresolved`, and calls `hold(true)` when an answer is lost and `hold(false)` when it starts a new
 * attempt.
 */
export function useUnconfirmedBet<T = Bet>(
  read: () => Promise<T[]>,
  match: (item: T) => boolean,
  found: (item: T) => void,
  retry?: { send: () => Promise<T>; refused: (err: unknown) => void },
): [holding: boolean, hold: (on: boolean) => void, unresolved: boolean] {
  const [state, dispatch] = useReducer(guardReducer, GUARD_IDLE);
  const latest = useRef({ read, match, found, retry });
  latest.current = { read, match, found, retry };
  const hold = useCallback((on: boolean) => dispatch({ type: 'hold', on }), []);
  useEffect(() => {
    if (!state.holding) return;
    return watchUnconfirmed<T>({
      read: () => latest.current.read(),
      match: (x) => latest.current.match(x),
      found: (x) => {
        dispatch({ type: 'resolved' });
        latest.current.found(x);
      },
      resend: latest.current.retry ? () => latest.current.retry!.send() : undefined,
      refused: (e) => {
        dispatch({ type: 'resolved' });
        latest.current.retry?.refused(e);
      },
      // Out of time is not an answer: the button is let go, and the note stays.
      release: () => dispatch({ type: 'released' }),
    });
  }, [state.holding]);
  return [state.holding, hold, state.unresolved];
}
