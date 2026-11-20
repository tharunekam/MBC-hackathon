/**
 * How many calls a player has made, beside how many they have revealed.
 *
 * Revealing a call is the player's choice, so a board that showed revealed calls alone could be gamed by keeping the losing
 * ones sealed. Making a call is not hidden, though: each one is committed on Solana under the player's handle before the
 * result, so the number sealed is public. Shown next to the number revealed, a record built by leaving calls out has a gap
 * anyone can see. Refunded calls (the first half failed) can never be revealed, so they are counted apart and are not part
 * of the gap.
 */
export interface SealedCounts {
  /** Calls revealed and scored. */
  calls: number;
  /** Every call sealed on chain under this handle. Absent on a board that does not report it. */
  sealed?: number;
  /** Sealed calls that were refunded and so can never be revealed. */
  refunded?: number;
}

/** Calls that could have been revealed and have not been: still open, sold back and waiting on the market, or kept sealed. */
export function unrevealed(r: SealedCounts): number | null {
  if (r.sealed === undefined) return null;
  return Math.max(0, r.sealed - r.calls - (r.refunded ?? 0));
}

/**
 * The line under a player's number of calls: "of 9 sealed", "of 9 sealed, 2 refunded", or "every call revealed". Null when
 * the board does not say how many were sealed.
 */
export function sealedWords(r: SealedCounts): string | null {
  if (r.sealed === undefined) return null;
  const refunded = r.refunded ?? 0;
  if (r.sealed <= r.calls) return 'every call revealed';
  if (r.sealed - refunded <= r.calls) return `of ${r.sealed} sealed, the other${refunded === 1 ? '' : 's'} refunded`;
  return refunded > 0 ? `of ${r.sealed} sealed, ${refunded} refunded` : `of ${r.sealed} sealed`;
}

/** The same for a screen reader, as a whole sentence. */
export function sealedSpoken(r: SealedCounts): string | null {
  const open = unrevealed(r);
  if (open === null || r.sealed === undefined) return null;
  const refunded = r.refunded ?? 0;
  const parts = [`${r.calls} revealed of ${r.sealed} sealed`];
  if (refunded > 0) parts.push(`${refunded} refunded`);
  if (open > 0) parts.push(`${open} not revealed`);
  return `${parts.join(', ')}.`;
}
