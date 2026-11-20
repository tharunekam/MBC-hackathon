/**
 * What the Place bet button says, whether it is live, and what is shown above it, as one pure decision.
 *
 * It exists because the first real runs showed the old inline logic failing in specific ways: every refusal said "pick a
 * closer target" even when moving the target could not help (a market that is not open yet) or needed the opposite
 * (a payout too small for its price); an enabled button read "Place bet · $0.00" when the book had nothing to fill; the
 * button could be live on the strength of an estimate that the executor was about to overrule; and a failed attempt
 * could leave nothing on screen. Rules:
 *
 *  - The button is live only for an answer from the executor that matches these two levels AND this stake.
 *  - Every refusal names its own cause and the way out.
 *  - A bet the market cannot fill at the minimum size is not offered; the button never shows a zero price.
 *  - A failed attempt always leaves a message, whatever the quote says.
 *  - No stake is no bet: an empty box or a zero is asked for an amount, never offered the last one that was typed.
 *  - A ladder that has closed says so before anything else, because nothing a person can move would change it.
 *
 * The words: a parlay's two prices are "the first level" (the one that has to hold) and "the target" (what the bet is
 * about), and together they are "levels", as a range's two are.
 */
import type { BreakoutQuoteResponse, Direction, QuoteResponse, RangeQuoteResponse, RefusalCode, Rung } from '../api/types';
import { usd } from './format';
import type { MarketNote } from './marketPhase';
import type { BreakoutEstimate, Estimate, RangeEstimate } from './pricing';

export const MIN_BET = 1;

/**
 * How far above the price on the quote an order may go, per $1. The executor sizes the stake at the live price when the order
 * arrives, so a market that moved while the person was deciding would be absorbed silently; with this ceiling it is refused
 * instead (code `price_above_limit`) and the person is shown the new price. Three cents covers a few ticks of noise, not a move,
 * and leaves the executor room to size the refund order without trimming its limit on a thin book.
 */
export const PRICE_ROOM = 0.03;

/**
 * The `maxPrice` to send with a bet: the price per $1 the quote showed, plus `PRICE_ROOM`. Nothing (so the executor's own limit
 * applies) when the quote has no usable price. The executor takes a ceiling strictly between 0 and 1.
 */
export function maxPriceFor(shown: number | null | undefined): number | undefined {
  if (typeof shown !== 'number' || !Number.isFinite(shown) || !(shown > 0)) return undefined;
  return Math.min(0.99, Math.round((shown + PRICE_ROOM) * 1e4) / 1e4);
}

export type Phase = 'idle' | 'placing' | 'placed';

export interface StakeNoteInputs {
  /** Bets are switched off: there is no bet to size. */
  readOnly: boolean;
  /** What the market can fill, in dollars, when that is less than the stake asked for; null when it can fill the stake. */
  reducedTo: number | null;
  /** The bet cannot be placed (`isRefusal`). */
  refusing: boolean;
  /** The most one bet may be here, once known. */
  cap: number | null;
  /** The most the market has on offer right now, in whole dollars, or null when that is not known. */
  fits: number | null;
  /** "this price" or "these prices": what the bet is priced at. */
  at: string;
  /** What to say when there is nothing to say about size: what the two orders are for. */
  fallback: string;
}

/**
 * The line under the stake box. It says how much a bet can be (the venue's cap, or what the market has on offer) or what the
 * stake buys, and says nothing at all about the size of a bet that cannot be placed: "the bet will be that size" beside a
 * refusal described a bet that does not exist.
 */
export function stakeNote(i: StakeNoteInputs): string | null {
  if (i.readOnly) return null;
  if (i.reducedTo !== null && !i.refusing) return `The market can cover about ${usd(i.reducedTo)} at ${i.at}, so the bet will be that size.`;
  if (i.cap !== null && (i.fits === null || i.cap <= i.fits)) return `Up to ${usd(i.cap, 0)} a bet here.`;
  if (i.refusing) return null;
  if (i.fits !== null) return `Up to ${usd(i.fits, 0)} fits right now.`;
  return i.fallback;
}

/**
 * Whether the button is off because THIS bet cannot be placed, as opposed to a bet that is on its way, a stake still to be
 * typed, prices still loading or switched off. A refused bet (a market that is shut, levels the exchange will not price, too
 * little on offer to fill it) has no size and no winnings to show: whatever figures the quote still carries are those of a bet
 * nobody can make, so a page shows none of them as a bet and greys the rest.
 */
