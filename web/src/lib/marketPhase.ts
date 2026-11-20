import { useEffect, useRef, useState } from 'react';
import type { MarketEvent } from '../api/types';
import { timeLeft } from './format';

/**
 * Whether a ladder as a whole can take a bet right now.
 *
 * A ladder that had closed still drew a live-looking builder: the chart could be dragged, the button's refusal told people to
 * "pick the next ladder above" when there was none, and Hunch blamed the spread. The exchange says a ladder is closed in two
 * ways, and either is enough: its close time has passed, or none of its contracts is open any more. The local test exchange
 * runs in rounds, so there the same ladder closes, settles and opens again a few seconds later; the page has to say it is
 * closed for those seconds and pick the next round up by itself.
 */
export type MarketPhase = 'open' | 'closed' | 'not_open';

type Ladder = Pick<MarketEvent, 'expiry' | 'rungs'>;

/** A contract in one of these states has finished for good. Anything else that is not open (Gemini lists new contracts "post_only") may still open. */
const FINISHED = /settled|closed|expired|resolved/;

/** How Gemini lists a new contract before it opens. An order sent to be filled at once, as both of a bet's are, is refused. */
const postOnly = (r: { state: string }): boolean => /post[_-]only/.test(r.state.toLowerCase());

const closeTime = (expiry: string | null): number => (expiry ? new Date(expiry).getTime() : Number.NaN);

export function phaseOf(ladder: Ladder, now = Date.now()): MarketPhase {
  const closes = closeTime(ladder.expiry);
  if (Number.isFinite(closes) && closes <= now) return 'closed';
  if (ladder.rungs.length > 0 && ladder.rungs.every((r) => !r.open)) {
    return ladder.rungs.every((r) => FINISHED.test(r.state.toLowerCase())) ? 'closed' : 'not_open';
  }
  return 'open';
}

export interface MarketNote {
  phase: Exclude<MarketPhase, 'open'>;
  /** What the Place bet button says instead. */
  label: string;
  /** The whole of what is said about it, where nothing else on the screen says the first part (Hunch's empty list). */
  text: string;
  /**
   * What to do about it, without saying again what the button's label already says. A builder shows the label on the button and
   * this under the stake, so a market that has closed is said to have closed once, not on the button, in a note and again in a
   * caption. Left out, `text` is the note.
   */
  next?: string;
}

/** "at 9:35 PM", or "on Nov 19 at 9:35 PM" when that was another day, in the viewer's own time. Empty when the close time is not known or has not passed. */
function closedWhen(expiry: string | null, now: number): string {
  const at = closeTime(expiry);
  if (!Number.isFinite(at) || at > now) return '';
  const d = new Date(at);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined });
  return d.toDateString() === new Date(now).toDateString() ? ` at ${time}` : ` on ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${time}`;
}

/**
 * What to say about a ladder that cannot take a bet, or null for one that can. `another` is whether the picker has another
 * ladder that is open: only then is "pick another market" something a person can do.
 */
export function marketNote(ladder: Ladder, now: number, opts: { another: boolean }): MarketNote | null {
  const phase = phaseOf(ladder, now);
  if (phase === 'open') return null;
  if (phase === 'closed') {
    const when = closedWhen(ladder.expiry, now);
    const next = opts.another ? 'Pick another market above.' : 'The next one appears here by itself when it opens.';
    return { phase, label: 'This market has closed', text: `This market ${when ? `closed${when}` : 'has closed'} and takes no more bets. ${next}`, next };
  }
  // Listed but not trading yet. Gemini lists new contracts post-only for their first minutes; any other state makes no promise.
  if (ladder.rungs.some(postOnly)) {
    const next = 'It usually opens within a few minutes, and this page updates by itself.';
    return { phase, label: 'Not open for bets yet', text: `This market is not open yet. ${next}`, next };
  }
  const next = opts.another ? 'Pick another market above, or check back in a minute.' : 'Check back in a minute.';
  return { phase, label: 'Not open for bets', text: `This market is not open for bets right now. ${next}`, next };
}

/**
 * "Closes in 55 min" for a market that is still counting down, and nothing for one that has closed: by its time, or because every
 * contract on it has finished while its listed close time is still ahead. The page says once that it has closed, and a countdown
 * beside that would say the opposite.
 */
