import type { Bet, MarketEvent, Rung } from '../api/types';
import { betPay } from './basketPays';
import { outcomeOf } from './betsView';
import { money, usdSigned } from './format';
import { payoffCurves, type LadderCurve, type LegPay } from './payoffCurve';
import { wholePercents } from './shares';

/**
 * "Your open bets, together": every open bet a person holds, gathered by the market it is on, and what the bets on each
 * market net when they are added up at every price that market can finish at (lib/payoffCurve.ts), with the same thing in
 * sentences. My bets lists each bet on its own; this is what several of them come to.
 *
 * One finishing price decides every bet on a market, so adding them up bar by bar is exact for the exchange's prices. Bets on
 * different markets are decided by different prices and are never added to each other: each market is its own chart. Pure, so
 * the grouping, the figures and the wording can be checked without a page.
 */

type BookBet = Pick<Bet, 'status' | 'settlement' | 'eventTicker' | 'product' | 'direction' | 'condition' | 'target' | 'payoffs'>;
type BookEvent = Pick<MarketEvent, 'ticker' | 'title' | 'expiry' | 'rungs'>;

/**
 * The bets that are still running: placed, and not settled, sold back, failed or unwound. A bet whose orders are still on
 * their way is not counted until they have filled, since it has no figures to add up before then.
 */
export const openBets = <B extends Pick<Bet, 'status' | 'settlement'>>(bets: readonly B[]): B[] =>
  // A bet left with one order ('unprotected') still pays at each finishing price, so it counts. One whose second order may or
  // may not have gone through ('unconfirmed') is left out until the exchange says which.
  bets.filter((b) => b.status !== 'placing' && ['open', 'unprotected'].includes(outcomeOf(b)));

export interface BookMarket<B = Bet, E = MarketEvent> {
  /** The market as the exchange lists it now. */
  event: E;
  /** The open bets added up here, in the order of the list they came from. */
  bets: B[];
  /** The same bets as the curve takes them, one for one. */
  pays: LegPay[];
  /** What they net together at each finishing price, and how likely the market makes each. */
  curve: LadderCurve;
  /** Open bets on this market that are not in the chart, because one of their levels has no price to read. */
  waiting: number;
}

export interface Book<B = Bet, E = MarketEvent> {
  /** One per market with something to draw, soonest close first. */
  markets: BookMarket<B, E>[];
  /** How many open bets there are in all. */
  open: number;
  /** Open bets on a market that is no longer listed or has no prices, so no chart can count them. */
  leftOut: number;
}

/** When a market closes, as a number to sort by. A market with no close time goes last. */
function closesAt(e: Pick<MarketEvent, 'expiry'>): number {
  const t = e.expiry ? new Date(e.expiry).getTime() : NaN;
  return Number.isFinite(t) ? t : Infinity;
}

/**
 * The open bets among `bets`, market by market, against the ladders the exchange lists right now. Markets come soonest close
 * first; of two that close together, the one holding more bets, then by ticker so the order never flickers.
 */
export function bookOf<B extends BookBet, E extends BookEvent>(bets: readonly B[], events: readonly E[]): Book<B, E> {
  const open = openBets(bets);
  const listed = new Map(events.map((e) => [e.ticker, e]));
  const ladders: Record<string, Rung[]> = {};
  for (const e of events) ladders[e.ticker] = e.rungs;
  const pays = open.map(betPay);
  const { curves, missing } = payoffCurves(pays, ladders);

  const markets: BookMarket<B, E>[] = [];
  for (const curve of curves) {
    const event = listed.get(curve.ticker);
    if (!event) continue;
    markets.push({
      event,
      bets: curve.legs.map((i) => open[i]!),
      pays: curve.legs.map((i) => pays[i]!),
      curve,
      waiting: missing.filter((i) => open[i]!.eventTicker === curve.ticker).length,
    });
  }
  markets.sort((a, b) => {
    const [x, y] = [closesAt(a.event), closesAt(b.event)];
    if (x !== y) return x < y ? -1 : 1;
    return b.bets.length - a.bets.length || (a.event.ticker < b.event.ticker ? -1 : a.event.ticker > b.event.ticker ? 1 : 0);
  });

  const charted = new Set(markets.map((m) => m.event.ticker));
  return { markets, open: open.length, leftOut: missing.filter((i) => !charted.has(open[i]!.eventTicker)).length };
}

