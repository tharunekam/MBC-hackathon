/**
 * A basket's legs as pure data: what each leg starts on, which levels it may take, what it can win and lose, whether it is
 * ready to place, and the request that places them. Kept apart from the page so every rule is tested on its own.
 *
 * A basket is several ordinary bets placed in one step. Each leg is a Stake Back (rising or falling), a Range or a Breakout
 * on its own ladder, with its own two orders and its own result. Nothing links the legs on the exchange.
 */
import { ApiError } from '../api/client';
import type {
  BasketLegRequest,
  Bet,
  BreakoutQuoteResponse,
  Direction,
  MarketEvent,
  PlaceBasketRequest,
  PlaceBasketResponse,
  Product,
  QuoteResponse,
  RangeQuoteResponse,
  Rung,
} from '../api/types';
import {
  MIN_BET,
  breakoutButtonState,
  buttonState,
  maxPriceFor,
  rangeButtonState,
  type ButtonState,
  type Phase,
} from './betState';
import { defaultPair } from './defaultPair';
import { startingLevels } from './defaultRange';
import { usd } from './format';
import { assetKey } from './markets';
import {
  breakoutEstimate,
  breakoutOutcomesFor,
  estimate,
  mirrorBook,
  outcomesFor,
  rangeEstimate,
  rangeOutcomesFor,
} from './pricing';

export const MIN_LEGS = 2;
export const MAX_LEGS = 6;
/**
 * The most a single leg may stake until the venue says what its cap is. The hosted demo caps a bet at $25 and says so (the
 * stake cap the pages learn from /health or from a refusal, which `legStatus` takes as `maxStake` and prefers to this).
 */
export const LEG_MAX_STAKE = 25;
export const NAME_MAX = 40;

/** The four kinds of leg: a Stake Back going up, one going down, a Range, and a Breakout (the range's other side). */
export type LegKind = 'up' | 'down' | 'range' | 'breakout';

export interface LegDraft {
  /** Stable for the life of the leg, so React keys and quote keys do not move when other legs change. */
  key: string;
  kind: LegKind;
  event: string | null;
  /** A parlay's condition, or the lower of a range's or a breakout's two levels. */
  a: string | null;
  /** A parlay's target, or the higher of a range's or a breakout's two levels. */
  b: string | null;
  stakeText: string;
  stake: number;
}

export const productOf = (kind: LegKind): Product =>
  kind === 'range' || kind === 'breakout' ? kind : 'parlay';
export const directionOf = (kind: LegKind): Direction =>
  kind === 'down' ? 'down' : 'up';
export const kindOfLeg = (kind: LegKind) => ({
  product: productOf(kind),
  direction: directionOf(kind),
});

const twoSided = (r: Rung) => r.bid !== null && r.ask !== null;
const mid = (r: Rung) => ((r.bid ?? 0) + (r.ask ?? 0)) / 2;
const byStrike = (rungs: Rung[]) =>
  [...rungs].sort((x, y) => x.strike - y.strike);

/** Whether two levels are in the order the leg needs: the condition below the target going up, above it going down, and for a range or a breakout the lower level first. */
export function inOrder(kind: LegKind, a: Rung, b: Rung): boolean {
  return kind === 'down' ? a.strike > b.strike : a.strike < b.strike;
}

/** The strikes the first level may take: every one that leaves room for a second in the leg's direction. */
export function firstOptions(ev: MarketEvent, kind: LegKind): Rung[] {
  const r = byStrike(ev.rungs);
  return kind === 'down' ? r.slice(1).reverse() : r.slice(0, -1);
}

/** The strikes the second level may take once the first is chosen. */
export function secondOptions(
  ev: MarketEvent,
  kind: LegKind,
  a: string | null,
): Rung[] {
  const first = ev.rungs.find((r) => r.symbol === a);
  if (!first) return [];
  const r = byStrike(ev.rungs).filter((x) => inOrder(kind, first, x));
  return kind === 'down' ? r.reverse() : r;
}

/**
 * A starting range: the floor and ceiling whose market chance of finishing inside is closest to 45 percent, among the pairs the
 * offer rule would take. With none on offer, the closest pair that has prices; with no prices, the two middle strikes.
 */
