/**
 * How a scored call came out, in words, and how its numbers are written. One place, so the leaderboard, the proof page and
 * the proof of a call say it the same way: the result itself is "Won" or "Lost" everywhere (a call whose stake came back is
 * never scored, so there is no third word). An edge is written by `format.ts`.
 */
import { kindOfBetId } from './betKind';
import { money } from './format';
import { strikeOf } from './verify';

/** The result of a scored call. */
export const resultWord = (outcome: 0 | 1): 'Won' | 'Lost' => (outcome === 1 ? 'Won' : 'Lost');

/**
 * Where the price finished, as one sentence under the result word on a proof card. It is worked out from what the call
 * sealed and its outcome alone. Empty when a level cannot be read from a symbol: the result word alone is then all that is
 * certain.
 *
 * A call is scored 1 when its target paid and 0 when its first level held and its target did not. So a rising Stake Back
 * that won finished at or above its target, and one that lost finished between its two levels; a falling one is the mirror,
 * its first level being the higher. A Range wins between its two levels and a Breakout outside them, so the same finish is
 * a win on one and a loss on the other.
 */
export function calledWords(call: { betId: string; condition: string; target: string; outcome: 0 | 1 }): string {
  const won = call.outcome === 1;
  const kind = kindOfBetId(call.betId);
  const c = strikeOf(call.condition);
  const t = strikeOf(call.target);
  if (c === null || t === null) return '';
  const lower = money(Math.min(c, t));
  const higher = money(Math.max(c, t));
  const inside = `between ${lower} and ${higher}`;
  const outside = `below ${lower} or above ${higher}`;
  if (kind.product === 'range') return `The price finished ${won ? inside : outside}.`;
  if (kind.product === 'breakout') return `The price finished ${won ? outside : inside}.`;
  if (kind.direction === 'down') return won ? `The price finished below ${money(t)}.` : `The price finished below ${money(c)} but at or above ${money(t)}.`;
  return won ? `The price finished at or above ${money(t)}.` : `The price finished at or above ${money(c)} but below ${money(t)}.`;
}

/**
 * The hidden words after the visible "Proof page" on the link to a call's proof page, so that two calls on the same market never
 * get the same name: " for the Won Range on Ethereum, closes today 8 AM". `market` is the line the list shows
 * ("Ethereum · closes today 8 AM").
 */
export function proofLinkMore(result: string, kind: string, market: string | null): string {
  const on = market ? ` on ${market.replace(' · ', ', ')}` : '';
  return ` for the ${result} ${kind}${on}`;
}

/** The one sentence that says how a check of the books came out, for the status line beside the figures. */
export const booksVerdict = (ok: boolean, against: string): string => (ok ? `The books match ${against}.` : `The books do not match ${against}.`);

/** An edge is written by `format.ts`, the one place it is: re-exported so the words that sit beside it keep one import. */
export { edgeText } from './format';

/** The colour class for an edge, from the same rounded value the text shows: zero is neither a win nor a loss. */
export function edgeTone(e: number): 'good' | 'bad' | '' {
  if (!Number.isFinite(e)) return '';
  const v = Math.round(e * 100) / 100;
  return v > 0 ? 'good' : v < 0 ? 'bad' : '';
}

/** A count with thousands separators; anything that is not a finite number shows as a dash. */
export const countText = (n: number): string => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–');
