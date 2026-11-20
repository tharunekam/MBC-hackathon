import { api } from '../api';
import type { HealthResponse } from '../api/types';
import { useAsync } from './hooks';

/**
 * What the app is really talking to, so it never implies more than it is: in-browser demo data, a recording, live prices
 * with bets switched off, or a sandbox whose prices include our own quotes. Gemini's sandbox, Gemini itself and a local test
 * exchange are the ordinary cases and carry no label.
 */
export interface VenueNote {
  chip: string | null;
  readOnly: boolean;
}

/** The label for what the executor says it is. Kept apart from the hook so it can be tested. */
export function describeVenue(mode: string, health: Pick<HealthResponse, 'venue' | 'readOnly' | 'seeded' | 'replay'> | null | undefined): VenueNote {
  if (mode === 'mock') return { chip: 'Demo data', readOnly: false };
  const venue = health?.venue;
  if (!venue) return { chip: null, readOnly: false };
  // A recorded session played back with nothing behind it (the stage fallback). It says so before anything else.
  if (health?.replay) return { chip: 'Replay', readOnly: false };
  if (health?.readOnly) return { chip: 'Quotes only', readOnly: true };
  // Our own second account is resting quotes to make the sandbox's thin, wide market usable. Never shown as if it were not.
  if (venue === 'Gemini sandbox' && health?.seeded) return { chip: 'Seeded prices', readOnly: false };
  return { chip: null, readOnly: false };
}

export function useVenue(): VenueNote {
  const health = useAsync(() => api.health(), []);
  return describeVenue(api.mode, health.data);
}
