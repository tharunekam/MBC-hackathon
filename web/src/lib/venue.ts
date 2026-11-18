import { api } from '../api';
import { useAsync } from './hooks';

/**
 * What the app is really talking to, so it never implies more than it is:
 * in-browser demo data, a local test exchange, or Gemini's sandbox.
 */
export function useVenue(): { chip: string | null; footnote: string; readOnly: boolean } {
  const health = useAsync(() => api.health(), []);
  if (api.mode === 'mock') return { chip: 'Demo data', footnote: 'Demo data. No real orders are placed.', readOnly: false };
  const venue = health.data?.venue;
  if (!venue) return { chip: null, footnote: 'Connecting to the exchange.', readOnly: false };
  if (health.data?.readOnly) return { chip: 'Quotes only', footnote: 'Live prices from Gemini’s sandbox. No account is connected, so bets are switched off.', readOnly: true };
  if (venue === 'Gemini sandbox') return { chip: null, footnote: 'Practice money on Gemini’s sandbox.', readOnly: false };
  if (venue === 'Gemini') return { chip: null, footnote: 'Real orders on Gemini.', readOnly: false };
  return { chip: venue, footnote: `${venue}. Not Gemini, and no real orders.`, readOnly: false };
}
