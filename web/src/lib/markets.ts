import type { MarketEvent } from '../api/types';
import { hasPrices } from './ladders';

/**
 * How the exchange's flat list of ladders is indexed for people: by what the price is of (Bitcoin, Brent oil, ...), and within
 * that by when it closes. The same grouping feeds the Markets page and the market picker in the builder.
 */

/** "BTC2611200100" becomes "BTC", "NGAS2611302200" becomes "NGAS". */
export const assetKey = (e: Pick<MarketEvent, 'ticker'>): string => e.ticker.replace(/\d.*$/, '') || e.ticker;

/** What the price is of, in the exchange's own words: "Oil (Brent) price on November 20?" becomes "Oil (Brent)". */
export const assetName = (e: Pick<MarketEvent, 'title' | 'ticker'>): string => {
  const m = /^(.*?)\s+price\b/i.exec(e.title);
  return (m?.[1] ?? e.title).trim() || assetKey(e);
};

const WORDS: Record<string, string> = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'XRP', DOGE: 'Dogecoin' };

/** A reader's name for an asset: the common word where there is one, otherwise the exchange's. */
export const assetLabel = (e: Pick<MarketEvent, 'title' | 'ticker'>): string => WORDS[assetKey(e)] ?? assetName(e);

export type Horizon = 'hour' | 'day' | 'month';

const HOUR = 3_600_000;

/** Roughly how far out a ladder closes, so ladders for the same asset read as a sequence rather than a pile. */
export function horizonOf(e: Pick<MarketEvent, 'expiry'>, now = Date.now()): Horizon {
  if (!e.expiry) return 'month';
  const left = new Date(e.expiry).getTime() - now;
  if (left <= 26 * HOUR) return left <= 3 * HOUR ? 'hour' : 'day';
  return 'month';
}

/** "Today 8pm", "Nov 30": when a ladder closes, in the viewer's own time. */
export function closesLabel(expiry: string | null, now = Date.now()): string {
  if (!expiry) return 'No close time';
  const d = new Date(expiry);
  if (Number.isNaN(d.getTime())) return 'No close time';
  const sameDay = d.toDateString() === new Date(now).toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined });
  return sameDay ? `Today ${time}` : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

/**
 * The same close time as the end of a line: "closes today 9:35 PM", "closes Nov 30, 5 PM", or "closed 9:35 PM" once it has
 * passed. Always the viewer's own time, like the picker's tabs. Null when the ladder has no close time.
 */
export function closesPhrase(expiry: string | null, now = Date.now()): string | null {
  if (!expiry) return null;
  const d = new Date(expiry);
  if (Number.isNaN(d.getTime())) return null;
  const sameDay = d.toDateString() === new Date(now).toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined });
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (d.getTime() <= now) return sameDay ? `closed ${time}` : `closed ${day}, ${time}`;
  return sameDay ? `closes today ${time}` : `closes ${day}, ${time}`;
}

/**
 * The line over a ticket: what the market is and when it closes, "Bitcoin · closes today 9:35 PM". The exchange's own title
 * ("BTC price today at 10pm EST") gives the hour in New York time, which on the same card as the picker's local time read as
 * two different closes; the page keeps that title for a tooltip and shows this.
 */
export const marketHeading = (e: Pick<MarketEvent, 'title' | 'ticker' | 'expiry'>, now = Date.now()): string =>
  [assetLabel(e), closesPhrase(e.expiry, now)].filter(Boolean).join(' · ');

export interface AssetGroup {
  key: string;
  name: string;
  label: string;
  category: string;
  /** Soonest close first. */
  events: MarketEvent[];
  /** How many of them have prices to bet against right now. */
  priced: number;
  /** Bets the exchange's prices allow right now, across the group. */
  offers: number;
}

/** Stake Back bets a ladder offers right now, going either way. */
export const parlaysOnOffer = (e: MarketEvent): number => e.offerableCount + (e.down?.offerableCount ?? 0);

const closes = (e: MarketEvent): number => (e.expiry ? new Date(e.expiry).getTime() : Infinity);

/** Groups ladders by asset. Assets with something to bet on come first, then by how many offers, then by name. */
export function groupByAsset(events: MarketEvent[]): AssetGroup[] {
  const byKey = new Map<string, AssetGroup>();
  for (const e of events) {
    if (e.rungs.length < 2) continue;
    const key = assetKey(e);
    let g = byKey.get(key);
    if (!g) {
      g = { key, name: assetName(e), label: assetLabel(e), category: e.category ?? 'Other', events: [], priced: 0, offers: 0 };
      byKey.set(key, g);
    }
    g.events.push(e);
    if (hasPrices(e)) g.priced += 1;
    g.offers += parlaysOnOffer(e);
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.events.sort((a, b) => closes(a) - closes(b) || a.ticker.localeCompare(b.ticker));
  return groups.sort((a, b) => Number(b.offers > 0) - Number(a.offers > 0) || Number(b.priced > 0) - Number(a.priced > 0) || a.label.localeCompare(b.label));
}

/** The span of strikes a ladder covers, for a one-line summary such as "$61,500 to $65,000". */
export function strikeSpan(e: MarketEvent): { low: number; high: number } | null {
  const s = e.rungs.map((r) => r.strike).filter((n) => Number.isFinite(n));
  return s.length ? { low: Math.min(...s), high: Math.max(...s) } : null;
}