export const isRefusal = (s: Pick<ButtonState, 'blockedBy'>): boolean =>
  s.blockedBy !== null && s.blockedBy !== 'placing' && s.blockedBy !== 'readonly' && s.blockedBy !== 'loading' && s.blockedBy !== 'checking' && s.blockedBy !== 'unreachable' && s.blockedBy !== 'stake';

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

/** What every builder's button is told about the stake and the ladder, whatever the bet. */
interface Common {
  phase: Phase;
  readOnly: boolean;
  /** Dollars typed in the stake box. Zero when the box is empty or holds no amount. */
  stake: number;
  /** The most one bet may stake here, once the executor has said so. */
  cap?: number | null;
  /** The executor's own sentence when it refused the stake as too large and no cap could be read from it. */
  stakeRefused?: string | null;
  /** Set when the ladder as a whole cannot take a bet (closed, or not open yet): what to say instead. */
  market?: MarketNote | null;
}

export interface BetInputs extends Common {
  /** Which way the parlay looks. Only the words differ: a falling parlay asks for a lower target, not a higher one. */
  direction?: Direction;
  /** The first level: the rung that has to hold. Named as the executor names it. */
  condition: Rung | undefined;
  target: Rung | undefined;
  /** The executor's answer for these two levels and the stake that is typed right now, or null while there is none. */
  answer: QuoteResponse | null;
  /** The quote request failed and no answer exists. */
  answerError: boolean;
  /** The instant local estimate, used only to refuse early while the executor's answer is on its way. */
  est: Estimate | null;
}

/** What a payout that is too small for its price says, once: a Stake Back asks for a target further from the first level. */
const TOO_SMALL = { label: 'Payout too small', text: 'Move the target further above the first level.' };

/** Plain words for each refusal: the label on the button names what is wrong, and the note says what to do about it. */
const COPY: Record<RefusalCode, { label: string; text: string }> = {
  market_closed: {
    label: 'Not open for bets yet',
    text: 'One of these levels is not open yet. New markets can take a few minutes to open, so check back shortly or pick other levels.',
  },
  ladder_out_of_order: {
    label: 'Prices out of step',
    text: 'The prices on this market are out of order for the moment. Check back in a minute, or pick another market.',
  },
  one_sided_book: {
    label: 'No market at one level',
    text: 'Nobody is buying or selling at one of these levels right now. Pick other levels.',
  },
  // The executor refuses a target that is too near the first level under either code, and the way out is the same.
  no_price: TOO_SMALL,
  price_too_high: TOO_SMALL,
  markup_too_high: {
    label: 'Prices too far apart',
    text: 'The buy and sell prices at these two levels are too far apart. Try other levels, where the gap between them is smaller.',
  },
};

/** A code the executor may add one day is not one this page has words for: it is said as "not on offer", never a crash. */
const known = (code: string | null): code is RefusalCode => code !== null && Object.prototype.hasOwnProperty.call(COPY, code);

/** When several things are wrong at once, the one to say first: what you cannot fix by moving comes before what you can. */
const PRIORITY: RefusalCode[] = ['market_closed', 'ladder_out_of_order', 'one_sided_book', 'no_price', 'price_too_high', 'markup_too_high'];

/** The words for a refusal. A payout that is too small asks for a target further from the first level, which is lower for a falling bet. */
export function refusalCopy(code: RefusalCode, direction: Direction = 'up'): { label: string; text: string } {
  if (direction === 'down' && (code === 'no_price' || code === 'price_too_high')) {
    return { label: TOO_SMALL.label, text: 'Move the target further below the first level.' };
  }
  return COPY[code];
}

/**
 * "Not open" means different things, and what to do differs: a newly listed market opens in a few minutes (Gemini lists
 * them post-only first), but one that has closed or settled takes no more bets. This is the answer for the two chosen
 * levels; a ladder that is closed as a whole is said by the page's `market` note (lib/marketPhase.ts), which knows whether
 * there is another market to point at. It never says "pick the next one above", because there may be none.
 */
