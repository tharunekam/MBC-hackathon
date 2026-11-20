import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client';

/**
 * The stake box, read one way by every builder.
 *
 * Two things went wrong when each page read it for itself. An empty box, or "0", kept the last good amount behind the scenes,
 * so the button still offered "Place bet · $10.00" under a box that said nothing. And a stake above the demo's cap was
 * refused by the executor in plain words ("Bets are capped at $100 on this demo") that the page showed as "Prices
 * unavailable. Check your connection", beside a hint that said more than the cap would fit.
 */

/** No single bet is this large on any venue; a longer number is a slip of the finger. */
const MOST = 100_000;

/** What may be typed in a stake box: digits and one dot, to the cent. */
export function cleanStakeText(raw: string): string {
  const s = raw.replace(/[^\d.]/g, '');
  const dot = s.indexOf('.');
  if (dot < 0) return s;
  return s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '').slice(0, 2);
}

/** The dollars a stake box holds. Zero means no stake has been entered: an empty box, a lone dot, or "0". */
export function stakeFrom(text: string): number {
  const n = Number(text);
  return text.trim() !== '' && Number.isFinite(n) && n > 0 ? Math.min(n, MOST) : 0;
}

/**
 * The most one bet may stake here, read from the executor's refusal of a larger one (HTTP 400, code `stake_too_large`,
 * "Bets are capped at $100 on this demo."). Null for any other error, and when the sentence carries no amount.
 */
export function capFrom(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.code !== 'stake_too_large') return null;
  const m = /\$\s*([\d,]+(?:\.\d+)?)/.exec(err.message);
  const n = m ? Number(m[1]!.replace(/,/g, '')) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The executor's own sentence when it refused the stake as too large, for a cap that could not be read out of it. */
export const stakeRefusal = (err: unknown): string | null => (err instanceof ApiError && err.code === 'stake_too_large' ? err.message : null);

/** The cap is the venue's, not a page's: once one page has been told it, every page knows it. */
let knownCap: number | null = null;
const watchers = new Set<(cap: number | null) => void>();

/**
 * Records the cap, from wherever it was learned: the executor's /health says it outright, and a refusal says it too. Every
 * page showing a stake box is told. A value that is not a positive amount is ignored.
 */
export function tellStakeCap(cap: number | null | undefined): void {
  if (typeof cap !== 'number' || !Number.isFinite(cap) || !(cap > 0) || cap === knownCap) return;
  knownCap = cap;
  for (const tell of watchers) tell(cap);
}

/** For tests: forget the cap. */
export function forgetStakeCap(): void {
  knownCap = null;
}

/**
 * The cap on a single bet, and a way to learn it. The executor only states the cap by refusing a stake above it, so it is
 * null until that has happened once; a page hands every failed quote or bet to `learn`, and from then on stops asking for
 * more than the cap and says what it is.
 */
export function useStakeCap(): [cap: number | null, learn: (err: unknown) => void] {
  const [cap, setCap] = useState(knownCap);
  useEffect(() => {
    setCap(knownCap); // it may have been told between the first render and this
    watchers.add(setCap);
    return () => void watchers.delete(setCap);
  }, []);
  const learn = useCallback((err: unknown) => tellStakeCap(capFrom(err)), []);
  return [cap, learn];
}
