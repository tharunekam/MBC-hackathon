import type { Bet, Direction, Product } from '../api/types';
import { money } from './format';

/** The start of the executor's note for a bet with an order it could not confirm. */
const UNCONFIRMED_NOTE = /did not confirm/i;

/**
 * A bet with an order that has no confirmed result: a leg of status `unknown`, or the executor's note that says so (a record
 * the legs of which were read back by hand carries only the note). A bet that was looked up and settled carries neither.
 */
export const isUnconfirmed = (b: Partial<Pick<Bet, 'legs' | 'note'>>): boolean =>
  (Array.isArray(b.legs) && b.legs.some((l) => l?.status === 'unknown')) || (typeof b.note === 'string' && UNCONFIRMED_NOTE.test(b.note));

/** What kind of bet something is: a product, and for a parlay which way it looks. */
export interface BetKind {
  product: Product;
  direction: Direction;
}

/**
 * What a bet id says about its bet (mirrors `executor/src/bet-id.ts`). The id is committed on Solana with the call and revealed
 * with it, so a revealed call carries its kind and nobody can relabel it after the result.
 */
export function kindOfBetId(id: string): BetKind {
  if (id.startsWith('rg-')) return { product: 'range', direction: 'up' };
  if (id.startsWith('bo-')) return { product: 'breakout', direction: 'up' };
  if (id.startsWith('dn-')) return { product: 'parlay', direction: 'down' };
  return { product: 'parlay', direction: 'up' };
}

/** A bet's kind. Bets recorded before ranges existed have neither field: they are rising parlays. */
export const kindOf = (bet: Pick<Bet, 'product' | 'direction'>): BetKind => ({ product: bet.product ?? 'parlay', direction: bet.direction ?? 'up' });

/** The product's name as it appears in the header. A falling parlay is the same product going the other way. */
export const productName = (kind: BetKind): string => (kind.product === 'range' ? 'Range' : kind.product === 'breakout' ? 'Breakout' : 'Stake Back');

/** The bet in one line, from the two strikes it was built on. For a range or a breakout these are its lower and higher strike. */
export function betSentence(kind: BetKind, strikes: { condition: number; target: number }): string {
  if (kind.product === 'range') return `Finish between ${money(strikes.condition)} and ${money(strikes.target)}`;
  if (kind.product === 'breakout') return `Finish outside ${money(strikes.condition)} to ${money(strikes.target)}`;
  if (kind.direction === 'down') return `Given it stays under ${money(strikes.condition)}, fall below ${money(strikes.target)}`;
  return `Given ${money(strikes.condition)} or above, reach ${money(strikes.target)}`;
}

export const betTitle = (bet: Pick<Bet, 'product' | 'direction' | 'condition' | 'target'>): string =>
  betSentence(kindOf(bet), { condition: bet.condition.strike, target: bet.target.strike });

/** How a settled bet came out, in the bet's own words. */
export type BetResult = 'won' | 'lost' | 'refunded';

export function resultOf(bet: Pick<Bet, 'settlement'>): BetResult | null {
  const s = bet.settlement;
  if (!s) return null;
  if (s.conditionResolved === 'no') return 'refunded';
  return s.targetResolved === 'yes' ? 'won' : 'lost';
}

/**
 * The words for a result, the same for every product: Won, Lost, or Stake back. Where the price ended (inside or outside the
 * two levels of a range or a breakout) goes on the line under it, not in the word itself, because whether "inside" is a win
 * depends on the bet and the same words in green and red read as a contradiction.
 */
export function resultWords(result: BetResult): string {
  return result === 'refunded' ? 'Stake back' : result === 'won' ? 'Won' : 'Lost';
}
