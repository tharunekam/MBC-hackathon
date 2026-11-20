/**
 * A basket's legs as pure data: what each leg starts on, which levels it may take, what it can win and lose, whether it is
 * ready to place, and the request that places them. Kept apart from the page so every rule is tested on its own.
 *
 * A basket is several ordinary bets placed in one step. Each leg is a Return Parlay (rising or falling) or a Range on its own
 * ladder, with its own two orders and its own result. Nothing links the legs on the exchange.
 */
import { ApiError } from '../api/client';
import type {
  BasketLegRequest,
  Direction,
  MarketEvent,
  PlaceBasketRequest,
  Product,
  QuoteResponse,
  RangeQuoteResponse,
  Rung,
} from '../api/types';
import {
  MIN_BET,
  buttonState,
  rangeButtonState,
  type ButtonState,
  type Phase,
} from './betState';
import { defaultPair } from './defaultPair';
import { usd } from './format';
import { assetKey } from './markets';
import {
  estimate,
  mirrorBook,
  outcomesFor,
  rangeEstimate,
  rangeOutcomesFor,
} from './pricing';

export const MIN_LEGS = 2;
export const MAX_LEGS = 6;
/** The most a single leg may stake. The demo caps every bet at this, and the executor refuses more. */
export const LEG_MAX_STAKE = 100;
export const NAME_MAX = 40;

/** The three kinds of leg: a Return Parlay going up, one going down, and a Range. */
export type LegKind = 'up' | 'down' | 'range';

export interface LegDraft {
  /** Stable for the life of the leg, so React keys and quote keys do not move when other legs change. */
  key: string;
  kind: LegKind;
  event: string | null;
  /** A parlay's condition, or a range's floor. */
  a: string | null;
  /** A parlay's target, or a range's ceiling. */
  b: string | null;
  stakeText: string;
  stake: number;
}

export const productOf = (kind: LegKind): Product =>
  kind === 'range' ? 'range' : 'parlay';
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

/** Whether two levels are in the order the leg needs: the condition below the target going up, above it going down, the floor below the ceiling. */
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

/** A market for a new leg: one on an asset no leg uses yet, else one no leg uses, else the first. */
export function pickMarket(
  events: MarketEvent[],
  used: (string | null)[],
): MarketEvent | undefined {
  const usedAssets = new Set(
    used.filter((t): t is string => !!t).map((t) => assetKey({ ticker: t })),
  );
  return (
    events.find((e) => !usedAssets.has(assetKey(e))) ??
    events.find((e) => !used.includes(e.ticker)) ??
    events[0]
  );
}

/** Dollars as typed in a stake box. */
export const stakeText = (n: number): string =>
  Number.isInteger(n) ? String(n) : n.toFixed(2);

/** Splits an amount across legs to the cent; the cents left over go to the first legs, so the parts add up to the amount. */
export function splitEvenly(total: number, n: number): number[] {
  if (!(n > 0) || !(total > 0))
    return Array.from({ length: Math.max(0, n) }, () => 0);
  const cents = Math.round(total * 100);
  const each = Math.floor(cents / n);
  const extra = cents - each * n;
  return Array.from(
    { length: n },
    (_, i) => (each + (i < extra ? 1 : 0)) / 100,
  );
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

/** The request that places the basket. */
export function buildRequest(
  name: string,
  legs: LegDraft[],
  user = 'primary',
): PlaceBasketRequest {
  const trimmed = name.trim().slice(0, NAME_MAX);
  return {
    user,
    ...(trimmed ? { name: trimmed } : {}),
    legs: legs.map((l): BasketLegRequest => {
      if (!l.event || !l.a || !l.b)
        throw new Error('Every leg needs a market and two levels.');
      if (l.kind === 'range')
        return {
          product: 'range',
          event: l.event,
          low: l.a,
          high: l.b,
          stake: l.stake,
        };
      return {
        product: 'parlay',
        event: l.event,
        condition: l.a,
        target: l.b,
        direction: l.kind,
        stake: l.stake,
      };
    }),
  };
}

// ------------------------------------------------------------------ one leg's quote, in figures

export type LegAnswer = QuoteResponse | RangeQuoteResponse;

/** Whether an executor answer is for these levels: a parlay's condition and target, a range's floor and ceiling. */
export function answerMatches(
  kind: LegKind,
  answer: LegAnswer | null | undefined,
  a: string | null,
  b: string | null,
): boolean {
  if (!answer) return false;
  if (kind === 'range')
    return (
      'low' in answer && answer.low.symbol === a && answer.high.symbol === b
    );
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
}

const asSeen = (r: Rung, kind: LegKind) =>
  kind === 'down' ? { ...r, ...mirrorBook(r) } : r;

/** A leg above the cap is refused by the executor, so the button says so before it is asked. */
function capped(state: ButtonState, stake: number): ButtonState {
  if (!(stake > LEG_MAX_STAKE)) return state;
  if (
    !state.canPlace &&
    state.blockedBy !== 'checking' &&
    state.blockedBy !== 'unreachable'
  )
    return state;
  return {
    canPlace: false,
    label: `Stake ${usd(LEG_MAX_STAKE, 0)} at most`,
    notice: {
      tone: 'info',
      text: `Each bet is capped at ${usd(LEG_MAX_STAKE, 0)} here.`,
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
    const answer = i.answer && 'low' in i.answer ? i.answer : null;
    const shown = i.shown && 'low' in i.shown ? i.shown : null;
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
      chanceWin: q?.chanceInRange ?? est?.chanceInRange ?? null,
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
  );
  const plan = shown?.stake ?? null;
  const q = shown?.quote;
  const pricePaid = q?.pricePaid ?? est?.pricePaid ?? null;
  let cost: number | null = null;
  let win: number | null = null;
  let lose: number | null = null;
  if (plan && plan.cost >= MIN_BET && answer) {
    cost = plan.cost;
    win = plan.ifBothHit;
    lose = plan.ifConditionOnly;
  } else if (pricePaid && stake >= MIN_BET) {
    const o = outcomesFor(stake, pricePaid);
    cost = o.cost;
    win = o.ifBothHit;
    lose = o.ifConditionOnly;
  }
  const chanceCondition = q?.chanceCondition ?? est?.chanceCondition ?? null;
  return {
    state,
    cost,
    win,
    lose,
    chanceWin: q?.chanceBothHappen ?? est?.chanceBothHappen ?? null,
    chanceBack: chanceCondition !== null ? 1 - chanceCondition : null,
    pricePaid,
    estimated: !answer,
    reducedTo: answer?.stake?.reduced ? answer.stake.cost : null,
  };
}

// ------------------------------------------------------------------ the whole basket

export interface Totals {
  stake: number;
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
  let best: number | null = 0;
  let worst: number | null = 0;
  for (const l of legs) {
    stake += l.status?.cost ?? l.stake;
    best = best !== null && l.status?.win != null ? best + l.status.win : null;
    worst =
      worst !== null && l.status?.lose != null ? worst + l.status.lose : null;
  }
  return {
    stake: round(stake),
    best: best === null ? null : round(best),
    worst: worst === null ? null : round(worst),
  };
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
