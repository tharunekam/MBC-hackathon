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
 * What is true of a range whichever way it finishes, said as the mechanism that makes it true and not as a promise: the
 * lower strike's YES pays at or above it and the higher strike's NO pays below it, so at every finishing price at least one
 * of the two pays its dollar. `amount` is the dollars that covers (one for each contract of an order); `paid` puts it in the
 * past for a bet that has been placed. It replaced "comes back whatever happens", which read as a guarantee.
 */
export const rangeComesBack = (amount: string, paid = false): string =>
  `At least one of the two orders pays $1 a contract at settlement, so ${amount} of what you ${paid ? 'paid' : 'pay'} comes back either way.`;

/**
 * The words a placed bet is described in, whichever product it is. Kept apart from the page so each product's wording can be
 * checked on its own: the orders are different (a falling parlay buys a NO where a rising one buys a YES), and so are the
 * results (a range has no stake-back line, and a breakout has neither that nor an order that pays either way).
 *
 * One vocabulary, shared with the builders: a parlay's two prices are its first level (the one that has to hold) and its
 * target. A rising bet "holds" the first and "reaches" the target; a falling one "stays under" the first and "falls below"
 * the target.
 */
export function receiptWords(bet: Pick<Bet, 'product' | 'direction' | 'condition' | 'target'>): ReceiptWords {
  const kind = kindOf(bet);
  const c = bet.condition.strike;
  const t = bet.target.strike;
  // A falling parlay's line is written here: the shared one read "Given below $64,000, fall below $63,000", two "below"s for
  // two different things on a page that otherwise says "stays under".
  const title = kind.product === 'parlay' && kind.direction === 'down' ? `Given it stays under ${money(c)}, fall below ${money(t)}` : betSentence(kind, { condition: c, target: t });

  if (kind.product === 'range') {
    return {
      title,
      first: `that it finishes at or above ${money(c)}`,
      second: `that it finishes below ${money(t)}`,
      secondWhy: 'Between the two levels both orders pay; outside them only one does.',
      outcomes: [
        { kind: 'win', label: `If it finishes between ${money(c)} and ${money(t)}` },
        { kind: 'lose', label: 'If it finishes outside the range' },
      ],
    };
  }
  if (kind.product === 'breakout') {
    // The first order is the YES on the higher strike and the second the NO on the lower one (see `Bet` in api/types.ts).
    return {
      title,
      first: `that it finishes at or above ${money(t)}`,
      second: `that it finishes below ${money(c)}`,
      secondWhy: 'Only one of the two orders can pay: one does if it finishes outside the two levels, and neither does if it finishes between them.',
      outcomes: [
        { kind: 'win', label: `If it finishes below ${money(c)}, or at ${money(t)} or above` },
        { kind: 'lose', label: 'If it finishes between them' },
      ],
    };
  }
  if (kind.direction === 'down') {
    return {
      title,
      first: `that it falls below ${money(t)}`,
      second: `that it reaches ${money(c)}`,
      secondWhy: 'This order pays your stake back if the first level fails.',
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
    secondWhy: 'This order pays your stake back if the first level fails.',
    outcomes: [
      { kind: 'win', label: `If it reaches ${money(t)}` },
      { kind: 'back', label: `If it falls below ${money(c)}` },
      { kind: 'lose', label: `If it holds ${money(c)} but stops short` },
    ],
  };
}
