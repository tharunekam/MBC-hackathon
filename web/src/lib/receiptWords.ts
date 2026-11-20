import type { Bet } from '../api/types';
import { betSentence, isUnconfirmed, kindOf } from './betKind';
import { money } from './format';

export type OutcomeKind = 'win' | 'back' | 'lose';

export interface ReceiptWords {
  /** The bet in one line. */
  title: string;
  /** What each of the two orders bets on, without the numbers: the page adds the shares and the price. */
  first: string;
  second: string;
  /** A sentence saying why the second order is there. */
  secondWhy: string;
  /** The results the bet can have, with the words for each. The page adds the amounts. */
  outcomes: { kind: OutcomeKind; label: string }[];
}

/**
 * A quantity of shares as a person reads it: always two decimals, so 10.2 reads "10.20 shares". A dash when there is no
 * quantity to show.
 */
export const sharesText = (n: number | null | undefined): string => (typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(2)} shares` : '–');

/**
 * What is true of a Range wherever it finishes, said with the numbers that make it true and not as a promise: one of its two
 * orders pays a dollar a share at every finishing price, so a known part of the cost is covered. `back` is that part in
 * dollars (one for each share of an order) and `cost` is what the bet costs.
 */
export const rangeComesBack = (back: string, cost: string): string => `At least ${back} of your ${cost} comes back when the market closes. Where the price finishes decides the rest.`;

/**
 * The words a placed bet is described in, whichever product it is. Kept apart from the page so each product's wording can be
 * checked on its own: the orders are different (a falling Stake Back buys a NO where a rising one buys a YES), and so are the
 * results (a Range has no stake-back line, and a Breakout has neither that nor an order that pays in every case).
 *
 * One vocabulary, shared with the builders: a Stake Back's two prices are its first level (the one that has to hold) and its
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
        { kind: 'lose', label: 'If it finishes outside the two levels' },
      ],
    };
  }
  if (kind.product === 'breakout') {
    // The first order is the YES on the higher strike and the second the NO on the lower one (see `Bet` in api/types.ts).
    return {
      title,
      first: `that it finishes at or above ${money(t)}`,
      second: `that it finishes below ${money(c)}`,
      secondWhy: 'Only one order can pay: it does if the price finishes outside the two levels.',
      outcomes: [
        { kind: 'win', label: `If it finishes below ${money(c)}, or at ${money(t)} or above` },
        { kind: 'lose', label: 'If it finishes between the two levels' },
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

/**
 * What the executor's answer to "place this bet" turned out to be. It answers 201 for all of these, so the receipt reads the
 * bet's status: only a fully hedged open bet gets the normal receipt, and nothing else may say "Bet placed" or that an order
 * filled.
 *
 *   placed       both orders are in: the normal receipt
 *   unprotected  the first order is in and the second is not (`unhedged`): money is at risk the bet was meant to cover
 *   unwound      the second order could not be placed and the first was sold back (`unwound`): a small loss, no bet
 *   failed       the first order did not fill (`failed`): nothing bought, nothing spent
 *   unconfirmed  anything else (still being placed, or a state a new bet should not have)
 */
export type Landing = 'placed' | 'unprotected' | 'unwound' | 'failed' | 'unconfirmed';

export const landingOf = (bet: Pick<Bet, 'status'> & Partial<Pick<Bet, 'legs' | 'note'>>): Landing =>
  bet.status === 'open'
    ? 'placed'
    : bet.status === 'unhedged'
      ? // An order the exchange never confirmed may have filled: that is not "half placed", and nobody knows which it is.
        isUnconfirmed(bet)
        ? 'unconfirmed'
        : 'unprotected'
      : bet.status === 'unwound'
        ? 'unwound'
        : bet.status === 'failed'
          ? 'failed'
          : 'unconfirmed';

export interface LandingWords {
  /** The small heading over the bet's sentence. */
  eyebrow: string;
  /** What happened, in full sentences, in the order they are read. */
  lines: string[];
  /** The money line, when there is one: "You paid" for a bet that is on, "It cost you" for one that was sold back. */
  paidLabel: string | null;
  /** What a screen reader is told when the receipt appears. */
  spoken: string;
}

/** The words for each way a placement can end. The executor's own note is never shown: it names orders and prices. */
export function landingWords(bet: Pick<Bet, 'status' | 'product' | 'direction'> & Partial<Pick<Bet, 'legs' | 'note'>>): LandingWords {
  switch (landingOf(bet)) {
    case 'placed':
      return { eyebrow: 'Bet placed', lines: [], paidLabel: 'You paid', spoken: 'Bet placed.' };
    case 'failed':
      return {
        eyebrow: 'Not placed',
        lines: ['Nothing was bought and nothing was spent.', 'The first order did not go through.'],
        paidLabel: null,
        spoken: 'Bet not placed. Nothing was bought and nothing was spent.',
      };
    case 'unwound':
      return {
        eyebrow: 'Not placed',
        lines: ['The second order could not be placed, so the first one was sold back.'],
        paidLabel: 'It cost you',
        spoken: 'Bet not placed. The second order could not be placed, so the first was sold back.',
      };
    case 'unprotected':
      return {
        // Said as what is missing, not as a state of protection: the second order is the one that pays the stake back.
        eyebrow: 'Half placed',
        lines: [
          kindOf(bet).product === 'parlay' ? 'Only the first order went through, so your stake does not come back if the first level fails.' : 'Only the first order went through, so only part of this bet is in place.',
          'You can sell the bet back now in My bets, or leave it open.',
        ],
        paidLabel: 'You paid',
        spoken: 'Half placed. Only the first order went through.',
      };
    default:
      return {
        eyebrow: 'Not confirmed',
        lines: isUnconfirmed(bet)
          ? ['Gemini did not confirm one of this bet\'s orders, so it may be partly or fully in place.', 'Check My bets and your Gemini account before you try again.']
          : ['We could not confirm how this bet ended.', 'Check My bets before you try again.'],
        paidLabel: null,
        spoken: 'We could not confirm this bet. Check My bets before you try again.',
      };
  }
}

/**
 * One order's heading on a receipt: only an order that went through in full says so, and one that bought part of its size or none
 * says that. "Went through" is the plain word for an order the exchange took, where "filled" is trade jargon.
 */
export function orderHeading(n: 1 | 2, leg: { quantityFilled: number; quantityRequested: number } | undefined): string {
  if (!leg || !(leg.quantityFilled > 0)) return `Order ${n} did not go through`;
  return leg.quantityFilled + 1e-9 < leg.quantityRequested ? `Order ${n} went through in part` : `Order ${n} went through`;
}