export function closesIn(ladder: Ladder, now: number): string | null {
  return phaseOf(ladder, now) === 'closed' ? null : timeLeft(ladder.expiry, now);
}

/** The same words on every builder, so a person who has read them once knows them again. */
const OPENING =
  'This market has only just opened and some of its levels are not taking orders yet. If a bet’s second order is refused, its first is sold back, usually for less than was paid. Waiting a few minutes avoids this.';

/**
 * A heads-up for a ladder that takes bets but is still opening: some of its contracts are open while at least one is still
 * post-only. A bet is two orders sent one after the other. On a sandbox market listed a quarter of an hour earlier the first
 * order filled, the second contract stopped taking orders in between, and the half-placed bet was sold back for about half
 * its stake. This is a caution and never a refusal: the button stays as it was.
 *
 * Null for a ladder with every contract open, and for one that is closed or not open as a whole, which `marketNote` covers.
 */
export function openingNote(ladder: Ladder, now = Date.now()): string | null {
  if (phaseOf(ladder, now) !== 'open') return null;
  const waiting = ladder.rungs.some(postOnly);
  const trading = ladder.rungs.some((r) => r.open && !postOnly(r));
  return waiting && trading ? OPENING : null;
}

/** How long the opening caution stays up after a post-only level was last seen. */
export const OPENING_HOLD_MS = 60_000;

/**
 * The opening caution held steady: once a market has shown a post-only level beside open ones, the caution stays for
 * `OPENING_HOLD_MS` after the last time it did. A market that is still opening flips between the two states within seconds
 * (that flipping is what cost money on the sandbox), and a caution that came and went with each refresh moved the page under
 * the cursor. `lastSeen` is when, and on which market, the caution last held by itself. Pure, for the hook below and its tests.
 */
export function heldOpeningNote(ladder: (Ladder & { ticker: string }) | undefined, now: number, lastSeen: { ticker: string; at: number } | null): string | null {
  if (!ladder || phaseOf(ladder, now) !== 'open') return null;
  const live = openingNote(ladder, now);
  if (live) return live;
  return lastSeen && lastSeen.ticker === ladder.ticker && now - lastSeen.at < OPENING_HOLD_MS ? OPENING : null;
}

/** `heldOpeningNote` for a page: remembers when the caution last held on its own. */
export function useOpeningNote(ladder: (Ladder & { ticker: string }) | undefined, now: number): string | null {
  const last = useRef<{ ticker: string; at: number } | null>(null);
  if (ladder && openingNote(ladder, now)) last.current = { ticker: ladder.ticker, at: now };
  return heldOpeningNote(ladder, now, last.current);
}

/** Whether any other ladder in the list can take a bet right now. */
export const anotherOpen = (events: MarketEvent[], chosen: Pick<MarketEvent, 'ticker'> | undefined, now: number): boolean =>
  events.some((e) => e.ticker !== chosen?.ticker && phaseOf(e, now) === 'open');

/**
 * The time, re-read at the moment a ladder's close time passes, so a page says "closed" on the second and not at its next
 * tick or poll. A new close time (the next round) arms it again.
 */
export function useNowAtClose(expiry: string | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const wait = closeTime(expiry ?? null) - Date.now();
    if (!Number.isFinite(wait) || wait <= 0) return;
    // A timer cannot be set further ahead than about 24 days; a ladder that far out is re-read long before it matters.
    const id = window.setTimeout(() => setNow(Date.now()), Math.min(wait + 50, 2 ** 31 - 1));
    return () => window.clearTimeout(id);
  }, [expiry]);
  return now;
}

/**
 * While a ladder cannot take a bet, look at the market list again every few seconds, so the page picks up the next round (or
 * the newly opened market) by itself even if the one live update that announces it is missed. Does nothing while the ladder
 * is open: the list then keeps itself current the usual way.
 */
export function useReopenWatch(shut: boolean, reload: () => void, everyMs = 4000): void {
  useEffect(() => {
    if (!shut) return;
    const id = window.setInterval(() => {
      if (!document.hidden) reload();
    }, everyMs);
    return () => window.clearInterval(id);
  }, [shut, reload, everyMs]);
}
