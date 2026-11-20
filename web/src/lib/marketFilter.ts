import type { MarketEvent } from '../api/types';
import { timeLeft } from './format';
import { hasPrices } from './ladders';
import type { AssetGroup } from './markets';

/** What the Markets page's toolbar narrows the list to. `cat` is '' for every category. */
export interface MarketFilter {
  q: string;
  cat: string;
  priced: boolean;
}

/** Categories present in the data, in the order the groups first show them. */
export const categoriesOf = (groups: AssetGroup[]): string[] => [...new Set(groups.map((g) => g.category))];

/** Every word typed must appear somewhere in the asset's name, ticker or the ladder's title. */
function matches(g: AssetGroup, e: MarketEvent, q: string): boolean {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = [g.label, g.name, g.key, e.ticker, e.title].join(' ').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** Applies the filter ladder by ladder, recounts each group, and drops groups with nothing left. Never mutates its input. */
export function filterGroups(groups: AssetGroup[], f: MarketFilter): AssetGroup[] {
  const out: AssetGroup[] = [];
  for (const g of groups) {
    if (f.cat && g.category !== f.cat) continue;
    const events = g.events.filter((e) => (!f.priced || hasPrices(e)) && matches(g, e, f.q));
    if (events.length === 0) continue;
    out.push({ ...g, events, priced: events.filter(hasPrices).length, offers: events.reduce((n, e) => n + e.offerableCount, 0) });
  }
  return out;
}

const DAY = 86_400_000;

/**
 * How long until a ladder closes, for a muted line under its close time: "in 2 h 5 min", "in 11 d", "Closed".
 * Built on `timeLeft`, which counts in hours and would say "in 264 h" for a ladder that closes at month end.
 */
export function closesIn(expiry: string | null, now = Date.now()): string | null {
  if (!expiry) return null;
  const at = new Date(expiry).getTime();
  if (Number.isNaN(at)) return null;
  if (at - now >= 2 * DAY) return `in ${Math.floor((at - now) / DAY)} d`;
  const t = timeLeft(expiry, now);
  return t ? t.replace(/^Closes /, '') : null;
}

/** "Updated 12s ago" from the exchange response's `asOf`. Null when the time cannot be read. */
export function updatedLabel(asOf: string | undefined, now = Date.now()): string | null {
  if (!asOf) return null;
  const at = new Date(asOf).getTime();
  if (Number.isNaN(at)) return null;
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 5) return 'Updated just now';
  if (s < 60) return `Updated ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Updated ${m} min ago`;
  return `Updated ${Math.floor(m / 60)} h ago`;
}