export function defaultRange(
  ev: MarketEvent,
  feeCoef = 0,
): { a: string; b: string } | null {
  const r = byStrike(ev.rungs);
  if (r.length < 2) return null;
  const priced = r.filter(twoSided);
  let best: { a: string; b: string; score: number; ok: boolean } | null = null;
  for (let i = 0; i < priced.length; i++) {
    for (let j = i + 1; j < priced.length; j++) {
      const lo = priced[i]!;
      const hi = priced[j]!;
      const chance = mid(lo) - mid(hi);
      if (!(chance > 0)) continue;
      const est = rangeEstimate(
        { bid: lo.bid, ask: lo.ask },
        { bid: hi.bid, ask: hi.ask },
        feeCoef,
      );
      const ok = !!est && est.verdict !== 'refuse';
      const score = Math.abs(chance - 0.45);
      if (!best || (ok && !best.ok) || (ok === best.ok && score < best.score))
        best = { a: lo.symbol, b: hi.symbol, score, ok };
    }
  }
  if (best) return { a: best.a, b: best.b };
  const m = Math.max(0, Math.floor(r.length / 2) - 1);
  return { a: r[m]!.symbol, b: r[m + 1]!.symbol };
}

/** The levels a leg starts on, for its kind and market. */
export function defaultLevels(
  ev: MarketEvent,
  kind: LegKind,
  feeCoef = 0,
): { a: string; b: string } | null {
  if (kind === 'range') return defaultRange(ev, feeCoef);
  if (kind === 'breakout') {
    // The same start as the Range page gives a breakout: about an even chance of finishing outside.
    const lv = startingLevels(ev, feeCoef, 'out');
    return lv ? { a: lv.low, b: lv.high } : null;
  }
  const p = defaultPair(ev, kind);
  return p ? { a: p.c, b: p.t } : null;
}

/**
 * When the first level changes, the second stays if it is still in order; otherwise it moves to the nearest strike that is.
 */
export function withFirst(
  ev: MarketEvent,
  kind: LegKind,
  a: string,
  b: string | null,
): { a: string; b: string | null } {
  const options = secondOptions(ev, kind, a);
  if (options.some((r) => r.symbol === b)) return { a, b };
  return { a, b: options[0]?.symbol ?? null };
}

/** Whether a leg's levels exist on its market and are in order. */
export function levelsValid(
  ev: MarketEvent | undefined,
  kind: LegKind,
  a: string | null,
  b: string | null,
): boolean {
  if (!ev) return false;
  const ra = ev.rungs.find((r) => r.symbol === a);
  const rb = ev.rungs.find((r) => r.symbol === b);
  return !!ra && !!rb && inOrder(kind, ra, rb);
}

/**
 * A market for a new leg: one on an asset no leg uses yet, else one no leg uses. Undefined when every market already has a
 * leg: the first market would be a copy of that leg, so there is nothing to pick, and the page turns Add a leg off.
 */
export function pickMarket(
  events: MarketEvent[],
  used: (string | null)[],
): MarketEvent | undefined {
  const usedAssets = new Set(
    used.filter((t): t is string => !!t).map((t) => assetKey({ ticker: t })),
  );
  return (
    events.find((e) => !usedAssets.has(assetKey(e))) ??
    events.find((e) => !used.includes(e.ticker))
  );
}

/** Dollars as typed in a stake box. */
export const stakeText = (n: number): string =>
  Number.isInteger(n) ? String(n) : n.toFixed(2);

/**
 * Splits an amount across legs to the cent. Every leg gets the same whole number of cents and the last leg takes whatever is
 * left over, so the parts always add up to exactly what was typed.
 */
export function splitEvenly(total: number, n: number): number[] {
  if (!(n > 0) || !(total > 0))
    return Array.from({ length: Math.max(0, n) }, () => 0);
  const cents = Math.round(total * 100);
  const each = Math.floor(cents / n);
  const extra = cents - each * n;
  return Array.from(
    { length: n },
    (_, i) => (each + (i === n - 1 ? extra : 0)) / 100,
  );
}

/**
 * The line under the amount while it is shared evenly: what each leg gets, and what the last one gets when the amount does
 * not divide to the cent. Empty when there is nothing to share.
 */
