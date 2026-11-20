import { useEffect } from 'react';
import { api } from '../api';
import type { HealthResponse } from '../api/types';
import { useAsync } from './hooks';
import { tellStakeCap } from './stake';

/**
 * What the app is really talking to, so it never implies more than it is. Every case is labelled: a bet on a stand-in must not
 * read as an order on Gemini, and a sandbox bet must not read as real money.
 */
export interface VenueNote {
  /** The label in the nav. Null only until the executor has said what it is. */
  chip: string | null;
  readOnly: boolean;
  /** Where things here really happen, to finish a sentence such as "This is running on …" or "placed on …". */
  place: string;
  /** The same as a sentence of its own, for the footer and the landing page. Empty until the executor has answered. */
  about: string;
}

const SANDBOX = 'Gemini’s sandbox';

/** The label for what the executor says it is. Kept apart from the hook so it can be tested. */
export function describeVenue(mode: string, health: Pick<HealthResponse, 'venue' | 'readOnly' | 'seeded' | 'replay'> | null | undefined): VenueNote {
  if (mode === 'mock') return { chip: 'Demo data', readOnly: false, place: 'demo data', about: 'This is demo data made in your browser: nothing is sent to Gemini or Solana, and no money moves.' };
  const venue = health?.venue;
  // Not connected yet: say nothing we do not know.
  if (!venue) return { chip: null, readOnly: false, place: 'the exchange', about: '' };
  // A recorded session played back with nothing behind it (the stage fallback). It says so before anything else.
  if (health?.replay) return { chip: 'Replay', readOnly: false, place: 'a recorded session', about: 'This is a recorded session played back: nothing here is live and no order is placed.' };

  const sandbox = venue === 'Gemini sandbox';
  // Anything the executor does not call Gemini is a stand-in for it. The one we ship is the local test exchange.
  const standIn = !sandbox && venue !== 'Gemini';
  const place = sandbox ? SANDBOX : venue === 'Local test exchange' ? 'the local test exchange' : venue;

  if (health?.readOnly) {
    return { chip: 'Quotes only', readOnly: true, place, about: sandbox ? 'Uses Gemini’s API for sandbox prices. Bets are switched off here.' : `Shows prices from ${place}. Bets are switched off here.` };
  }
  if (standIn) {
    const chip = venue === 'Local test exchange' ? 'Test exchange' : venue;
    return { chip, readOnly: false, place, about: `This is running on ${place}, which stands in for Gemini: no order reaches Gemini and no money moves.` };
  }
  if (!sandbox) return { chip: 'Gemini · real money', readOnly: false, place, about: 'Uses Gemini’s API, with real money.' };
  // Our own second account is resting quotes to make the sandbox's thin, wide market usable. Never shown as if it were not.
  if (health?.seeded) return { chip: 'Seeded prices', readOnly: false, place, about: 'Uses Gemini’s API on the sandbox, with practice money. Some of the prices shown are our own quotes.' };
  return { chip: 'Sandbox · practice money', readOnly: false, place, about: 'Uses Gemini’s API on the sandbox, with practice money.' };
}

export function useVenue(): VenueNote {
  const health = useAsync(() => api.health(), []);
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
