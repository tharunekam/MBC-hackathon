import type { Bet } from '../api/types';
import { betSentence, kindOf } from './betKind';
import { money } from './format';

export type OutcomeKind = 'win' | 'back' | 'lose';

export interface ReceiptWords {
  /** The bet in one line. */
  title: string;
  /** What each of the two orders bought, without the numbers: the page adds the contracts and the price. */
  first: string;
  second: string;
  /** A sentence saying why the second order is there. */
  secondWhy: string;
  /** The results the bet can have, with the words for each. The page adds the amounts. */
  outcomes: { kind: OutcomeKind; label: string }[];
}

/**
 * The words a placed bet is described in, whichever product it is. Kept apart from the page so each product's wording can be
 * checked on its own: the orders are different (a falling parlay buys a NO where a rising one buys a YES), and so are the
 * results (a range has no refund line).
 */
export function receiptWords(bet: Pick<Bet, 'product' | 'direction' | 'condition' | 'target'>): ReceiptWords {
  const kind = kindOf(bet);
  const c = bet.condition.strike;
  const t = bet.target.strike;
  const title = betSentence(kind, { condition: c, target: t });

  if (kind.product === 'range') {
    return {
      title,
      first: `that it finishes at or above ${money(c)}`,
      second: `that it finishes below ${money(t)}`,
      secondWhy: 'One of the two orders always pays a dollar, so the most you can lose is what the pair cost above that.',
      outcomes: [
        { kind: 'win', label: `If it finishes between ${money(c)} and ${money(t)}` },
        { kind: 'lose', label: `If it finishes below ${money(c)} or at ${money(t)} and above` },
      ],
    };
  }
  if (kind.direction === 'down') {
    return {
      title,
      first: `that it falls below ${money(t)}`,
      second: `that it reaches ${money(c)}`,
      secondWhy: 'This is what returns your stake.',
      outcomes: [
        { kind: 'win', label: `If it falls below ${money(t)}` },
        { kind: 'back', label: `If it reaches ${money(c)}` },
        { kind: 'lose', label: `If it stays under ${money(c)} but does not fall below ${money(t)}` },
      ],
    };
  }
  return {
    title,
    first: `that it reaches ${money(t)}`,
    second: `that it falls below ${money(c)}`,
    secondWhy: 'This is what returns your stake.',
    outcomes: [
      { kind: 'win', label: `If it reaches ${money(t)}` },
      { kind: 'back', label: `If it falls below ${money(c)}` },
      { kind: 'lose', label: `If it holds ${money(c)} but stops short` },
    ],
  };
}
