import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GeminiEvent } from '../src/gemini/types.ts';
import { ladder, linkedPairs } from '../src/pairs.ts';
import { ceilToStep, conditionalPrice, floorToStep, hedgeQuantity, payoffs, settlementPayout } from '../src/pricing.ts';

const near = (actual: number, expected: number, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);

test('known answer: the ETH bet filled in the sandbox on 2026-11-17', () => {
  // Bought YES on "$1,820 or above" at 0.30 against a 0.71 bid on "$1,800 or above" (NO at 0.29).
  near(conditionalPrice(0.3, 0.71)!, 0.3 / 0.71);
  near(conditionalPrice(0.3, 0.71)!, 0.422535, 1e-6);

  // 10 contracts of B cost $3.00; the hedge must pay back $3.00 plus its own cost.
  const qA = hedgeQuantity(10 * 0.3, 0.29);
  assert.equal(qA, 4.23); // 3 / 0.71 = 4.2254, rounded UP to the 0.01 step

  const p = payoffs({ quantity: 10, avgPrice: 0.3 }, { quantity: 4.23, avgPrice: 0.29 });
  near(p.stake, 4.2267);
  near(p.ifConditionFails, 0.0033); // refund covers the stake, with a third of a cent to spare
  near(p.ifBothHit, 5.7733);
  near(p.ifConditionOnly, -4.2267);
  near(p.conditionalPrice!, 0.42267);
  assert.equal(p.hedged, true);
});

test('hedge always covers the stake at the worst allowed fill, for many prices', () => {
  for (let pB = 0.02; pB < 0.9; pB += 0.07) {
    for (let noA = 0.05; noA < 0.95; noA += 0.09) {
      for (const qB of [0.01, 1, 7.37, 250]) {
        const qA = hedgeQuantity(qB * pB, noA);
        const refund = qA - (qB * pB + qA * noA);
        assert.ok(refund >= -1e-9, `short by ${refund} at pB=${pB} noA=${noA} qB=${qB}`);
        // ...and never over-hedges by more than one quantity step
        assert.ok(qA - (qB * pB) / (1 - noA) < 0.01 + 1e-9);
      }
    }
  }
});

test('hedge top-up after a partial fill only buys the shortfall', () => {
  // Needed 4.23 in total; 2.00 already held at 0.29.
  const more = hedgeQuantity(3.0, 0.29, 2, 2 * 0.29);
  assert.equal(more, 2.23);
  assert.equal(hedgeQuantity(3.0, 0.29, 4.23, 4.23 * 0.29), 0);
});

test('no price is offered when the bet makes no sense', () => {
  assert.equal(conditionalPrice(null, 0.7), null);
  assert.equal(conditionalPrice(0.3, null), null);
  assert.equal(conditionalPrice(0.7, 0.7), null); // outcome costs as much as the condition
  assert.equal(conditionalPrice(0.8, 0.7), null);
  assert.equal(conditionalPrice(0, 0.7), null);
  assert.equal(conditionalPrice(0.3, 0), null);
  assert.equal(conditionalPrice(0.3, 1), null);
  assert.throws(() => hedgeQuantity(3, 1));
  assert.throws(() => hedgeQuantity(3, 0));
  assert.throws(() => hedgeQuantity(-1, 0.3));
});

test('step rounding is immune to floating-point noise', () => {
  assert.equal(floorToStep(0.07 / 0.01 * 0.01), 0.07);
  assert.equal(floorToStep(4.23), 4.23);
  assert.equal(ceilToStep(4.23), 4.23);
  assert.equal(ceilToStep(4.2254), 4.23);
  assert.equal(floorToStep(4.2299), 4.22);
  assert.equal(floorToStep(0.1 + 0.2), 0.3);
});

test('an unhedged position is reported as unhedged', () => {
  const p = payoffs({ quantity: 10, avgPrice: 0.3 }, { quantity: 1, avgPrice: 0.29 });
  assert.equal(p.hedged, false);
  near(p.ifConditionFails, 1 - 3.29);
  assert.equal(payoffs({ quantity: 0, avgPrice: 0 }, { quantity: 0, avgPrice: 0 }).hedged, false);
});

test('settlement pays each leg only when its side wins', () => {
  const b = { quantity: 10, avgPrice: 0.3 };
  const a = { quantity: 4.23, avgPrice: 0.29 };
  assert.equal(settlementPayout(b, a, 'no', 'no'), 4.23); // condition failed: refund
  assert.equal(settlementPayout(b, a, 'yes', 'yes'), 10); // both hit
  assert.equal(settlementPayout(b, a, 'yes', 'no'), 0); // condition only
});

