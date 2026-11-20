/**
 * How a scored call came out, in words. One place, so the leaderboard, the proof page and the proof of a call say it the
 * same way: the result itself is "Won" or "Lost" everywhere (a refunded call is never scored, so there is no third word).
 */
import { kindOfBetId } from './betKind';
import { money } from './format';
import { strikeOf } from './verify';

/** The result of a scored call. */
export const resultWord = (outcome: 0 | 1): 'Won' | 'Lost' => (outcome === 1 ? 'Won' : 'Lost');

/**
 * The line under that word on a proof card, in the proof page's own voice: "Called it" or "Missed", then where the price
 * finished against the call's two levels. It is worked out from what the call committed and its outcome alone.
 *
 * A call is scored 1 when its target contract paid and 0 when its condition held and its target did not. So a rising parlay
 * that hit finished at or above its target, and one that missed finished between its two levels; a falling parlay is the
 * mirror, its condition being the higher level. A range hits between its two levels and a breakout outside them, so the same
 * finish is a hit on one and a miss on the other.
 */
export function calledWords(call: { betId: string; condition: string; target: string; outcome: 0 | 1 }): string {
  const hit = call.outcome === 1;
  const lead = hit ? 'Called it.' : 'Missed.';
  const kind = kindOfBetId(call.betId);
  const c = strikeOf(call.condition);
  const t = strikeOf(call.target);
  // A symbol this page cannot read a level from: say only what is certain.
  if (c === null || t === null) return lead;
  if (kind.product === 'range') return `${lead} It finished ${hit ? `between ${money(c)} and ${money(t)}` : `outside ${money(c)} to ${money(t)}`}.`;
  if (kind.product === 'breakout') return `${lead} It finished ${hit ? `outside ${money(c)} to ${money(t)}` : `between ${money(c)} and ${money(t)}`}.`;
  if (kind.direction === 'down') return hit ? `${lead} It finished below ${money(t)}.` : `${lead} It finished below ${money(c)}, but not below ${money(t)}.`;
  return hit ? `${lead} It finished at or above ${money(t)}.` : `${lead} It finished at or above ${money(c)}, but below ${money(t)}.`;
}