export function splitWords(total: number, n: number): string {
  const parts = splitEvenly(total, n);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (first === undefined || last === undefined || !(total > 0)) return '';
  if (parts.length === 1) return `One leg takes all ${usd(first)}.`;
  if (first === last) return `Shared evenly: ${usd(first)} a leg.`;
  return `Shared evenly: ${usd(first)} a leg and ${usd(last)} on the last, so they add up to ${usd(total)}.`;
}

let seq = 0;
export const newLegKey = (): string =>
  `leg-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function makeLeg(
  ev: MarketEvent | undefined,
  kind: LegKind,
  stake: number,
  feeCoef = 0,
  key = newLegKey(),
): LegDraft {
  const lv = ev ? defaultLevels(ev, kind, feeCoef) : null;
  return {
    key,
    kind,
    event: ev?.ticker ?? null,
    a: lv?.a ?? null,
    b: lv?.b ?? null,
    stake,
    stakeText: stakeText(stake),
  };
}

/**
 * The two legs a basket opens with: a rising parlay and a range on the first two assets that have prices. With one asset, a
 * parlay and a range on it.
 */
export function seedLegs(
  events: MarketEvent[],
  total: number,
  feeCoef = 0,
  keys?: [string, string],
): LegDraft[] {
  const [s0, s1] = splitEvenly(total, 2) as [number, number];
  const first = events[0];
  if (!first) return [];
  const other = events.find((e) => assetKey(e) !== assetKey(first));
  if (other)
    return [
      makeLeg(first, 'up', s0, feeCoef, keys?.[0]),
      makeLeg(other, 'range', s1, feeCoef, keys?.[1]),
    ];
  return [
    makeLeg(first, 'up', s0, feeCoef, keys?.[0]),
    makeLeg(first, 'range', s1, feeCoef, keys?.[1]),
  ];
}

/**
 * The request that places the basket. `prices` are the prices per $1 the legs' quotes showed, in leg order: each leg may cost up
 * to that price plus a little room (`maxPriceFor`, the same as a single bet's), and no more. A leg whose price is not known
 * carries no limit of its own, so the executor's applies.
 */
export function buildRequest(
  name: string,
  legs: LegDraft[],
  user = 'primary',
  prices: readonly (number | null | undefined)[] = [],
): PlaceBasketRequest {
  const trimmed = name.trim().slice(0, NAME_MAX);
  return {
    user,
    ...(trimmed ? { name: trimmed } : {}),
    legs: legs.map((l, i): BasketLegRequest => {
      if (!l.event || !l.a || !l.b)
        throw new Error('Every leg needs a market and two levels.');
      const maxPrice = maxPriceFor(prices[i]);
      const room = maxPrice !== undefined ? { maxPrice } : {};
      if (l.kind === 'range' || l.kind === 'breakout')
        return {
          product: l.kind,
          event: l.event,
          low: l.a,
          high: l.b,
          stake: l.stake,
          ...room,
        };
      return {
        product: 'parlay',
        event: l.event,
        condition: l.a,
        target: l.b,
        direction: l.kind,
        stake: l.stake,
        ...room,
      };
    }),
  };
}

/**
 * What makes two requests the same attempt: the bets chosen, and nothing else. The executor takes a request id seen before for
 * the same bets as a repeat, whatever the price limits or the name; so a price that ticks, or a name that is edited, between
 * an answer that was lost and the retry must not give the retry a new id, which would place the basket twice.
 */
export const basketAttemptKey = (req: Pick<PlaceBasketRequest, 'legs'>): string =>
  JSON.stringify(req.legs.map(({ maxPrice: _limit, ...chosen }) => chosen));

/** The statuses a bet ends in when its orders could not be completed. A bet that is open, settled or sold back is not one of them. */
const NOT_COMPLETED = new Set<Bet['status']>(['failed', 'unwound', 'unhedged']);

/**
 * The baskets a list of bets makes up, each as the executor answers for it when it is placed. Only a basket whose every bet is
 * in the list and none still being placed is described: with legs missing, a list cannot say whether the rest are on their way
 * or were never placed, and only the executor's own answer to a repeat of the request knows.
 */
export function basketsFromBets(bets: readonly Bet[]): PlaceBasketResponse[] {
  const groups = new Map<string, Bet[]>();
  for (const b of bets) {
    if (!b.basket) continue;
    const group = groups.get(b.basket.id);
    if (group) group.push(b);
    else groups.set(b.basket.id, [b]);
  }
  const out: PlaceBasketResponse[] = [];
  for (const [id, legs] of groups) {
    legs.sort((a, b) => (a.basket?.index ?? 0) - (b.basket?.index ?? 0));
    const tag = legs[0]!.basket!;
    if (legs.length < tag.size || legs.some((b) => b.status === 'placing')) continue;
    const bad = legs.find((b) => NOT_COMPLETED.has(b.status));
    const clientRequestId = legs.find((b) => b.clientRequestId !== undefined)?.clientRequestId;
    out.push({
      basket: {
        id,
        name: tag.name ?? null,
        size: tag.size,
        failed: bad ? { index: bad.basket?.index ?? 0, code: bad.status, message: bad.note ?? 'The orders for this leg could not be completed.' } : null,
        ...(clientRequestId !== undefined ? { clientRequestId } : {}),
      },
      bets: legs,
    });
  }
  return out;
}

// ------------------------------------------------------------------ one leg's quote, in figures

export type LegAnswer =
  | QuoteResponse
  | RangeQuoteResponse
  | BreakoutQuoteResponse;

/** A range's answer, which a breakout's is told apart from by its product: both carry a `low` and a `high`. */
const rangeAnswer = (x: LegAnswer | null): RangeQuoteResponse | null =>
  x && 'low' in x && x.product !== 'breakout' ? x : null;
const breakoutAnswer = (x: LegAnswer | null): BreakoutQuoteResponse | null =>
  x && 'low' in x && x.product === 'breakout' ? x : null;

/** Whether an executor answer is for these levels and this kind of leg: a parlay's condition and target, or the two levels of a range or a breakout. */
export function answerMatches(
  kind: LegKind,
  answer: LegAnswer | null | undefined,
  a: string | null,
  b: string | null,
): boolean {
  if (!answer) return false;
  if (kind === 'range' || kind === 'breakout') {
    const mine =
      kind === 'range' ? rangeAnswer(answer) : breakoutAnswer(answer);
    return !!mine && mine.low.symbol === a && mine.high.symbol === b;
  }
  return (
    'condition' in answer &&
    answer.condition.symbol === a &&
    answer.target.symbol === b &&
    (answer.direction ?? 'up') === kind
  );
}

export interface LegStatus {
  state: ButtonState;
  /** What the leg will cost, wins and loses, in dollars; null while there is nothing to go on. */
  cost: number | null;
  win: number | null;
  lose: number | null;
  /**
   * What a parlay nets when its first level fails and the stake comes back: nothing, or the few cents the executor's answer
   * says the refund order returns over the cost. Null for a range or a breakout, which have no such result.
   */
  back: number | null;
  /** The chance it wins; for a parlay also the chance the stake comes back. */
  chanceWin: number | null;
  chanceBack: number | null;
  pricePaid: number | null;
  /** True while the figures are the instant estimate, not the executor's answer. */
  estimated: boolean;
  /** The executor could only fill part of the stake: about this much. */
  reducedTo: number | null;
}

export interface LegInputs {
  kind: LegKind;
  stake: number;
  phase: Phase;
  readOnly: boolean;
  a: Rung | undefined;
  b: Rung | undefined;
  /** The executor's answer for these levels AND this stake, or null while there is none. */
  answer: LegAnswer | null;
  /** The last answer for these levels at any stake, for figures while a new stake is being checked. */
  shown: LegAnswer | null;
  answerError: boolean;
  feeCoef: number;
  /** The most one bet may stake on this venue, when it is known (the hosted demo sets it lower than the default here). */
  maxStake?: number | null;
}

const asSeen = (r: Rung, kind: LegKind) =>
  kind === 'down' ? { ...r, ...mirrorBook(r) } : r;

/** A leg above the cap is refused by the executor, so the button says so before it is asked. */
function capped(state: ButtonState, stake: number, cap = LEG_MAX_STAKE): ButtonState {
  if (!(stake > cap)) return state;
  if (
    !state.canPlace &&
    state.blockedBy !== 'checking' &&
    state.blockedBy !== 'unreachable'
  )
    return state;
  return {
    canPlace: false,
    label: `Stake ${usd(cap, 0)} at most`,
    notice: {
      tone: 'info',
      text: `Each bet is capped at ${usd(cap, 0)} here.`,
    },
    blockedBy: 'stake',
  };
}

/** One leg's figures and whether it may be placed, from the same rules as the single-bet builders. */
export function legStatus(i: LegInputs): LegStatus {
  const { kind, a, b, stake } = i;
  if (kind === 'range') {
    const est =
      a && b
        ? rangeEstimate(
            { bid: a.bid, ask: a.ask },
            { bid: b.bid, ask: b.ask },
            i.feeCoef,
          )
        : null;
    const answer = rangeAnswer(i.answer);
    const shown = rangeAnswer(i.shown);
    const state = capped(
      rangeButtonState({
        phase: i.phase,
        readOnly: i.readOnly,
        stake,
        low: a,
        high: b,
        answer,
        answerError: i.answerError,
        est,
      }),
      stake,
      i.maxStake ?? undefined,
    );
    const plan = shown?.stake ?? null;
    const q = shown?.quote;
    let cost: number | null = null;
    let win: number | null = null;
    let lose: number | null = null;
    if (plan && plan.cost >= MIN_BET && answer) {
      cost = plan.cost;
      win = plan.ifInRange;
      lose = plan.ifOutside;
    } else if (est && stake >= MIN_BET) {
      const o = rangeOutcomesFor(stake, est.unitCost);
      cost = o.cost;
      win = o.ifInRange;
      lose = o.ifOutside;
    }
    return {
      state,
      cost,
      win,
      lose,
      back: null,
      chanceWin: q?.chanceInRange ?? est?.chanceInRange ?? null,
      chanceBack: null,
      pricePaid: q?.pricePaid ?? est?.pricePaid ?? null,
      estimated: !answer,
      reducedTo: answer?.stake?.reduced ? answer.stake.cost : null,
    };
  }

  if (kind === 'breakout') {
    const est =
      a && b
        ? breakoutEstimate(
            { bid: a.bid, ask: a.ask },
            { bid: b.bid, ask: b.ask },
            i.feeCoef,
          )
        : null;
    const answer = breakoutAnswer(i.answer);
    const shown = breakoutAnswer(i.shown);
    const state = capped(
      breakoutButtonState({
        phase: i.phase,
        readOnly: i.readOnly,
        stake,
        low: a,
        high: b,
        answer,
        answerError: i.answerError,
        est,
      }),
      stake,
      i.maxStake ?? undefined,
    );
    const plan = shown?.stake ?? null;
    const q = shown?.quote;
    let cost: number | null = null;
    let win: number | null = null;
    let lose: number | null = null;
    if (plan && plan.cost >= MIN_BET && answer) {
      cost = plan.cost;
      win = plan.ifOutside;
      lose = plan.ifInRange;
    } else if (est && stake >= MIN_BET) {
      const o = breakoutOutcomesFor(stake, est.unitCost);
      cost = o.cost;
      win = o.ifOutside;
      lose = o.ifInRange;
    }
    return {
      state,
      cost,
      win,
      lose,
      back: null,
      chanceWin: q?.chanceOutside ?? est?.chanceOutside ?? null,
      chanceBack: null,
      pricePaid: q?.pricePaid ?? est?.pricePaid ?? null,
      estimated: !answer,
      reducedTo: answer?.stake?.reduced ? answer.stake.cost : null,
    };
  }

  const est =
    a && b ? estimate(asSeen(a, kind), asSeen(b, kind), i.feeCoef) : null;
  const answer = i.answer && 'condition' in i.answer ? i.answer : null;
  const shown = i.shown && 'condition' in i.shown ? i.shown : null;
  const state = capped(
    buttonState({
      phase: i.phase,
      readOnly: i.readOnly,
      stake,
      direction: kind,
      condition: a,
      target: b,
      answer,
      answerError: i.answerError,
      est,
    }),
    stake,
    i.maxStake ?? undefined,
  );
  const plan = shown?.stake ?? null;
  const q = shown?.quote;
  const pricePaid = q?.pricePaid ?? est?.pricePaid ?? null;
  let cost: number | null = null;
  let win: number | null = null;
  let lose: number | null = null;
  let back: number | null = null;
  if (plan && plan.cost >= MIN_BET && answer) {
    cost = plan.cost;
    win = plan.ifBothHit;
    lose = plan.ifConditionOnly;
    back = plan.ifConditionFails;
  } else if (pricePaid && stake >= MIN_BET) {
    const o = outcomesFor(stake, pricePaid);
    cost = o.cost;
    win = o.ifBothHit;
    lose = o.ifConditionOnly;
    back = o.ifConditionFails;
  }
  const chanceCondition = q?.chanceCondition ?? est?.chanceCondition ?? null;
  return {
    state,
    cost,
    win,
    lose,
    back,
    chanceWin: q?.chanceBothHappen ?? est?.chanceBothHappen ?? null,
    chanceBack: chanceCondition !== null ? 1 - chanceCondition : null,
    pricePaid,
    estimated: !answer,
    reducedTo: answer?.stake?.reduced ? answer.stake.cost : null,
  };
}

// ------------------------------------------------------------------ the whole basket

export interface Totals {
  /** What the legs' stakes add up to, as they were set. */
  stake: number;
  /**
   * What the orders come to. A bet is sized to cost no more than its stake, and contracts come in hundredths, so this can be
   * a cent or two under the stakes; it is well under when the market can only fill part of a leg.
   */
  cost: number;
  /** Every leg wins: the sum of the wins. Null until every leg has a figure. */
  best: number | null;
  /** Every leg loses: the sum of the losses. */
  worst: number | null;
}

const round = (x: number) => Math.round(x * 100) / 100;

export function totals(
  legs: { stake: number; status?: Pick<LegStatus, 'cost' | 'win' | 'lose'> }[],
): Totals {
  let stake = 0;
  let cost = 0;
  let best: number | null = 0;
  let worst: number | null = 0;
  for (const l of legs) {
    stake += l.stake;
    cost += l.status?.cost ?? l.stake;
    best = best !== null && l.status?.win != null ? best + l.status.win : null;
    worst =
      worst !== null && l.status?.lose != null ? worst + l.status.lose : null;
  }
  return {
    stake: round(stake),
    cost: round(cost),
    best: best === null ? null : round(best),
    worst: worst === null ? null : round(worst),
  };
}

/** "2", "2 and 3", "1, 2 and 4". */
export const listed = (ns: number[]): string =>
  ns.length < 2
    ? ns.join('')
    : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`;

