import { describe, expect, it } from 'vitest';
import type { Bet, Rung } from '../api/types';
import { betPay, curveWords, extremes, legPay, outcomeLine, paysIntro, waitingOnLadder, waitingWords } from './basketPays';
import { payoffCurves, type LegPay } from './payoffCurve';

const rung = (strike: number, chance: number, spread = 0.01): Rung => ({ symbol: `S${strike}`, label: `$${strike}`, strike, bid: chance - spread, ask: chance + spread, open: true, state: 'active/open' });

// Chances of finishing at or above: 62,000 92%, 62,500 82%, 63,000 62%, 63,500 41%, 64,000 20%.
const ladders = {
  BTC: [rung(62000, 0.92), rung(62500, 0.82), rung(63000, 0.62), rung(63500, 0.41), rung(64000, 0.2)],
  ETH: [rung(1800, 0.8), rung(1820, 0.6), rung(1840, 0.4)],
};

const parlay: LegPay = { ticker: 'BTC', shape: { kind: 'up', condition: 62500, target: 63500 }, win: 10, lose: -10 };
const falling: LegPay = { ticker: 'BTC', shape: { kind: 'down', condition: 63500, target: 62500 }, win: 12, lose: -10 };
const range: LegPay = { ticker: 'BTC', shape: { kind: 'range', low: 63000, high: 64000 }, win: 6, lose: -4 };
const breakout: LegPay = { ticker: 'BTC', shape: { kind: 'breakout', low: 63000, high: 64000 }, win: 5, lose: -8 };
const ethRange: LegPay = { ticker: 'ETH', shape: { kind: 'range', low: 1800, high: 1840 }, win: 7.5, lose: -2.5 };

describe('a leg, as the payoff curve takes it', () => {
  const joint = { ticker: 'BTC', shape: parlay.shape };

  it('carries its ladder, its shape and what it nets each way', () => {
    expect(legPay(joint, { win: 10, lose: -10, back: 0 })).toEqual(parlay);
    expect(legPay({ ticker: 'BTC', shape: range.shape }, { win: 6, lose: -4, back: null })).toEqual(range);
  });

  it('keeps a stake-back figure only when the quote gives one that is not nothing', () => {
    expect(legPay(joint, { win: 10, lose: -10, back: 0.03 })).toEqual({ ...parlay, back: 0.03 });
    expect('back' in legPay(joint, { win: 10, lose: -10, back: 0 })!).toBe(false);
  });

  it('is left out while it has no levels or no figures', () => {
    expect(legPay(null, { win: 10, lose: -10, back: 0 })).toBeNull();
    expect(legPay(joint, undefined)).toBeNull();
    expect(legPay(joint, { win: null, lose: -10, back: 0 })).toBeNull();
    expect(legPay(joint, { win: 10, lose: null, back: 0 })).toBeNull();
  });

  it('reads a placed bet the same way, whichever product it is', () => {
    const bet = (over: Partial<Bet>): Pick<Bet, 'eventTicker' | 'product' | 'direction' | 'condition' | 'target' | 'payoffs'> => ({
      eventTicker: 'BTC',
      condition: { symbol: 'c', label: '', strike: 62500 },
      target: { symbol: 't', label: '', strike: 63500 },
      payoffs: { stake: 10, ifConditionFails: 0.02, ifBothHit: 11, ifConditionOnly: -10, conditionalPrice: 0.47, hedged: true },
      ...over,
    });
    expect(betPay(bet({}))).toEqual({ ticker: 'BTC', shape: { kind: 'up', condition: 62500, target: 63500 }, win: 11, lose: -10, back: 0.02 });
    expect(betPay(bet({ direction: 'down', condition: { symbol: 'c', label: '', strike: 63500 }, target: { symbol: 't', label: '', strike: 62500 } }))?.shape).toEqual({ kind: 'down', condition: 63500, target: 62500 });
    const rangePays = { stake: 10, ifBothHit: 6, ifConditionOnly: -4, ifInRange: 6, ifOutside: -4, conditionalPrice: 0.5, hedged: true };
    expect(betPay(bet({ product: 'range', payoffs: rangePays }))).toEqual({ ticker: 'BTC', shape: { kind: 'range', low: 62500, high: 63500 }, win: 6, lose: -4 });
    expect(betPay(bet({ product: 'breakout', payoffs: rangePays }))?.shape).toEqual({ kind: 'breakout', low: 62500, high: 63500 });
    expect(betPay(bet({ payoffs: undefined }))).toBeNull();
  });
});

