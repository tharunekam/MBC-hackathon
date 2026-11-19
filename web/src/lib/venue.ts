import { api } from '../api';
import type { HealthResponse } from '../api/types';
import { useAsync } from './hooks';

/**
 * What the app is really talking to, so it never implies more than it is:
 * in-browser demo data, a local test exchange, or Gemini's sandbox.
 */
export interface VenueNote {
  chip: string | null;
  footnote: string;
  readOnly: boolean;
}

/** The label and the footnote for what the executor says it is. Kept apart from the hook so it can be tested. */
export function describeVenue(mode: string, health: Pick<HealthResponse, 'venue' | 'readOnly' | 'seeded' | 'replay'> | null | undefined): VenueNote {
  if (mode === 'mock') return { chip: 'Demo data', footnote: 'Demo data. No real orders are placed.', readOnly: false };
  const venue = health?.venue;
  if (!venue) return { chip: null, footnote: 'Connecting to the exchange.', readOnly: false };
  // A recorded session played back with nothing behind it (the stage fallback). It says so before anything else.
  if (health?.replay) {
    const when = new Date(health.replay.recordedAt);
    const day = Number.isNaN(when.getTime()) ? 'earlier' : `on ${when.toLocaleDateString('en-US', { dateStyle: 'medium' })}`;
    const where = venue === 'Gemini sandbox' ? 'Gemini’s sandbox' : `${venue} (not Gemini)`;
    return { chip: 'Replay', footnote: `A recording of a real session on ${where}, made ${day}. Nothing here is live, and no order is placed now.`, readOnly: false };
  }
  if (health?.readOnly) return { chip: 'Quotes only', footnote: 'Live prices from Gemini’s sandbox. No account is connected, so bets are switched off.', readOnly: true };
  if (venue === 'Gemini sandbox') {
    // Our own second account is resting quotes to make the sandbox's thin, wide market usable. Never shown as if it were not.
    if (health?.seeded) return { chip: 'Seeded prices', footnote: 'Practice money on Gemini’s sandbox. Some of the prices here are our own test quotes, placed to tighten the sandbox’s thin market.', readOnly: false };
    return { chip: null, footnote: 'Practice money on Gemini’s sandbox.', readOnly: false };
  }
  if (venue === 'Gemini') return { chip: null, footnote: 'Real orders on Gemini.', readOnly: false };
  return { chip: venue, footnote: `${venue}. Not Gemini, and no real orders.`, readOnly: false };
}

export function useVenue(): VenueNote {
  const health = useAsync(() => api.health(), []);
  return describeVenue(api.mode, health.data);
}
