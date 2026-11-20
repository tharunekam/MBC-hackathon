import { useEffect } from 'react';
import { api } from '../api';
import type { HealthResponse } from '../api/types';
import { useResource } from './hooks';
import { tellStakeCap } from './stake';

/**
 * The one label in the nav, for the few cases where what is behind a bet changes what a person should expect: demo data and a
 * recording place nothing, "quotes only" has bets switched off, seeded prices include orders we placed ourselves, and real money
 * is real. Gemini's sandbox and a local exchange are the ordinary cases and carry no label, so a bet reads the same wherever it
 * is placed.
 */
export interface VenueNote {
  /** The label in the nav. Null in the ordinary case, and until the executor has said what it is. */
  chip: string | null;
  /** What the label means, for its tooltip. */
  hint: string;
  /** Bets are switched off. */
  readOnly: boolean;
  /** What is behind the orders, for the pages that say how a count or a check was made. */
  kind: 'demo' | 'replay' | 'exchange';
}

const ORDINARY: VenueNote = { chip: null, hint: '', readOnly: false, kind: 'exchange' };

/** The label for what the executor says it is. Kept apart from the hook so it can be tested. */
export function describeVenue(mode: string, health: Pick<HealthResponse, 'venue' | 'readOnly' | 'seeded' | 'replay'> | null | undefined): VenueNote {
  if (mode === 'mock') return { chip: null, hint: '', readOnly: false, kind: 'demo' };
  const venue = health?.venue;
  // Not connected yet: say nothing we do not know.
  if (!venue) return ORDINARY;
  // A recorded session played back with nothing behind it (the stage fallback). It says so before anything else.
  if (health?.replay) return { chip: 'Replay', hint: 'A recorded session played back. No order is placed.', readOnly: false, kind: 'replay' };
  if (health?.readOnly) return { chip: 'Quotes only', hint: 'You can look at prices here, but bets are switched off.', readOnly: true, kind: 'exchange' };
  // Production is the one ordinary-looking case that is not ordinary, so it is the one that always says so.
  if (venue === 'Gemini') return { chip: 'Real money', hint: 'Orders here are placed in a live exchange account.', readOnly: false, kind: 'exchange' };
  // Our own second account is resting quotes to make the sandbox's thin, wide market usable. Never shown as if it were not.
  if (venue === 'Gemini sandbox' && health?.seeded) return { chip: 'Seeded prices', hint: 'Some of the prices shown were placed by us, so the market has something to trade against.', readOnly: false, kind: 'exchange' };
  return ORDINARY;
}

export function useVenue(): VenueNote {
  // One shared answer for the shell and the page, asked again every so often: a single failed call at load must not leave a
  // quotes-only copy looking like it takes bets until the page is reloaded.
  const health = useResource('health', () => api.health(), { pollMs: 30_000 });
  // The same answer says the most one bet may stake here, so every stake box knows before it is refused.
  const cap = health.data?.maxStake;
  useEffect(() => tellStakeCap(cap), [cap]);
  return describeVenue(api.mode, health.data);
}

/**
 * `?mock` and `?live` in the address bar decide what the app talks to (api/index.ts reads them once, when the page loads). A
 * link that drops the flag leaves an address that means something else when it is reloaded or shared, so internal links carry
 * it along.
 */
export function modeFlag(search: string): 'live' | 'mock' | null {
  const q = new URLSearchParams(search);
  // The same order as the api: `live` wins when both are present.
  return q.has('live') ? 'live' : q.has('mock') ? 'mock' : null;
}

/** An internal address with the flag added, keeping whatever query and hash it already has. */
export function withFlag(to: string, flag: string | null): string {
  if (!flag) return to;
  const hashAt = to.indexOf('#');
  const hash = hashAt < 0 ? '' : to.slice(hashAt);
  const [path, query = ''] = (hashAt < 0 ? to : to.slice(0, hashAt)).split('?');
  if (new URLSearchParams(query).has(flag)) return to;
  return `${path}?${query ? `${query}&` : ''}${flag}${hash}`;
}

const OPENED_WITH = typeof window === 'undefined' ? null : modeFlag(window.location.search);

/** A link's address, carrying the flag this page was opened with (if any). */
export const keepMode = (to: string): string => withFlag(to, OPENED_WITH);
