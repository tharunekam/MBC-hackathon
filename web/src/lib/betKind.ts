import type { Bet, Direction, Product } from '../api/types';
import { money } from './format';

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
export const productName = (kind: BetKind): string => (kind.product === 'range' ? 'Range' : kind.product === 'breakout' ? 'Breakout' : 'Return Parlay');

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

/** The words for a result: a range or a breakout is never refunded, and finishes inside or outside. Which of the two is the win depends on the bet. */
export function resultWords(kind: BetKind, result: BetResult): string {
  if (result === 'refunded') return 'Stake back';
  if (kind.product === 'range') return result === 'won' ? 'Finished inside' : 'Finished outside';
  if (kind.product === 'breakout') return result === 'won' ? 'Finished outside' : 'Finished inside';
  return result === 'won' ? 'Won' : 'Lost';
}
