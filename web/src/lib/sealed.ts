/**
 * How many calls a player has made, beside how many they have revealed.
 *
 * Revealing a call is the player's choice, so a board that showed revealed calls alone could be gamed by keeping the losing
 * ones sealed. Making a call is not hidden, though: each one is committed on Solana under the player's handle before the
 * result, so the number sealed is public. Shown next to the number revealed, a record built by leaving calls out has a gap
 * anyone can see. Calls whose stake came back (the first level failed) can never be revealed, so they are counted apart
 * and are not part of the gap.
 */
export interface SealedCounts {
  /** Calls revealed and scored. */
  calls: number;
  /** Every call sealed on chain under this handle. Absent on a board that does not report it. */
  sealed?: number;
  /** Sealed calls whose stake came back, so they can never be revealed. */
  refunded?: number;
}

/** A count as a person reads it: thousands separated, "1,500" and not "1500". */
const n = (x: number): string => x.toLocaleString('en-US');

/** Calls that could have been revealed and have not been: still open, sold back and waiting on the market, or kept sealed. */
export function unrevealed(r: SealedCounts): number | null {
  if (r.sealed === undefined) return null;
  return Math.max(0, r.sealed - r.calls - (r.refunded ?? 0));
}

/**
 * The line under a player's number of calls: "of 9 sealed", "of 9 sealed, 2 stake back", or "every call revealed". Null when
 * the board does not say how many were sealed.
 */
export function sealedWords(r: SealedCounts): string | null {
  if (r.sealed === undefined) return null;
  const refunded = r.refunded ?? 0;
  if (r.sealed <= r.calls) return 'every call revealed';
  if (r.sealed - refunded <= r.calls) return `of ${n(r.sealed)} sealed, the ${refunded === 1 ? 'other was a stake back' : 'others were stake backs'}`;
  return refunded > 0 ? `of ${n(r.sealed)} sealed, ${n(refunded)} stake back` : `of ${n(r.sealed)} sealed`;
}

/** The same for a screen reader, in full. A list of counts, so it has no full stop. */
export function sealedSpoken(r: SealedCounts): string | null {
  const open = unrevealed(r);
  if (open === null || r.sealed === undefined) return null;
  const refunded = r.refunded ?? 0;
  const parts = [`${n(r.calls)} revealed of ${n(r.sealed)} sealed`];
  if (refunded > 0) parts.push(`${n(refunded)} stake back`);
  if (open > 0) parts.push(`${n(open)} not revealed`);
  return parts.join(', ');
}
