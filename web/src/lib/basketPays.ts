import type { Bet } from '../api/types';
import { listed, type LegStatus } from './basket';
import type { Bucket } from './distribution';
import { usdSigned } from './format';
import { payIn, type LadderCurve, type LegPay } from './payoffCurve';
import { wholePercents } from './shares';
import { shapeOf, type JointLeg } from './together';

/**
 * "What this basket pays": the basket's legs handed to the payoff curve (payoffCurve.ts), and the plain sentences that go
 * with each ladder's chart. Kept apart from the page so the figures and the wording can be checked on their own.
 *
 * Legs on one ladder are decided by one finishing price, so their results add up bar by bar. Legs on different ladders are
 * decided by different prices and are never added together: each ladder is its own chart and its own sentence.
 */

/** A leg as the payoff curve takes it: its ladder, its shape, and what it nets each way. Null while it has no levels or no figures. */
export function legPay(leg: JointLeg | null, status: Pick<LegStatus, 'win' | 'lose' | 'back'> | undefined): LegPay | null {
  if (!leg || !status || status.win === null || status.lose === null) return null;
  return { ticker: leg.ticker, shape: leg.shape, win: status.win, lose: status.lose, ...(status.back ? { back: status.back } : {}) };
}

/** The same for a bet that has been placed, from what its two orders really filled at. Null when it carries no figures. */
export function betPay(bet: Pick<Bet, 'eventTicker' | 'product' | 'direction' | 'condition' | 'target' | 'payoffs'>): LegPay | null {
  const p = bet.payoffs;
  if (!p) return null;
  const kind = bet.product === 'range' || bet.product === 'breakout' ? bet.product : (bet.direction ?? 'up');
  return { ticker: bet.eventTicker, shape: shapeOf(kind, bet.condition.strike, bet.target.strike), win: p.ifBothHit, lose: p.ifConditionOnly, ...(p.ifConditionFails ? { back: p.ifConditionFails } : {}) };
}

/**
 * What one placed leg nets each way, on one line of the basket's receipt: "+$9.86 if it wins · −$15.00 if it loses · stake
 * back if the first level fails". A range and a breakout say inside and outside, which is how they win and lose.
 */
export function outcomeLine(bet: Pick<Bet, 'product' | 'payoffs'>): string | null {
  const p = bet.payoffs;
  if (!p) return null;
  const [win, lose] = [usdSigned(p.ifBothHit), usdSigned(p.ifConditionOnly)];
  if (bet.product === 'range') return `${win} inside · ${lose} outside`;
  if (bet.product === 'breakout') return `${win} outside · ${lose} inside`;
  return `${win} if it wins · ${lose} if it loses · stake back if the first level fails`;
}

export interface Extremes {
  /** The most the bets can net, and the least. */
  best: number;
  worst: number;
  /** True when the best case is every leg winning, and the worst every leg losing. Two legs that cannot both win make the first false. */
  everyWin: boolean;
  everyLose: boolean;
}

const cents = (x: number) => Math.round(x * 100) / 100;

/**
 * The most and the least a set of bets can net. Exact, and read from the strikes alone: on each ladder the legs' own strikes
 * cut the price line into stretches, the legs' results are added up in each stretch, and the best and worst stretch are
 * taken. Ladders are then added together, because nothing stops each one finishing wherever suits (or hurts) most.
 *
 * It is not the sum of the wins and the sum of the losses. A rising and a falling parlay on one ladder cannot both win, and a
 * breakout with a range inside it cannot both lose, so those sums can name a result no finishing price gives.
 * Null while any bet has no figures.
 */
export function extremes(pays: (LegPay | null)[]): Extremes | null {
  const all = pays.filter((p): p is LegPay => p !== null);
  if (all.length === 0 || all.length !== pays.length) return null;
  const byLadder = new Map<string, LegPay[]>();
  for (const p of all) byLadder.set(p.ticker, [...(byLadder.get(p.ticker) ?? []), p]);
  let best = 0;
  let worst = 0;
  for (const legs of byLadder.values()) {
    const strikes = [...new Set(legs.flatMap((l) => ('low' in l.shape ? [l.shape.low, l.shape.high] : [l.shape.condition, l.shape.target])))].sort((a, b) => a - b);
    // One stretch below the lowest strike, one from each strike up to the next, and one from the highest up.
    const stretches: Bucket[] = [{ from: null, to: strikes[0] ?? null, chance: 0 }, ...strikes.map((from, i) => ({ from, to: strikes[i + 1] ?? null, chance: 0 }))];
    const nets = stretches.map((s) => legs.reduce((sum, l) => sum + payIn(l, s), 0));
    best += Math.max(...nets);
    worst += Math.min(...nets);
  }
  const wins = all.reduce((n, p) => n + p.win, 0);
  const losses = all.reduce((n, p) => n + p.lose, 0);
  return { best: cents(best), worst: cents(worst), everyWin: Math.abs(best - wins) < 0.005, everyLose: Math.abs(worst - losses) < 0.005 };
}