/** How many markets are shown before the rest are folded away. */
export const SHOWN_FIRST = 2;

/** The markets shown straight away, and the ones behind "2 more markets". */
export function splitMarkets<M>(markets: readonly M[]): { first: M[]; rest: M[] } {
  return { first: markets.slice(0, SHOWN_FIRST), rest: markets.slice(SHOWN_FIRST) };
}

// ------------------------------------------------------------------ in words

/** Two results this close are the same result: half a cent. */
const SAME = 0.005;

export interface Stretch {
  /** Lower edge, a level of the ladder. Null when the stretch runs down from the lowest level. */
  from: number | null;
  /** Upper edge. Null when it runs up from the highest level. */
  to: number | null;
  /** The market's chance of finishing in it. */
  chance: number;
}

/** The finishing prices that give one result: the curve's bars with that net, joined up where they sit side by side. */
export function stretchesAt(curve: Pick<LadderCurve, 'bars'>, net: number): Stretch[] {
  const out: Stretch[] = [];
  let joined = false;
  for (const bar of curve.bars) {
    const here = Math.abs(bar.net - net) < SAME;
    const last = out[out.length - 1];
    if (here && joined && last) {
      last.to = bar.bucket.to;
      last.chance += bar.bucket.chance;
    } else if (here) out.push({ from: bar.bucket.from, to: bar.bucket.to, chance: bar.bucket.chance });
    joined = here;
  }
  return out;
}

/** A stretch in words that follow "finishes": "below $62,500", "between $62,500 and $63,500", "at $63,500 or above". */
const stretchWords = (s: Stretch): string =>
  s.from === null ? (s.to === null ? 'at any price' : `below ${money(s.to)}`) : s.to === null ? `at ${money(s.from)} or above` : `between ${money(s.from)} and ${money(s.to)}`;

