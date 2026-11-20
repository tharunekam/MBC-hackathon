/**
 * What the Place bet button says, whether it is live, and what is shown above it, as one pure decision.
 *
 * It exists because the first real runs showed the old inline logic failing in specific ways: every refusal said "pick a
 * closer target" even when moving the target could not help (a market that is not open yet) or needed the opposite
 * (a payout too small for its price); an enabled button read "Place bet · $0.00" when the book had nothing to fill; the
 * button could be live on the strength of an estimate that the executor was about to overrule; and a failed attempt
 * could leave nothing on screen. Rules:
 *
 *  - The button is live only for an answer from the executor that matches this pair AND this stake.
 *  - Every refusal names its own cause and the way out.
 *  - A bet the market cannot fill at the minimum size is not offered; the button never shows a zero price.
 *  - A failed attempt always leaves a message, whatever the quote says.
 */
import type { Direction, QuoteResponse, RangeQuoteResponse, RefusalCode, Rung } from '../api/types';
import { usd } from './format';
import type { Estimate, RangeEstimate } from './pricing';

export const MIN_BET = 1;

export type Phase = 'idle' | 'placing' | 'placed';

export interface Notice {
  tone: 'warn' | 'bad' | 'info';
  text: string;
}

export interface ButtonState {
  canPlace: boolean;
  label: string;
  /** A short reason shown with the button when it is not live, so a disabled button always says why. */
  notice: Notice | null;
  /** Why the button is not live, for tests and for the page to decide whether to show a spinner. */
  blockedBy: 'placing' | 'readonly' | 'loading' | 'checking' | 'unreachable' | 'stake' | 'thin' | RefusalCode | null;
}

export interface BetInputs {
  phase: Phase;
  readOnly: boolean;
  stake: number;
  /** Which way the parlay looks. Only the words differ: a falling parlay asks for a lower target, not a higher one. */
  direction?: Direction;
  condition: Rung | undefined;
  target: Rung | undefined;
  /** The executor's answer for this pair and the stake that is typed right now, or null while there is none. */
  answer: QuoteResponse | null;
  /** The quote request failed and no answer exists. */
  answerError: boolean;
  /** The instant local estimate, used only to refuse early while the executor's answer is on its way. */
  est: Estimate | null;
}

/** Plain words for each refusal: the label on the button and what to do about it. */
const COPY: Record<RefusalCode, { label: string; text: string }> = {
  market_closed: {
    label: 'Not open for bets yet',
    text: 'One of these prices is not open for trading right now. New markets can take a few minutes to open. Pick other prices, or check back shortly.',
  },
  ladder_out_of_order: {
    label: 'Prices out of step',
    text: 'The prices on this market are out of order for the moment. Check back in a minute, or pick another market.',
  },
  one_sided_book: {
    label: 'No market on this pair',
    text: 'Nobody is buying or selling one of these right now. Pick other prices.',
  },
  no_price: {
    label: 'Pick a higher target',
    text: 'The payout would be too small for the price. Move the target further above the condition.',
  },
  price_too_high: {
    label: 'Pick a higher target',
    text: 'The payout would be too small for the price. Move the target further above the condition.',
  },
  markup_too_high: {
    label: 'Pick another pair',
    text: 'The buy and sell prices on this pair are too far apart for a fair deal. Try other prices, usually ones with tighter spreads.',
  },
};

/** When several things are wrong at once, the one to say first: what you cannot fix by moving comes before what you can. */
const PRIORITY: RefusalCode[] = ['market_closed', 'ladder_out_of_order', 'one_sided_book', 'no_price', 'price_too_high', 'markup_too_high'];

/** The words for a refusal. A payout that is too small asks for a target further from the condition, which is lower for a falling bet. */
export function refusalCopy(code: RefusalCode, direction: Direction = 'up'): { label: string; text: string } {
  if (direction === 'down' && (code === 'no_price' || code === 'price_too_high')) {
    return { label: 'Pick a lower target', text: 'The payout would be too small for the price. Move the target further below the condition.' };
  }
  return COPY[code];
}

