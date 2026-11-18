/**
 * Recording by hand what Gemini paid for a bet it settled without a clean yes/no. The point of it is the cash check:
 * until someone records the amount, the ledger and the account differ by exactly what was paid.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ReviewError, isScorable, maxPayout, placeConditionalBet, recordReviewedPayout, settleBets } from '../src/bets.ts';
import { Ledger } from '../src/ledger.ts';
import { ensureBaseline, reconcile } from '../src/reconcile.ts';
import { FakeExchange } from './fake.ts';

const TIGHT = [
  { strike: 1800, bid: 0.8, ask: 0.82 },
  { strike: 1820, bid: 0.4, ask: 0.41 },
];
const AFTER = () => new Date('2026-11-18T00:05:00Z');
const NOTE = 'Gemini account history 2026-11-18: condition settled at 0.60, target no';

/** A $10 bet whose condition Gemini then settles at 60 cents a contract instead of yes or no. */
async function flagged() {
  const exchange = new FakeExchange('ETHTEST', TIGHT);
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-review-')), 'ledger.json'));
  let n = 0;
  const deps = { exchange, ledger, newId: () => `t${++n}`, now: () => new Date('2026-11-17T23:10:00Z'), waiveMarkup: false };
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeConditionalBet(deps, { user: 'primary', eventTicker: 'ETHTEST', conditionSymbol: exchange.symbol(1800), targetSymbol: exchange.symbol(1820), stake: 10, slippageTicks: 0 });
  exchange.settleUnclear(1800, { resolutionSide: null, settlementValue: '1799.99' }, 0.6);
  exchange.resolve(1820, 'no');
  await settleBets({ ...deps, now: AFTER });
  assert.equal(bet.status, 'needs_review');
  const hedge = bet.legs.find((l) => l.outcome === 'no')!.quantityFilled;
  return { exchange, ledger, deps, bet, paid: Math.round(hedge * 0.6 * 100) / 100 };
}

const refused = (fn: () => unknown, code: ReviewError['code']) => assert.throws(fn, (e: unknown) => e instanceof ReviewError && e.code === code);

test('the cash check is off by what Gemini paid until it is recorded, and ties out once it is', async () => {
  const { exchange, ledger, bet, paid } = await flagged();
  const before = await reconcile(exchange, ledger, 'primary');
  assert.equal(before.ok, false);
  assert.ok(Math.abs(before.cashDifference! - paid) < 0.006, `off by ${before.cashDifference}, paid ${paid}`);
  assert.deepEqual(before.betsNeedingReview, [bet.id]);
  assert.deepEqual(before.betsResolvedByHand, []);

  const recorded = recordReviewedPayout(ledger, bet.id, paid, NOTE, AFTER);
  assert.equal(recorded.review!.resolved!.payout, paid);
  assert.ok(Math.abs(recorded.review!.resolved!.pnl - (paid - bet.cost)) < 1e-9);
  assert.equal(recorded.review!.resolved!.note, NOTE);
  assert.equal(recorded.review!.resolved!.recordedAt, '2026-11-18T00:05:00.000Z');

  const after = await reconcile(exchange, ledger, 'primary');
  assert.ok(Math.abs(after.cashDifference!) < 0.006, `still off by ${after.cashDifference}`);
  assert.equal(after.ok, true);
  assert.deepEqual(after.betsNeedingReview, []);
  assert.deepEqual(after.betsResolvedByHand, [bet.id]);
});

test('a payout recorded by hand never makes the bet scorable: it says what was paid, not whether the call was right', async () => {
  const { ledger, bet, paid } = await flagged();
  recordReviewedPayout(ledger, bet.id, paid, NOTE);
  assert.equal(bet.status, 'needs_review');
  assert.equal(bet.settlement, undefined);
  assert.equal(isScorable(bet), false);
});

test('it survives a restart, and a wrong amount can be corrected', async () => {
  const { exchange, ledger, bet, paid } = await flagged();
  recordReviewedPayout(ledger, bet.id, 1, 'first reading, wrong');
  assert.equal((await reconcile(exchange, ledger, 'primary')).ok, false, 'a wrong amount does not tie out');
  recordReviewedPayout(ledger, bet.id, paid, NOTE);
  const reloaded = new Ledger(ledger.path);
  assert.equal(reloaded.bet(bet.id)!.review!.resolved!.payout, paid);
  assert.equal(reloaded.bet(bet.id)!.review!.resolved!.note, NOTE);
  assert.equal((await reconcile(exchange, reloaded, 'primary')).ok, true);
});