/**
 * The line under what the orders cost, saying why that figure can sit below the stakes. It is always there, so the ticket
 * does not jump each time a moving price takes a cent off: the executor sizes every bet to cost no more than its stake, and
 * contracts come in hundredths, so a leg often comes in a cent or two under. `reduced` are the legs, from 0, that the market
 * can only fill part of, which is the one case where the gap is more than cents. Null if the orders ever came to more than
 * the stakes: that should not happen, and the figure is then shown without a sentence that would be untrue.
 */
export function costNote(
  t: Pick<Totals, 'stake' | 'cost'>,
  reduced: number[] = [],
): string | null {
  if (t.cost > t.stake + 0.005) return null;
  // One sentence for the ticket, joined with the rule that nothing is placed unless every leg passes (the two used to be two
  // grey paragraphs that said much the same thing).
  const checked = 'and every leg is checked before any is placed.';
  if (reduced.length > 0 && t.stake - t.cost >= 0.005)
    return `The market can only cover part of ${reduced.length === 1 ? 'leg' : 'legs'} ${listed(reduced.map((i) => i + 1))} right now, ${checked}`;
  return `Each bet is sized to cost no more than its stake, ${checked}`;
}

/**
 * Where the ticket sticks while the legs scroll beside it, in pixels from the top of the window. A ticket that fits sits
 * under the header. One taller than the window is given a place above the top instead, so it scrolls with the page until
 * its last line (the Place basket button) reaches the bottom of the window and stays in view from there; stuck under the
 * header, its button would be out of reach until the legs had been scrolled past.
 */