/**
 * "Not open" means different things, and what to do differs: a newly listed market opens in a few minutes (Gemini lists
 * them post-only first), but one that has closed or settled will not open again.
 */
export function closedCopy(condition: Rung | undefined, target: Rung | undefined): { label: string; text: string } {
  const states = [condition, target].filter((r): r is Rung => !!r && !r.open).map((r) => r.state.toLowerCase());
  if (states.some((s) => /settled|closed|expired|resolved/.test(s))) {
    return { label: 'This market has closed', text: 'This market has closed and will not reopen. Pick the next ladder above.' };
  }
  if (states.some((s) => /post_only|post-only/.test(s))) return COPY.market_closed;
  return {
    label: 'Not open for bets',
    text: 'One of these prices is not open for trading right now. Pick other prices, or check back in a minute.',
  };
}

export function firstReason(codes: RefusalCode[]): RefusalCode | null {
  for (const c of PRIORITY) if (codes.includes(c)) return c;
  return codes[0] ?? null;
}

/** The refusal the local numbers already show, before the executor has answered. */
export function localRefusal(condition: Rung | undefined, target: Rung | undefined, est: Estimate | null): RefusalCode | null {
  if (!condition || !target) return null;
  if (!condition.open || !target.open) return 'market_closed';
  if (condition.bid === null || condition.ask === null || target.bid === null || target.ask === null) return 'one_sided_book';
  if (!est) return 'no_price';
  return est.code;
}

const blocked = (code: NonNullable<ButtonState['blockedBy']>, label: string, text: string | null, tone: Notice['tone'] = 'bad'): ButtonState => ({
  canPlace: false,
  label,
  notice: text ? { tone, text } : null,
  blockedBy: code,
});

export function buttonState(i: BetInputs): ButtonState {
  if (i.phase === 'placing') return { canPlace: false, label: 'Placing both orders', notice: null, blockedBy: 'placing' };
  if (i.readOnly) return blocked('readonly', 'Bets are switched off', null);
  if (!i.condition || !i.target) return blocked('loading', 'Loading prices', null);
  if (!(i.stake >= MIN_BET)) return blocked('stake', `Stake at least ${usd(MIN_BET, 0)}`, `The smallest bet is ${usd(MIN_BET, 0)}.`, 'info');

  const a = i.answer;
  if (a) {
    if (!a.quote.offerable) {
      const code = firstReason(a.quote.reasons.map((r) => r.code));
      if (code === 'market_closed') {
        const c = closedCopy(i.condition, i.target);
        return blocked(code, c.label, c.text);
      }
      if (code) return blocked(code, refusalCopy(code, i.direction).label, refusalCopy(code, i.direction).text);
      return blocked('markup_too_high', 'Not on offer', a.quote.reasons[0]?.message ?? 'This pair is not on offer right now.');
    }
    const plan = a.stake;
    if (plan && (!(plan.cost >= MIN_BET) || !(plan.outcomeContracts > 0))) {
      const fits = plan.cost > 0 ? ` The market can fill about ${usd(plan.cost)} at this price, below the ${usd(MIN_BET, 0)} minimum.` : '';
      return blocked('thin', 'Not enough on the market', `There is not enough resting on the market to fill a bet at these prices right now.${fits} Try other prices, or check again in a moment.`);
    }
    if (!plan) return blocked('checking', 'Checking the price', null);
    return { canPlace: true, label: `Place bet · ${usd(plan.cost)}`, notice: null, blockedBy: null };
  }

  // No answer for this pair and stake yet. Refuse early only on what the local numbers already settle.
  const early = localRefusal(i.condition, i.target, i.est);
  if (early === 'market_closed') {
    const c = closedCopy(i.condition, i.target);
    return blocked(early, c.label, c.text);
  }
  if (early) return blocked(early, refusalCopy(early, i.direction).label, refusalCopy(early, i.direction).text);
  if (i.answerError) return blocked('unreachable', 'Prices unavailable', 'We could not get a price for this pair. Check your connection and try again.');
  return blocked('checking', 'Checking the price', null);
}

// ------------------------------------------------------------------ range

