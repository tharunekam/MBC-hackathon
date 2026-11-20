import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_ALL_IN_PRICE,
  PRODUCTION_TAKER_FEE_COEF,
  REFUSE_MARKUP_DOLLARS,
  REFUSE_MARKUP_FRACTION,
  WARN_MARKUP_DOLLARS,
  WARN_MARKUP_FRACTION,
  assessPair,
  capToDepth,
  ladderInversions,
  planForQuantity,
} from '../src/offer.ts';
import type { Rung } from '../src/pairs.ts';

const near = (actual: number | null, expected: number, eps = 1e-6) =>
  assert.ok(actual !== null && Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);

const rung = (strike: number, bid: number | null, ask: number | null, open = true): Rung => ({
  symbol: `GEMI-TEST-HI${strike}`,
  label: `$${strike} or above`,
  strike,
  bid,
  ask,
  open,
  state: open ? 'active/open' : 'active/post_only',
});

const codes = (q: ReturnType<typeof assessPair>) => q.reasons.map((r) => r.code);

test('the thresholds are the ones the research settled on', () => {
  assert.equal(PRODUCTION_TAKER_FEE_COEF, 0.07);
  assert.equal(MAX_ALL_IN_PRICE, 0.95);
  assert.equal(REFUSE_MARKUP_DOLLARS, 0.08);
  assert.equal(REFUSE_MARKUP_FRACTION, 0.2);
  assert.equal(WARN_MARKUP_DOLLARS, 0.05);
  assert.equal(WARN_MARKUP_FRACTION, 0.15);
});

test('known answer: every number on a quote, worked by hand', () => {
  // Condition A: bid 0.80, ask 0.84 (middle 0.82). Outcome B: bid 0.40, ask 0.42 (middle 0.41).
  const a = rung(1800, 0.8, 0.84);
  const b = rung(1820, 0.4, 0.42);
  const q = assessPair([a, b], a, b, { feeCoef: 0 }); // a venue that charges nothing, like the sandbox

  near(q.chanceCondition, 0.82);
  near(q.chanceBothHappen, 0.41);
  near(q.fairPrice, 0.5); // 0.41 / 0.82
  near(q.pricePaid, 0.525); // 0.42 / 0.80, no fees charged
  // Production fees: (0.42 + 0.07*0.42*0.58) / (0.80 - 0.07*0.20*0.80) = 0.437052 / 0.7888
  near(q.allInPrice, 0.437052 / 0.7888);
  near(q.allInPrice, 0.554072, 1e-6);
  near(q.markup, 0.054072, 1e-6); // judged against the production price, not the sandbox one
  near(q.markupPct, 0.108144, 1e-6);
  // Cash-out per $100 with no fees: 100/0.525 = 190.476 YES sold at 0.40, plus 100 NO sold at 1-0.84 = 0.16.
  assert.equal(q.cashOutPer100, 92.19); // 76.19 + 16.00
  // At production fees: 100/0.554072 = 180.4819 YES at (0.40 - 0.0168) plus 100 NO at (0.16 - 0.009408).
  assert.equal(q.cashOutPer100AtProductionFees, 84.22); // 69.16 + 15.06
  assert.equal(q.feeCoefCharged, 0);

  assert.equal(q.verdict, 'warn'); // 5.4 cents over fair sits between 5 and 8
  assert.equal(q.offerable, true);
  assert.equal(q.overridden, false);
  assert.equal(q.warnings.length, 1);
  assert.deepEqual(q.reasons, []);
});

test('on a venue that charges production fees, price paid equals the all-in price', () => {
  const a = rung(1800, 0.8, 0.84);
  const b = rung(1820, 0.4, 0.42);
  const q = assessPair([a, b], a, b, { feeCoef: 0.07 });
  near(q.pricePaid, q.allInPrice!);
  assert.equal(q.cashOutPer100, q.cashOutPer100AtProductionFees);
});

test('a tight pair passes cleanly', () => {
  // fair 0.405/0.81 = 0.5; all-in (0.41 + 0.016933)/0.7888 = 0.54124 -> 4.1 cents, 8.2% over
  const a = rung(1800, 0.8, 0.82);
  const b = rung(1820, 0.4, 0.41);
  const q = assessPair([a, b], a, b);
  assert.equal(q.verdict, 'ok');
  assert.equal(q.offerable, true);
  near(q.markup, 0.426933 / 0.7888 - 0.5, 1e-6);
  assert.deepEqual(q.warnings, []);
});