export function ticketTop(
  height: number,
  viewport: number,
  header = 84,
  gap = 16,
): number {
  return Math.min(header, Math.round(viewport - height - gap));
}

const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

export interface BasketButton {
  canPlace: boolean;
  label: string;
  /** The leg that blocks it, from 0, or null. */
  blockedLeg: number | null;
}

/** The Place basket button: live only when every leg is; otherwise it names the first leg in the way and why. */
export function basketButton(args: {
  phase: Phase;
  readOnly: boolean;
  legs: (LegStatus | undefined)[];
  placing?: number;
}): BasketButton {
  const { legs } = args;
  if (args.phase === 'placing')
    return {
      canPlace: false,
      label: `Placing ${args.placing ?? legs.length} bets`,
      blockedLeg: null,
    };
  if (args.readOnly)
    return {
      canPlace: false,
      label: 'Bets are switched off',
      blockedLeg: null,
    };
  if (legs.length < MIN_LEGS)
    return {
      canPlace: false,
      label: `Add at least ${MIN_LEGS} legs`,
      blockedLeg: null,
    };
  for (let i = 0; i < legs.length; i++) {
    const s = legs[i];
    if (!s)
      return {
        canPlace: false,
        label: `Leg ${i + 1}: loading prices`,
        blockedLeg: i,
      };
    if (!s.state.canPlace)
      return {
        canPlace: false,
        label: `Leg ${i + 1}: ${lowerFirst(s.state.label)}`,
        blockedLeg: i,
      };
  }
  const total = round(legs.reduce((n, s) => n + (s?.cost ?? 0), 0));
  return {
    canPlace: true,
    label: `Place basket · ${usd(total)}`,
    blockedLeg: null,
  };
}