/** Chances that sit side by side, as whole percents that add to 100. A real chance is never rounded away to "0%", or a real doubt up to "100%". */
function shareTexts(chances: number[]): string[] {
  const whole = wholePercents(chances);
  return chances.map((c, i) => {
    if (c > 1e-9 && whole[i] === 0) return 'under 1%';
    if (whole[i] === 100 && chances.some((x, j) => j !== i && x > 1e-9)) return 'over 99%';
    return `${whole[i]}%`;
  });
}

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];

export interface CurveWords {
  /** "On Bitcoin, both legs together: ahead 41% of the time, behind 59%. Best +$16.00, worst −$14.00." */
  line: string;
  /** The quiet line: what the legs average at the market's own odds, which is what they cost over fair value. */
  average: string;
}

/**
 * One ladder's chart in words. `pays` is the list the curve was made from, so its length is the basket's number of legs and
 * the curve's leg numbers index into it; `asset` is what the ladder's price is of ("Bitcoin").
 */
export function curveWords(curve: LadderCurve, pays: (LegPay | null)[], asset: string): CurveWords {
  const n = curve.legs.length;
  const numbers = curve.legs.map((i) => i + 1);
  const who = n === 1 ? `leg ${numbers[0]}` : n === pays.length ? (n === 2 ? 'both legs together' : `all ${n} legs together`) : `legs ${listed(numbers)} together`;
  // One parlay on its own is level only when its stake comes back, so it is called that. Several legs can also cancel out.
  const only = n === 1 ? pays[curve.legs[0]!] : null;
  const levelName = only && (only.shape.kind === 'up' || only.shape.kind === 'down') ? 'stake back' : 'level';
  const [ahead, level, behind] = shareTexts([curve.ahead, curve.level, curve.behind]) as [string, string, string];
  const shares = `ahead ${ahead} of the time${curve.level > 1e-9 ? `, ${levelName} ${level}` : ''}, behind ${behind}`;
  const line = `On ${asset}, ${who}: ${shares}. Best ${usdSigned(curve.best)}, worst ${usdSigned(curve.worst)}.`;

  const cost = n === 1 ? 'this leg costs' : `the ${COUNT_WORDS[n] ?? n} cost`;
  const average =
    curve.average < -0.005
      ? `At the market’s own odds this averages ${usdSigned(curve.average)}: that is what ${cost} over fair value.`
      : `At the market’s own odds this averages ${usdSigned(curve.average)}.`;
  return { line, average };
}

/**
 * The sentence above the charts: what they show, and whether one chart is the whole basket. With every leg on one ladder a
 * single finishing price decides everything, so the chart is the basket; with several ladders each is decided by its own
 * price and the charts must not be read as adding up.
 */
export function paysIntro(curves: LadderCurve[], missing: number[], legs: number): string {
  if (curves.length > 1) return 'What the legs net at each price a market can finish at. Each market is decided by its own price, so the charts are not added together.';
  const one = curves[0];
  if (one && missing.length === 0 && legs > 1 && one.legs.length === legs)
    return `What the basket nets at each price the market can finish at. ${legs === 2 ? 'Both legs are' : `All ${legs} legs are`} on this one market, so this is the whole basket.`;
  return 'What the legs net at each price a market can finish at.';
}

/** "Waiting for prices on leg 2." */
export const waitingWords = (missing: number[]): string => `Waiting for prices on ${missing.length === 1 ? 'leg' : 'legs'} ${listed(missing.map((i) => i + 1))}.`;

/** Under a ladder's chart, for legs on that ladder that are not in it yet: "Leg 2 is on this market too, and joins the chart once it has prices." */
export const waitingOnLadder = (missing: number[]): string =>
  missing.length === 1 ? `Leg ${missing[0]! + 1} is on this market too, and joins the chart once it has prices.` : `Legs ${listed(missing.map((i) => i + 1))} are on this market too, and join the chart once they have prices.`;