const event = (contracts: Array<Partial<GeminiEvent['contracts'][number]> & { instrumentSymbol: string }>): GeminiEvent => ({
  id: '1',
  title: 'ETH price today',
  ticker: 'ETHTEST',
  category: 'Crypto',
  status: 'active',
  contracts: contracts.map((c) => ({ id: '1-1', label: c.instrumentSymbol, ticker: 't', status: 'active', marketState: 'open', ...c })),
});

test('linked pairs: only "or above" strikes, outcome above condition, and a real book', () => {
  const e = event([
    { instrumentSymbol: 'HI1820', strike: { type: 'above', value: '1820' }, prices: { bestBid: '0.11', bestAsk: '0.30' } },
    { instrumentSymbol: 'HI1800', strike: { type: 'above', value: '1800' }, prices: { bestBid: '0.71', bestAsk: '0.90' } },
    { instrumentSymbol: 'UP', strike: null, prices: { bestBid: '0.40', bestAsk: '0.50' } }, // not a ladder rung
    { instrumentSymbol: 'LO1700', strike: { type: 'below', value: '1700' }, prices: { bestBid: '0.10', bestAsk: '0.20' } },
    { instrumentSymbol: 'HI1840', strike: { type: 'above', value: '1840' }, prices: { bestBid: null, bestAsk: null } }, // empty book
    { instrumentSymbol: 'HI1860', strike: { type: 'above', value: '1860' }, marketState: 'closed', prices: { bestBid: '0.01', bestAsk: '0.05' } },
  ]);
  assert.deepEqual(ladder(e).map((r) => r.strike), [1800, 1820, 1840, 1860]);

  const all = linkedPairs(e);
  assert.equal(all.length, 6); // 4 rungs -> 6 ordered pairs
  assert.ok(all.every((p) => p.b.strike > p.a.strike));

  const tradable = linkedPairs(e, { tradableOnly: true });
  assert.equal(tradable.length, 1);
  assert.equal(tradable[0]!.a.symbol, 'HI1800');
  assert.equal(tradable[0]!.b.symbol, 'HI1820');
  near(tradable[0]!.conditionalPrice!, 0.3 / 0.71);
});

test('fees: known answers for the all-in price and the fee itself', async () => {
  const { takerFee } = await import('../src/pricing.ts');
  // 10 contracts at 0.30: 0.07 * 10 * 0.30 * 0.70 = 0.147 -> rounded up to 15 cents
  assert.equal(takerFee(10, 0.3, 0.07), 0.15);
  assert.equal(takerFee(10, 0.3, 0), 0);
  assert.equal(takerFee(0, 0.3, 0.07), 0);
  // (0.30 * (1 + 0.07*0.70)) / (0.71 * (1 - 0.07*0.29)) = 0.3147 / 0.695587
  near(conditionalPrice(0.3, 0.71, 0.07)!, 0.3147 / 0.695587, 1e-6);
  near(conditionalPrice(0.3, 0.71, 0.07)!, 0.452424, 1e-5);
  assert.ok(conditionalPrice(0.3, 0.71, 0.07)! > conditionalPrice(0.3, 0.71)!); // fees only ever make it dearer
  // a pair that is just under $1 before fees is refused once fees are added
  assert.ok(conditionalPrice(0.69, 0.7) !== null);
  assert.equal(conditionalPrice(0.69, 0.7, 0.07), null);
});

test('fees: the hedge covers the stake AND both fees at the worst allowed fill', async () => {
  const { takerFee } = await import('../src/pricing.ts');
  const c = 0.07;
  for (let pB = 0.02; pB < 0.9; pB += 0.07) {
    for (let noA = 0.05; noA < 0.9; noA += 0.09) {
      for (const qB of [0.01, 1, 7.37, 250]) {
        const costB = qB * pB + takerFee(qB, pB, c);
        const qA = hedgeQuantity(costB, noA, 0, 0, c);
        const refund = qA - (costB + qA * noA + takerFee(qA, noA, c));
        assert.ok(refund >= -1e-9, `short by ${refund} at pB=${pB} noA=${noA} qB=${qB}`);
        assert.ok(refund < 0.05, `over-hedged by ${refund}`);
      }
    }
  }
});