export function closedCopy(first: Rung | undefined, second: Rung | undefined): { label: string; text: string } {
  const states = [first, second].filter((r): r is Rung => !!r && !r.open).map((r) => r.state.toLowerCase());
  if (states.some((s) => /settled|closed|expired|resolved/.test(s))) {
    return { label: 'This market has closed', text: 'One of these levels has closed and takes no more bets. Pick another market.' };
  }
  if (states.some((s) => /post_only|post-only/.test(s))) return COPY.market_closed;
  return {
    label: 'Not open for bets',
    text: 'One of these levels is not open right now. Pick other levels, or check back in a minute.',
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

const blocked = (code: NonNullable<ButtonState['blockedBy']>, label: string, text: string | null, tone: Notice['tone'] = 'info'): ButtonState => ({
  canPlace: false,
  label,
  notice: text ? { tone, text } : null,
  blockedBy: code,
});

/**
 * What stops a bet before its prices are even looked at, the same for every builder: an order on its way, bets switched off,
 * a ladder that is closed, prices still loading, or a stake that is missing, too small or over the venue's cap.
 */
function gate(i: Common, loaded: boolean): ButtonState | null {
  if (i.phase === 'placing') return { canPlace: false, label: 'Placing both orders', notice: null, blockedBy: 'placing' };
  if (i.readOnly) return blocked('readonly', 'Bets are switched off', 'You are looking at live prices. Placing bets is switched off here.');
  // Not an error and nothing the person did, so it is said calmly.
  // The button's label says the market is closed (or not open); the note says what to do about it, not the same thing again.
  if (i.market) return blocked('market_closed', i.market.label, i.market.next ?? i.market.text, 'info');
  if (!loaded) return blocked('loading', 'Loading prices', null);
  if (!(i.stake > 0)) return blocked('stake', 'Enter a stake', null);
  if (i.stake < MIN_BET) return blocked('stake', `Stake at least ${usd(MIN_BET, 0)}`, `The smallest bet is ${usd(MIN_BET, 0)}.`, 'info');
  // The same label as a basket's leg uses for the same cap. No notice: the line under the stake box already says what the
  // cap is, and saying it a third time above the button is noise.
  if (i.cap != null && i.stake > i.cap) return blocked('stake', `Stake ${usd(i.cap, 0)} at most`, null);
  if (i.stakeRefused) return blocked('stake', 'Stake is too large', i.stakeRefused, 'info');
  return null;
}

export function buttonState(i: BetInputs): ButtonState {
  const stopped = gate(i, !!i.condition && !!i.target);
  if (stopped) return stopped;

  const a = i.answer;
  if (a) {
    if (!a.quote.offerable) {
      const code = firstReason(a.quote.reasons.map((r) => r.code));
      if (code === 'market_closed') {
        const c = closedCopy(i.condition, i.target);
        return blocked(code, c.label, c.text);
      }
      if (known(code)) return blocked(code, refusalCopy(code, i.direction).label, refusalCopy(code, i.direction).text);
      // The executor's own sentence for a reason this page does not know is never shown: it can name orders and symbols.
      return blocked('markup_too_high', 'Not on offer', 'This bet is not on offer right now. Try other levels.');
    }
    const plan = a.stake;
    if (plan && (!(plan.cost >= MIN_BET) || !(plan.outcomeContracts > 0))) {
      const fits = plan.cost > 0 ? ` The most it can cover is about ${usd(plan.cost)}, below the ${usd(MIN_BET, 0)} minimum.` : '';
      return blocked('thin', 'Not enough on the market', `Not enough is on offer for a bet at these prices right now.${fits} Try other levels, or check again in a moment.`);
    }
    if (!plan) return blocked('checking', 'Checking the price', null);
    return { canPlace: true, label: `Place bet · ${usd(plan.cost)}`, notice: null, blockedBy: null };
  }

  // No answer for these levels and this stake yet. Refuse early only on what the local numbers already settle.
  const early = localRefusal(i.condition, i.target, i.est);
  if (early === 'market_closed') {
    const c = closedCopy(i.condition, i.target);
    return blocked(early, c.label, c.text);
  }
  if (early) return blocked(early, refusalCopy(early, i.direction).label, refusalCopy(early, i.direction).text);
  if (i.answerError) return blocked('unreachable', 'Prices unavailable', 'We could not get a price for this bet. Check your connection and try again.', 'bad');
  return blocked('checking', 'Checking the price', null);
}

// ------------------------------------------------------------------ range and breakout

export interface RangeInputs extends Common {
  /** The floor and the ceiling. */
  low: Rung | undefined;
  high: Rung | undefined;
  /** The executor's answer for this range and the stake that is typed right now, or null while there is none. */
  answer: RangeQuoteResponse | null;
  answerError: boolean;
  /** The instant local estimate, used only to refuse early while the executor's answer is on its way. */
  est: RangeEstimate | null;
}

/** The same for a breakout: the two levels the price has to finish outside. */
export interface BreakoutInputs extends Omit<RangeInputs, 'answer' | 'est'> {
  answer: BreakoutQuoteResponse | null;
  est: BreakoutEstimate | null;
}

type Copy = Record<RefusalCode, { label: string; text: string }>;

/**
 * What a refusal means for a Range, in plain words. A Range costs more the further apart its levels are, so a price that is
 * too high asks for levels nearer to each other, and no price at all (the levels are too close to leave a chance between
 * them) for levels further apart.
 */
const RANGE_COPY: Copy = {
  ...COPY,
  no_price: {
    label: 'Levels too close together',
    text: 'Move the lower and higher levels further apart.',
  },
  price_too_high: {
    label: 'Levels too far apart',
    text: 'A range this wide costs too much for what it can win. Move the lower and higher levels nearer to each other.',
  },
};

/**
 * The same for a Breakout, which is priced the other way round: it costs more the CLOSER its levels are, because finishing
 * outside a narrow band is close to certain. Both of its price refusals ask for levels further apart.
 */
const BREAKOUT_COPY: Copy = {
  ...COPY,
  no_price: {
    label: 'Levels too close together',
    text: 'Move the lower and higher levels further apart.',
  },
  price_too_high: {
    label: 'Payout too small',
    text: 'Finishing outside these levels is close to certain, so it pays little. Move the levels further apart.',
  },
};

/** What the button needs from either bet on two levels: the answers have the same shape where it matters. */
interface LevelsInputs extends Omit<RangeInputs, 'answer' | 'est'> {
  answer: { quote: { offerable: boolean; reasons: { code: RefusalCode; message: string }[] }; stake: { cost: number; contracts: number } | null } | null;
  est: { code: RefusalCode | null } | null;
}

/** The refusal the local numbers already show, before the executor has answered. */
function localLevelsRefusal(low: Rung | undefined, high: Rung | undefined, est: LevelsInputs['est']): RefusalCode | null {
  if (!low || !high) return null;
  if (!low.open || !high.open) return 'market_closed';
  if (low.bid === null || low.ask === null || high.bid === null || high.ask === null) return 'one_sided_book';
  if (!est) return 'no_price';
  return est.code === 'markup_too_high' ? 'markup_too_high' : est.code === 'price_too_high' ? 'price_too_high' : est.code === 'no_price' ? 'no_price' : null;
}

/** One decision for both bets on two levels. `noun` is what the bet is called in a sentence. */
function levelsButtonState(i: LevelsInputs, copy: Copy, noun: 'range' | 'breakout'): ButtonState {
  const stopped = gate(i, !!i.low && !!i.high);
  if (stopped) return stopped;

  const a = i.answer;
  if (a) {
    if (!a.quote.offerable) {
      const code = firstReason(a.quote.reasons.map((r) => r.code));
      if (code === 'market_closed') {
        const c = closedCopy(i.low, i.high);
        return blocked(code, c.label, c.text);
      }
      if (known(code)) return blocked(code, copy[code].label, copy[code].text);
      return blocked('markup_too_high', 'Not on offer', `This ${noun} is not on offer right now. Try other levels.`);
    }
    const plan = a.stake;
    if (plan && (!(plan.cost >= MIN_BET) || !(plan.contracts > 0))) {
      const fits = plan.cost > 0 ? ` The most it can cover is about ${usd(plan.cost)}, below the ${usd(MIN_BET, 0)} minimum.` : '';
      return blocked('thin', 'Not enough on the market', `Not enough is on offer for a bet at these prices right now.${fits} Try other levels, or check again in a moment.`);
    }
    if (!plan) return blocked('checking', 'Checking the price', null);
    return { canPlace: true, label: `Place bet · ${usd(plan.cost)}`, notice: null, blockedBy: null };
  }

  const early = localLevelsRefusal(i.low, i.high, i.est);
  if (early === 'market_closed') {
    const c = closedCopy(i.low, i.high);
    return blocked(early, c.label, c.text);
  }
  if (early) return blocked(early, copy[early].label, copy[early].text);
  if (i.answerError) return blocked('unreachable', 'Prices unavailable', `We could not get a price for this ${noun}. Check your connection and try again.`, 'bad');
  return blocked('checking', 'Checking the price', null);
}

/** What the Place bet button says for a Range. The same rules as for a Stake Back, with the Range's own figures and words. */
export const rangeButtonState = (i: RangeInputs): ButtonState => levelsButtonState(i, RANGE_COPY, 'range');

/** And for a Breakout: the same rules again, with the advice a Breakout needs (see `BREAKOUT_COPY`). */
export const breakoutButtonState = (i: BreakoutInputs): ButtonState => levelsButtonState(i, BREAKOUT_COPY, 'breakout');