/** Whether to warn that the legs can move together: two or more of them on crypto assets. */
const CRYPTO = new Set([
  'BTC',
  'ETH',
  'SOL',
  'XRP',
  'DOGE',
  'LTC',
  'AVAX',
  'LINK',
  'ADA',
  'DOT',
  'BCH',
  'MATIC',
  'ZEC',
]);
export function cryptoLegs(events: (MarketEvent | undefined)[]): number {
  return events.filter(
    (e) =>
      !!e &&
      ((e.category ?? '').toLowerCase() === 'crypto' ||
        CRYPTO.has(assetKey(e))),
  ).length;
}

/**
 * Whether it makes sense to say that crypto legs "that point the same way" win together more often. Only a Stake Back points a
 * way, up or down. A Range or a Breakout on a crypto market points nowhere, and its joint chance with another market can sit
 * below the figure for unrelated markets even though the prices move together, so one of them in the basket silences the
 * sentence. Legs on other assets are not part of what it says. `crypto` is whether the leg's market is a crypto one.
 */
export function legsPointAWay(legs: { kind: LegKind; crypto: boolean }[]): boolean {
  return legs.every((l) => !l.crypto || l.kind === 'up' || l.kind === 'down');
}

/**
 * Where "Place the rest again" starts, as a leg number from 0: at the leg that could not be completed, or just after it when
 * that leg is on the books with only its first order filled (status `unhedged`), because placing it again would buy it twice.
 * A leg that bought nothing, or was sold straight back, is placed again like the ones after it.
 */
export function restFrom(res: Pick<PlaceBasketResponse, 'basket' | 'bets'>): number {
  const failed = res.basket.failed;
  if (!failed) return 0;
  const held = res.bets.some((b) => b.basket?.index === failed.index && b.status === 'unhedged');
  return failed.index + (held ? 1 : 0);
}

/** A refused basket: which leg, from 0, and the message without its "Leg N: " prefix. Null for any other error. */
export function refusedLeg(
  err: unknown,
): { index: number; message: string } | null {
  if (!(err instanceof ApiError)) return null;
  const index = err.body?.leg;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0)
    return null;
  return { index, message: stripLegPrefix(err.message) };
}

export const stripLegPrefix = (message: string): string =>
  message.replace(/^Leg \d+:\s*/, '');