describe('one placed leg, on the receipt', () => {
  const pays = { stake: 15, ifConditionFails: 0, ifBothHit: 9.86, ifConditionOnly: -15, ifInRange: 9.86, ifOutside: -15, conditionalPrice: 0.6, hedged: true };

  it('says what it nets each way in the product’s own words', () => {
    expect(outcomeLine({ payoffs: pays })).toBe('+$9.86 if it wins · −$15.00 if it loses · stake back if the first level fails');
    expect(outcomeLine({ product: 'parlay', payoffs: pays })).toContain('stake back if the first level fails');
    expect(outcomeLine({ product: 'range', payoffs: { ...pays, ifBothHit: 5.81, ifConditionOnly: -4.19 } })).toBe('+$5.81 inside · −$4.19 outside');
    expect(outcomeLine({ product: 'breakout', payoffs: { ...pays, ifBothHit: 7.55, ifConditionOnly: -9.99 } })).toBe('+$7.55 outside · −$9.99 inside');
    expect(outcomeLine({ product: 'range' })).toBeNull();
  });
});

describe('the best and the worst a basket can do', () => {
  it('is every leg winning and every leg losing when the legs allow it', () => {
    // Different ladders: nothing stops both winning, or both losing.
    expect(extremes([parlay, ethRange])).toEqual({ best: 17.5, worst: -12.5, everyWin: true, everyLose: true });
    // One ladder, and a price exists that wins both (63,500 to 64,000) and one that loses both (62,500 to 63,000).
    expect(extremes([parlay, range])).toEqual({ best: 16, worst: -14, everyWin: true, everyLose: true });
  });

  it('is less than the sum of the wins when two legs on one ladder cannot both win', () => {
    // Rising needs 63,500 or above, falling needs below 62,500. The best is the falling one winning with the other refunded.
    const e = extremes([parlay, falling])!;
    expect(e.best).toBe(12);
    expect(e.everyWin).toBe(false);
    // Between 62,500 and 63,500 both lose.
    expect(e.worst).toBe(-20);
    expect(e.everyLose).toBe(true);
  });

  it('is better than the sum of the losses when one of two legs always wins', () => {
    // A range and a breakout on the same two levels: exactly one wins, wherever the price finishes.
    const e = extremes([range, breakout])!;
    expect(e).toEqual({ best: 1, worst: -2, everyWin: false, everyLose: false });
  });

  it('adds ladders together, each at its own best and worst', () => {
    const e = extremes([parlay, falling, ethRange])!;
    expect(e.best).toBe(19.5);
    expect(e.worst).toBe(-22.5);
  });

  it('counts a stake that comes back with a few cents over', () => {
    expect(extremes([{ ...breakout, win: -1, lose: -2 }, { ...parlay, win: -3, lose: -4, back: 0.05 }])!.best).toBe(-0.95);
  });

  it('says nothing until every leg has figures', () => {
    expect(extremes([parlay, null])).toBeNull();
    expect(extremes([])).toBeNull();
  });
});

