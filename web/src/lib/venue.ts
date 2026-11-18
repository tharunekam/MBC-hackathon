import { api } from '../api';
import { useAsync } from './hooks';

/**
 * What the app is really talking to, so it never implies more than it is:
 * in-browser demo data, a local test exchange, or Gemini's sandbox.
 */
export function useVenue(): { chip: string | null; footnote: string } {
  const health = useAsync(() => api.health(), []);
  if (api.mode === 'mock') return { chip: 'Demo data', footnote: 'Demo data. No real orders are placed.' };
  const venue = health.data?.venue;
  if (!venue) return { chip: null, footnote: 'Connecting to the exchange.' };
  if (venue === 'Gemini sandbox') return { chip: null, footnote: 'Practice money on Gemini’s sandbox.' };
  if (venue === 'Gemini') return { chip: null, footnote: 'Real orders on Gemini.' };
  return { chip: venue, footnote: `${venue}. Not Gemini, and no real orders.` };
}