/** "a", "a or b", "a, b or c". */
const either = (parts: string[]): string => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`);

/** One chance as a whole percent. A real chance is never rounded away to "0%", or a real doubt up to "100%". */
function chanceText(c: number): string {
  const whole = Math.round(c * 100);
  if (c > 1e-9 && whole === 0) return 'under 1%';
  if (c < 1 - 1e-9 && whole === 100) return 'over 99%';
  return `${whole}%`;
}

/** Chances that sit side by side, as whole percents that add to 100, with the same care at both ends. */
function shareTexts(chances: number[]): string[] {
  const whole = wholePercents(chances);
  return chances.map((c, i) => {
    if (c > 1e-9 && whole[i] === 0) return 'under 1%';
    if (whole[i] === 100 && chances.some((x, j) => j !== i && x > 1e-9)) return 'over 99%';
    return `${whole[i]}%`;
  });
}

/** "1 bet", "3 bets": how many bets a chart adds up. */
export const countWords = (n: number): string => `${n} bet${n === 1 ? '' : 's'}`;

export interface MarketWords {
  /** "Both bets together: ahead 41% of the time, behind 59%." */
  odds: string;
  /** "Best +$16.00 if Bitcoin finishes between $63,500 and $64,000 (21% chance). Worst −$14.00 if it finishes …" */
  reach: string;
}

/**
 * One market's chart in words: how often the bets on it end ahead, at the market's own prices, then the most and the least
 * they can net and the finishing prices that give each. `pays` are the bets the curve adds up; `asset` is what the market's
 * price is of ("Bitcoin").
 *
 * The best and the worst each carry their own chance only when it says something new. With one bet the best is every price
 * that ends ahead, so its chance is the "ahead" figure already given and is not repeated.
 */
export function marketWords(curve: LadderCurve, pays: readonly LegPay[], asset: string): MarketWords {
  const n = pays.length;
  const who = n === 1 ? 'This bet' : n === 2 ? 'Both bets together' : `All ${n} bets together`;
  // One parlay on its own is level only when its stake comes back, so it is called that. Several bets can also cancel out.
  const only = n === 1 ? pays[0] : undefined;
  const levelName = only && (only.shape.kind === 'up' || only.shape.kind === 'down') ? 'stake back' : 'level';
  const [ahead, level, behind] = shareTexts([curve.ahead, curve.level, curve.behind]) as [string, string, string];
  const odds = `${who}: ahead ${ahead} of the time${curve.level > 1e-9 ? `, ${levelName} ${level}` : ''}, behind ${behind}.`;

  if (curve.best - curve.worst < SAME) return { odds, reach: `Wherever ${asset} finishes, ${n === 1 ? 'this bet nets' : 'these bets net'} ${usdSigned(curve.best)}.` };

  const part = (net: number, whole: number): string => {
    const at = stretchesAt(curve, net);
    const chance = at.reduce((sum, s) => sum + s.chance, 0);
    const said = Math.abs(chance - whole) < 1e-6;
    return `${either(at.map(stretchWords))}${said ? '' : ` (${chanceText(chance)} chance)`}`;
  };
  const best = part(curve.best, curve.best > SAME ? curve.ahead : curve.best < -SAME ? curve.behind : curve.level);
  const worst = part(curve.worst, curve.worst < -SAME ? curve.behind : curve.worst > SAME ? curve.ahead : curve.level);
  return { odds, reach: `Best ${usdSigned(curve.best)} if ${asset} finishes ${best}. Worst ${usdSigned(curve.worst)} if it finishes ${worst}.` };
}

/**
 * The sentence above the charts: what they show. With several markets it also says that they are not added to each other,
 * in the Basket page's own words. Null when no market can be drawn.
 */
export function bookIntro(book: Pick<Book<unknown, unknown>, 'markets'>): string | null {
  const [one, ...others] = book.markets;
  if (!one) return null;
  if (others.length > 0) return 'What your open bets net at each price a market can finish at, with bets on the same market added together. Each market is decided by its own price, so the charts are not added together.';
  return one.bets.length === 1 ? 'What your open bet nets at each price the market can finish at.' : 'What your open bets on this market net together at each price it can finish at.';
}

/**
 * Open bets no chart counts, in one sentence: their market is no longer listed, or has no prices. `shown` is how many markets
 * are drawn, so the sentence can say "other" when it follows charts and speak for every open bet when there are none.
 */
export function leftOutWords(leftOut: number, shown: number): string | null {
  if (leftOut <= 0) return null;
  const why = leftOut === 1 ? 'its market has no prices right now' : 'their markets have no prices right now';
  if (shown === 0) return leftOut === 1 ? `Your open bet is not shown here: ${why}.` : `Your ${leftOut} open bets are not shown here: ${why}.`;
  return leftOut === 1 ? `1 other open bet is left out: ${why}.` : `${leftOut} other open bets are left out: ${why}.`;
}

/** Under one market's chart, for open bets on that market that are not in it. */
export function waitingWords(waiting: number): string | null {
  if (waiting <= 0) return null;
  return waiting === 1 ? '1 more open bet on this market is left out: one of its levels has no price right now.' : `${waiting} more open bets on this market are left out: some of their levels have no price right now.`;
}

/** The label of the fold that holds the markets after the first two: "1 more market". */
export const moreWords = (n: number): string => `${n} more market${n === 1 ? '' : 's'}`;

/**
 * A sentence cut where its results and chances are, so a page can keep each on one line ("−$30.00" must not break after its
 * minus sign) and give it weight. Odd places hold a figure. A finishing price ("$63,500") is not one: it carries no sign.
 */
export const figureParts = (text: string): string[] => text.split(/([+−]\$[\d,]+(?:\.\d+)?|\$0\.00(?!\d)|(?:under |over )?\d+%)/);