export interface RangeInputs {
  phase: Phase;
  readOnly: boolean;
  stake: number;
  /** The floor and the ceiling. */
  low: Rung | undefined;
  high: Rung | undefined;
  /** The executor's answer for this range and the stake that is typed right now, or null while there is none. */
  answer: RangeQuoteResponse | null;
  answerError: boolean;
  /** The instant local estimate, used only to refuse early while the executor's answer is on its way. */
  est: RangeEstimate | null;
}

/** What a refusal means for a range, in plain words. The causes that cannot be fixed by moving the levels come first. */
const RANGE_COPY: Record<RefusalCode, { label: string; text: string }> = {
  ...COPY,
  no_price: {
    label: 'Pick levels further apart',
    text: 'There is no sensible price for this range. Move the floor and the ceiling further apart.',
  },
  price_too_high: {
    label: 'Pick levels further apart',
    text: 'The range would cost too much for what it can win. Move the floor and the ceiling further apart.',
  },
  markup_too_high: {
    label: 'Pick other levels',
    text: 'The buy and sell prices at these two levels are too far apart for a fair deal. Try other levels, usually ones with tighter spreads.',
  },
};

export const rangeRefusalCopy = (code: RefusalCode) => RANGE_COPY[code];

/** The refusal the local numbers already show, before the executor has answered. */
function localRangeRefusal(low: Rung | undefined, high: Rung | undefined, est: RangeEstimate | null): RefusalCode | null {
  if (!low || !high) return null;
  if (!low.open || !high.open) return 'market_closed';
  if (low.bid === null || low.ask === null || high.bid === null || high.ask === null) return 'one_sided_book';
  if (!est) return 'no_price';
  return est.code === 'markup_too_high' ? 'markup_too_high' : est.code === 'price_too_high' ? 'price_too_high' : est.code === 'no_price' ? 'no_price' : null;
}

/** What the Place bet button says for a range. The same rules as for a parlay, with the range's own figures and words. */
export function rangeButtonState(i: RangeInputs): ButtonState {
  if (i.phase === 'placing') return { canPlace: false, label: 'Placing both orders', notice: null, blockedBy: 'placing' };
  if (i.readOnly) return blocked('readonly', 'Bets are switched off', null);
  if (!i.low || !i.high) return blocked('loading', 'Loading prices', null);
  if (!(i.stake >= MIN_BET)) return blocked('stake', `Stake at least ${usd(MIN_BET, 0)}`, `The smallest bet is ${usd(MIN_BET, 0)}.`, 'info');

  const a = i.answer;
  if (a) {
    if (!a.quote.offerable) {
      const code = firstReason(a.quote.reasons.map((r) => r.code));
      if (code === 'market_closed') {
        const c = closedCopy(i.low, i.high);
        return blocked(code, c.label, c.text);
      }
      if (code) return blocked(code, RANGE_COPY[code].label, RANGE_COPY[code].text);
      return blocked('markup_too_high', 'Not on offer', a.quote.reasons[0]?.message ?? 'This range is not on offer right now.');
    }
    const plan = a.stake;
    if (plan && (!(plan.cost >= MIN_BET) || !(plan.contracts > 0))) {
      const fits = plan.cost > 0 ? ` The market can fill about ${usd(plan.cost)} at these prices, below the ${usd(MIN_BET, 0)} minimum.` : '';
      return blocked('thin', 'Not enough on the market', `There is not enough resting on the market to fill a bet at these prices right now.${fits} Try other levels, or check again in a moment.`);
    }
    if (!plan) return blocked('checking', 'Checking the price', null);
    return { canPlace: true, label: `Place bet · ${usd(plan.cost)}`, notice: null, blockedBy: null };
  }

  const early = localRangeRefusal(i.low, i.high, i.est);
  if (early === 'market_closed') {
    const c = closedCopy(i.low, i.high);
    return blocked(early, c.label, c.text);
  }
  if (early) return blocked(early, RANGE_COPY[early].label, RANGE_COPY[early].text);
  if (i.answerError) return blocked('unreachable', 'Prices unavailable', 'We could not get a price for this range. Check your connection and try again.');
  return blocked('checking', 'Checking the price', null);
}
