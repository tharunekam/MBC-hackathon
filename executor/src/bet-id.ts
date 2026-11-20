/**
 * A bet's id says what kind of bet it is.
 *
 * The id is one of the fields committed on Solana when a call is made, and it is revealed with the call. So anything that
 * reads a revealed call (the proof page, the leaderboard) can tell a range from a parlay, and a falling parlay from a rising
 * one, from the id alone, and nobody can relabel a call after seeing how it went: the label is part of what was committed.
 *
 *     rising parlay    "a1b2c3d4"       (no marker: the first kind of bet, and the ids already issued)
 *     falling parlay   "dn-a1b2c3d4"
 *     range            "rg-a1b2c3d4"
 *     breakout         "bo-a1b2c3d4"
 */
import type { Product } from './ledger.ts';
import type { Direction } from './mirror.ts';

const MARKER = { range: 'rg', breakout: 'bo', down: 'dn' } as const;

export function betIdFor(product: Product, direction: Direction | undefined, id: string): string {
  if (product === 'range') return `${MARKER.range}-${id}`;
  if (product === 'breakout') return `${MARKER.breakout}-${id}`;
  return direction === 'down' ? `${MARKER.down}-${id}` : id;
}

/** What an id says about its bet. */
export function kindOfBetId(id: string): { product: Product; direction: Direction } {
  if (id.startsWith(`${MARKER.range}-`)) return { product: 'range', direction: 'up' };
  if (id.startsWith(`${MARKER.breakout}-`)) return { product: 'breakout', direction: 'up' };
  if (id.startsWith(`${MARKER.down}-`)) return { product: 'parlay', direction: 'down' };
  return { product: 'parlay', direction: 'up' };
}