test('warn: a small bet in percentage terms can still warn on the 15% line', () => {
  // fair 0.10/0.895 = 0.11173; all-in (0.105 + 0.07*0.105*0.895)/(0.89 - 0.07*0.11*0.89) = 0.111578/0.883147 = 0.12634
  // -> 1.5 cents but 13.1% over... tighten: use ask 0.107 -> 0.113702/0.883147 = 0.12875 -> 1.7 cents, 15.2% over
  const a = rung(100, 0.89, 0.9);
  const b = rung(110, 0.093, 0.107);
  const q = assessPair([a, b], a, b);
  assert.ok(q.markup! < WARN_MARKUP_DOLLARS, `markup ${q.markup}`);
  assert.ok(q.markupPct! >= WARN_MARKUP_FRACTION && q.markupPct! <= REFUSE_MARKUP_FRACTION, `pct ${q.markupPct}`);
  assert.equal(q.verdict, 'warn');
});

test('refuse: all-in price at or above 0.95', () => {
  // fair 0.895/0.925 = 0.9676; all-in (0.90 + 0.0063)/(0.92 - 0.005152) = 0.99066
  const a = rung(1800, 0.92, 0.93);
  const b = rung(1820, 0.89, 0.9);
  const q = assessPair([a, b], a, b);
  assert.equal(q.verdict, 'refuse');
  assert.deepEqual(codes(q), ['price_too_high']);
  assert.equal(q.offerable, false);
  // and the sandbox waiver does NOT cover it
  assert.equal(assessPair([a, b], a, b, { waiveMarkup: true }).offerable, false);
});

test('refuse: more than 8 cents over fair', () => {
  // the sandbox bot book seen on 2026-11-17: fair 0.445/0.90 = 0.494, all-in about 0.68
  const a = rung(1800, 0.83, 0.97);
  const b = rung(1820, 0.35, 0.54);
  const q = assessPair([a, b], a, b);
  assert.equal(q.verdict, 'refuse');
  assert.deepEqual(codes(q), ['markup_too_high']);
  assert.ok(q.markup! > REFUSE_MARKUP_DOLLARS);
  assert.equal(q.offerable, false);
  assert.match(q.reasons[0]!.message, /more than the fair price/);
});

test('refuse: more than 20% over fair even when that is under 8 cents', () => {
  // fair 0.10/0.895 = 0.1117; all-in (0.12 + 0.007392)/0.883147 = 0.14425 -> 3.3 cents but 29% over
  const a = rung(100, 0.89, 0.9);
  const b = rung(110, 0.08, 0.12);
  const q = assessPair([a, b], a, b);
  assert.ok(q.markup! < REFUSE_MARKUP_DOLLARS, `markup ${q.markup}`);
  assert.ok(q.markupPct! > REFUSE_MARKUP_FRACTION, `pct ${q.markupPct}`);
  assert.equal(q.verdict, 'refuse');
  assert.deepEqual(codes(q), ['markup_too_high']);
});

test('the boundaries: exactly 8 cents is allowed (warn), a hair over is refused', () => {
  const a = rung(1800, 0.8, 0.84);
  const b = rung(1820, 0.4, 0.42);
  const base = assessPair([a, b], a, b);
  // Shift the fair price so the markup lands exactly on a limit: markup = allIn - fair.
  const fairFor = (markup: number) => base.allInPrice! - markup;
  const withFair = (fair: number) => {
    // keep B's book and A's bid (so the all-in price is unchanged); move A's ask to set the middle of A
    const midA = 0.41 / fair;
    const a2 = rung(1800, 0.8, 2 * midA - 0.8);
    return assessPair([a2, b], a2, b);
  };
  const atLimit = withFair(fairFor(0.08));
  near(atLimit.markup, 0.08, 1e-7);
  assert.equal(atLimit.verdict, 'warn');
  const over = withFair(fairFor(0.0801));
  assert.equal(over.verdict, 'refuse');
  const atWarn = withFair(fairFor(0.05));
  assert.equal(atWarn.verdict, 'warn');
  const under = withFair(fairFor(0.0499));
  assert.equal(under.verdict, 'ok');
});

test('refuse: a one-sided book on either contract', () => {
  const full = rung(1800, 0.8, 0.82);
  for (const [a, b] of [
    [rung(1800, 0.8, null), rung(1820, 0.4, 0.41)],
    [rung(1800, null, 0.82), rung(1820, 0.4, 0.41)],
    [full, rung(1820, null, 0.41)],
    [full, rung(1820, 0.4, null)],
  ] as Array<[Rung, Rung]>) {
    const q = assessPair([a, b], a, b, { waiveMarkup: true });
    assert.equal(q.verdict, 'refuse');
    assert.ok(codes(q).includes('one_sided_book'));
    assert.equal(q.offerable, false); // never waived
    assert.equal(q.fairPrice, null); // no middle of the book, so no fair price is invented
  }
});