test('refused: an unknown bet, a bet that is not under review, an impossible amount, no explanation', async () => {
  const { ledger, deps, exchange, bet } = await flagged();
  refused(() => recordReviewedPayout(ledger, 'nope', 1, NOTE), 'unknown_bet');
  refused(() => recordReviewedPayout(ledger, bet.id, -1, NOTE), 'bad_payout');
  refused(() => recordReviewedPayout(ledger, bet.id, Number.NaN, NOTE), 'bad_payout');
  refused(() => recordReviewedPayout(ledger, bet.id, '5' as unknown as number, NOTE), 'bad_payout');
  // every contract it holds, at a dollar each, is the most it could ever have paid
  const most = maxPayout(bet);
  assert.ok(most > 0);
  refused(() => recordReviewedPayout(ledger, bet.id, most + 0.5, NOTE), 'bad_payout');
  recordReviewedPayout(ledger, bet.id, most, NOTE); // the most is allowed
  refused(() => recordReviewedPayout(ledger, bet.id, 1, ''), 'bad_note');
  refused(() => recordReviewedPayout(ledger, bet.id, 1, 'ok'), 'bad_note');
  refused(() => recordReviewedPayout(ledger, bet.id, 1, 'x'.repeat(301)), 'bad_note');

  // an ordinary open bet cannot be given a payout
  const open = new FakeExchange('ETHTEST', TIGHT);
  const other = await placeConditionalBet({ ...deps, exchange: open }, { user: 'primary', eventTicker: 'ETHTEST', conditionSymbol: open.symbol(1800), targetSymbol: open.symbol(1820), stake: 5, slippageTicks: 0 });
  assert.equal(other.status, 'open');
  refused(() => recordReviewedPayout(ledger, other.id, 1, NOTE), 'not_in_review');
  void exchange;
});

test('if Gemini later reports a clean result, the computed payout replaces the hand-recorded one and is not counted twice', async () => {
  const exchange = new FakeExchange('ETHTEST', TIGHT);
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'given-review-')), 'ledger.json'));
  let n = 0;
  const deps = { exchange, ledger, newId: () => `t${++n}`, now: () => new Date('2026-11-17T23:10:00Z'), waiveMarkup: false };
  await ensureBaseline(exchange, ledger, 'primary');
  const bet = await placeConditionalBet(deps, { user: 'primary', eventTicker: 'ETHTEST', conditionSymbol: exchange.symbol(1800), targetSymbol: exchange.symbol(1820), stake: 10, slippageTicks: 0 });
  exchange.settleUnclear(1800, { resolutionSide: 'UNSPECIFIED' });
  exchange.settleUnclear(1820, { resolutionSide: 'UNSPECIFIED' });
  await settleBets({ ...deps, now: AFTER });
  assert.equal(bet.status, 'needs_review');
  recordReviewedPayout(ledger, bet.id, 0, 'account shows nothing paid yet');

  exchange.resolve(1800, 'yes');
  exchange.resolve(1820, 'no');
  const done = await settleBets({ ...deps, now: AFTER });
  assert.equal(done.settled.length, 1);
  assert.equal(bet.status, 'settled');
  assert.equal(bet.review?.resolved, undefined);
  assert.match(bet.note ?? '', /replaced a payout of \$0\.00 recorded by hand/);
  assert.equal(isScorable(bet), true);
  const rec = await reconcile(exchange, ledger, 'primary');
  assert.deepEqual(rec.betsResolvedByHand, []);
  assert.deepEqual(rec.betsNeedingReview, []);
  // the fake exchange paid nothing for the unclear settlement, so only the settlement payout may be counted
  const counted = rec.expectedCash! - (rec.baselineCash! - bet.cost);
  assert.ok(Math.abs(counted - bet.settlement!.payout) < 0.006, `counted ${counted}, settlement ${bet.settlement!.payout}`);
  assert.equal(new Ledger(ledger.path).bet(bet.id)!.review?.resolved, undefined, 'and it stays gone after a restart');
});