describe('one ladder’s chart, in words', () => {
  it('speaks for both legs of a two-leg basket on one ladder', () => {
    const pays = [parlay, range];
    const w = curveWords(payoffCurves(pays, ladders).curves[0]!, pays, 'Bitcoin');
    expect(w.line).toBe('On Bitcoin, both legs together: ahead 41% of the time, behind 59%. Best +$16.00, worst −$14.00.');
    // The same pair bought a little dearer, as a spread makes it: the parlay wins 9, not 10.
    // 8% × −4 + 10% × −4 + 20% × −14 + 21% × −4 + 21% × 15 + 20% × 5 = −0.21
    const dearer = [{ ...parlay, win: 9 }, range];
    expect(curveWords(payoffCurves(dearer, ladders).curves[0]!, dearer, 'Bitcoin').average).toBe('At the market’s prices this averages −$0.21, the cost of the two bets over their fair price.');
  });

  it('names the legs when the ladder holds only some of the basket', () => {
    const pays = [ethRange, parlay, range, breakout];
    const { curves } = payoffCurves(pays, ladders);
    expect(curveWords(curves[1]!, pays, 'Bitcoin').line).toMatch(/^On Bitcoin, legs 2, 3 and 4 together: /);
    expect(curveWords(curves[1]!, pays, 'Bitcoin').average).toMatch(/the cost of the three bets over their fair price\.$/);
    expect(curveWords(payoffCurves([parlay, range, breakout], ladders).curves[0]!, [parlay, range, breakout], 'Bitcoin').line).toMatch(/^On Bitcoin, all 3 legs together: /);
  });

  it('stays singular for a ladder with one leg, and calls a parlay’s level stretch what it is', () => {
    const pays = [ethRange, parlay];
    const { curves } = payoffCurves(pays, ladders);
    const btc = curveWords(curves[1]!, pays, 'Bitcoin');
    expect(btc.line).toBe('On Bitcoin, leg 2: ahead 41% of the time, stake back 18%, behind 41%. Best +$10.00, worst −$10.00.');
    // Fairly priced, this parlay averages nothing: 41% × 10 − 41% × 10. Winning 9 instead, it costs 41 cents.
    expect(btc.average).toBe('At the market’s prices this averages $0.00.');
    const dearer = [ethRange, { ...parlay, win: 9 }];
    expect(curveWords(payoffCurves(dearer, ladders).curves[1]!, dearer, 'Bitcoin').average).toBe('At the market’s prices this averages −$0.41, the cost of this bet over its fair price.');
    const eth = curveWords(curves[0]!, pays, 'Ethereum');
    expect(eth.line).toBe('On Ethereum, leg 1: ahead 40% of the time, behind 60%. Best +$7.50, worst −$2.50.');
  });

  it('says "stake back" for the executor’s own numbers, where the refund order returns a few cents over the stake', () => {
    // A $10 bet from the executor's plan at a 7% fee rate: the refund comes back +$0.213, not exactly zero. The caption used to
    // count that stretch as "ahead", so the chance of making money read 59% where the market's own odds make it 41%.
    const real: LegPay = { ...parlay, win: 9.06, lose: -10, back: 0.213 };
    const pays = [ethRange, real];
    const { curves } = payoffCurves(pays, ladders);
    expect(curveWords(curves[1]!, pays, 'Bitcoin').line).toBe('On Bitcoin, leg 2: ahead 41% of the time, stake back 18%, behind 41%. Best +$9.06, worst −$10.00.');
    // The three shares are the market's chance of each result, and add up to 100.
    expect(41 + 18 + 41).toBe(100);
  });

  it('prints the same shares whether the stake-back figure is exactly nothing or a few cents either way', () => {
    const say = (back?: number) => {
      const leg: LegPay = { ...parlay, ...(back === undefined ? {} : { back }) };
      return curveWords(payoffCurves([leg], ladders).curves[0]!, [leg], 'Bitcoin').line.replace(/\. Best.*/, '');
    };
    expect(say(0.213)).toBe(say());
    expect(say(2.116)).toBe(say());
    expect(say(-0.03)).toBe(say());
  });

  it('calls it level when several legs cancel out', () => {
    const pays = [parlay, { ...falling, win: 10 }];
    const w = curveWords(payoffCurves(pays, ladders).curves[0]!, pays, 'Bitcoin');
    expect(w.line).toContain('behind 41%');
    expect(w.line).not.toContain('stake back');
  });

  it('prints shares that add up to 100, and never rounds a real chance away', () => {
    const curve = { ...payoffCurves([parlay], ladders).curves[0]!, ahead: 0.376, level: 0.156, behind: 0.468 };
    expect(curveWords(curve, [parlay], 'Bitcoin').line).toContain('ahead 38% of the time, stake back 15%, behind 47%');
    const rare = { ...curve, ahead: 0.002, level: 0, behind: 0.998 };
    expect(curveWords(rare, [parlay], 'Bitcoin').line).toContain('ahead under 1% of the time, behind over 99%');
  });

  it('does not call an average that is not a cost a cost', () => {
    const curve = { ...payoffCurves([parlay], ladders).curves[0]!, average: 0.12 };
    expect(curveWords(curve, [parlay], 'Bitcoin').average).toBe('At the market’s prices this averages +$0.12.');
    expect(curveWords({ ...curve, average: -0.001 }, [parlay], 'Bitcoin').average).toBe('At the market’s prices this averages $0.00.');
  });
});