test('refuse: ladder prices out of order anywhere in the event', () => {
  const a = rung(1800, 0.8, 0.82);
  const b = rung(1820, 0.4, 0.41);
  // Two far-away rungs are inverted by one cent on the ask, as seen on the sandbox XRP and SOL ladders.
  const tail1 = rung(1840, 0.03, 0.2);
  const tail2 = rung(1860, 0.03, 0.21);
  const q = assessPair([a, b, tail1, tail2], a, b, { waiveMarkup: true });
  assert.equal(q.verdict, 'refuse');
  assert.deepEqual(codes(q), ['ladder_out_of_order']);
  assert.equal(q.offerable, false); // never waived
  assert.match(q.reasons[0]!.message, /\$1860 or above/);

  const inv = ladderInversions([a, b, tail1, tail2]);
  assert.equal(inv.length, 1);
  assert.equal(inv[0]!.side, 'ask');
  // a higher bid counts too
  assert.equal(ladderInversions([rung(1, 0.5, 0.6), rung(2, 0.55, 0.6)])[0]!.side, 'bid');
  // equal prices are NOT out of order (the sandbox ETH ladder has four rungs at 0.89/0.97), and missing sides are skipped
  assert.deepEqual(ladderInversions([rung(1, 0.89, 0.97), rung(2, 0.89, 0.97), rung(3, 0.03, null), rung(4, null, 0.2)]), []);
});

test('refuse: closed or paused market, and an outcome that costs as much as the condition', () => {
  const closed = assessPair([], rung(1800, 0.8, 0.82, false), rung(1820, 0.4, 0.41));
  assert.deepEqual(codes(closed), ['market_closed']);
  assert.match(closed.reasons[0]!.message, /post_only/);

  const flat = assessPair([], rung(1800, 0.89, 0.97), rung(1820, 0.89, 0.97));
  assert.ok(codes(flat).includes('no_price'));
  assert.equal(flat.pricePaid, null);
  assert.equal(flat.offerable, false);
});

test('sandbox waiver: covers a pair refused only for markup, and says so', () => {
  const a = rung(1800, 0.83, 0.97);
  const b = rung(1820, 0.35, 0.54);
  const q = assessPair([a, b], a, b, { waiveMarkup: true });
  assert.equal(q.verdict, 'refuse'); // the verdict itself is never softened
  assert.equal(q.offerable, true);
  assert.equal(q.overridden, true);
  assert.deepEqual(codes(q), ['markup_too_high']);
});

test('bet plan: contracts, cost and the three results for one size', () => {
  // 10 YES at 0.42 = 4.20; NO costs 0.20, so the hedge is 4.20 / 0.80 = 5.25 contracts = 1.05. Total 5.25.
  const plan = planForQuantity(10, 0.42, 0.8, 0);
  assert.equal(plan.outcomeContracts, 10);
  assert.equal(plan.hedgeContracts, 5.25);
  near(plan.cost, 5.25);
  near(plan.ifBothHit, 4.75);
  near(plan.ifConditionFails, 0);
  near(plan.ifConditionOnly, -5.25);
  // production fees: ceil(0.07*10*0.42*0.58 = 0.17052) = 0.18, ceil(0.07*5.25*0.2*0.8 = 0.0588) = 0.06
  near(plan.feesAtProductionRates, 0.24);
});

test('depth guard maths: the bet shrinks until BOTH legs fit at the best price', () => {
  // plenty on both sides: untouched
  assert.equal(capToDepth(10, 0.42, 0.8, 0, 1000, 1000), 10);
  // only 3 offered on the outcome
  assert.equal(capToDepth(10, 0.42, 0.8, 0, 3, 1000), 3);
  // only 2 bid on the condition: the hedge for q outcome contracts is q*0.525, so q <= 3.80 (hedge 2.00)
  const capped = capToDepth(10, 0.42, 0.8, 0, 1000, 2);
  assert.equal(capped, 3.8);
  assert.ok(planForQuantity(capped, 0.42, 0.8, 0).hedgeContracts <= 2);
  assert.ok(planForQuantity(3.81, 0.42, 0.8, 0).hedgeContracts > 2);
  // with fees the hedge is bigger, so the cap is tighter, and it still fits
  const withFees = capToDepth(10, 0.42, 0.8, 0.07, 1000, 2);
  assert.ok(withFees < capped && withFees > 0);
  assert.ok(planForQuantity(withFees, 0.42, 0.8, 0.07).hedgeContracts <= 2);
  // nothing there at all
  assert.equal(capToDepth(10, 0.42, 0.8, 0, 0, 1000), 0);
  assert.equal(capToDepth(10, 0.42, 0.8, 0, 1000, 0), 0);
});