describe('the sentence above the charts', () => {
  const one = payoffCurves([parlay, range], ladders);
  const two = payoffCurves([parlay, ethRange], ladders);

  it('says one chart is the whole basket when every leg is on that ladder', () => {
    expect(paysIntro(one.curves, one.missing, 2)).toBe('What the basket pays at each finishing price. This one chart is the whole basket.');
    const three = payoffCurves([parlay, range, breakout], ladders);
    expect(paysIntro(three.curves, three.missing, 3)).toBe('What the basket pays at each finishing price. This one chart is the whole basket.');
    // That the legs share a market is said once on the Basket page, beside the chances, not again here.
    expect(paysIntro(three.curves, three.missing, 3)).not.toMatch(/same market|one market/);
  });

  it('says plainly that separate ladders are not added together', () => {
    expect(paysIntro(two.curves, two.missing, 2)).toBe('What the legs pay at each price a market can finish at. Each market is decided by its own price, so the charts are not added together.');
  });

  it('claims neither while a leg is still left out', () => {
    const part = payoffCurves([parlay, null], ladders);
    expect(part.missing).toEqual([1]);
    expect(paysIntro(part.curves, part.missing, 2)).toBe('What the legs pay at each price a market can finish at.');
    expect(waitingWords(part.missing)).toBe('Waiting for prices on leg 2.');
    expect(waitingWords([0, 2])).toBe('Waiting for prices on legs 1 and 3.');
    expect(waitingOnLadder([1])).toBe('Leg 2 is on this market too, and joins the chart once it has prices.');
    expect(waitingOnLadder([1, 2])).toBe('Legs 2 and 3 are on this market too, and join the chart once they have prices.');
  });
});

describe('the words of the pays panel', () => {
  it('uses "pays", "fair price" and "the market’s prices": never "nets", "fair value" or "odds"', () => {
    const one = payoffCurves([parlay, range], ladders);
    const two = payoffCurves([parlay, ethRange], ladders);
    const words = [paysIntro(one.curves, one.missing, 2), paysIntro(two.curves, two.missing, 2), paysIntro(one.curves, [1], 2), paysIntro([], [0], 1)];
    for (const [curve, pays] of [
      [one.curves[0]!, [parlay, range]],
      [two.curves[0]!, [parlay, ethRange]],
    ] as const) {
      for (const average of [-0.68, 0.12]) {
        const said = curveWords({ ...curve, average }, [...pays], 'Bitcoin');
        words.push(said.line, said.average);
      }
    }
    expect(words.length).toBeGreaterThan(8);
    for (const w of words) expect(w).not.toMatch(/\bnets?\b|fair value|\bodds\b/i);
  });

  it('says what the average is in the glossary’s words', () => {
    const one = payoffCurves([parlay, range], ladders);
    expect(curveWords({ ...one.curves[0]!, average: -0.68 }, [parlay, range], 'Bitcoin').average).toBe('At the market’s prices this averages −$0.68, the cost of the two bets over their fair price.');
  });
});
