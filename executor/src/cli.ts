/**
 * Command-line runner for the executor. Examples:
 *
 *   node src/cli.ts pairs                      list tradable conditional bets right now
 *   node src/cli.ts pairs ETH2611180000        ...for one event
 *   node src/cli.ts pairs --down               ...for a parlay that a price falls (the condition is the HIGHER strike)
 *   node src/cli.ts bet <event> <conditionSymbol> <targetSymbol> <stake> [--down] [--max 0.60] [--leave]
 *   node src/cli.ts range <event> <lowSymbol> <highSymbol> <stake> [--max 0.60] [--leave]   win if it finishes between the two
 *   node src/cli.ts breakout <event> <lowSymbol> <highSymbol> <stake> [--max 0.70] [--leave]   win if it finishes outside them
 *   node src/cli.ts cashout <bet>              what selling an open bet back would bring in now (sends nothing)
 *   node src/cli.ts cashout <bet> --sell [--min 3.10]   sell it back: one sell order per leg
 *   node src/cli.ts bets                       show the ledger
 *   node src/cli.ts settle                     record results for resolved bets
 *   node src/cli.ts reconcile                  check the ledger against Gemini
 *   node src/cli.ts recover                    repair bets interrupted mid-flight
 *   node src/cli.ts flow                       what Given's bets have sent to Gemini's book
 *   node src/cli.ts review                     bets Gemini settled without a clean result, and what is recorded for each
 *   node src/cli.ts resolve <bet> <paid> --note "..."   record by hand what such a bet actually paid
 *
 * `pairs --all` also lists the pairs the offer rule refuses, with the reason.
 * Do not run bet/settle/recover while the HTTP server (src/server.ts) is
 * running: both keep the ledger in memory and the last one to save wins.
 */
import { resolve } from 'node:path';
import { maxPayout, placeConditionalBet, recordReviewedPayout, recoverBets, settleBets } from './bets.ts';
import { CashOutRefused, cashOutBet, quoteCashOut } from './cashout.ts';
import type { BetRecord } from './ledger.ts';
import { loadConfig, requireUser } from './config.ts';
import { flowTotals } from './flow.ts';
import { GeminiExchange } from './exchange.ts';
import { GeminiPublic } from './gemini/rest.ts';
import { Ledger } from './ledger.ts';
import { linkedPairs, realRung } from './pairs.ts';
import { placeBreakoutBet } from './breakout-bet.ts';
import { placeRangeBet } from './range-bet.ts';
import { ensureBaseline, reconcile } from './reconcile.ts';

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
const user = flag('user') ?? 'primary';

const config = loadConfig();
const ledger = new Ledger(resolve(config.dataDir, 'ledger.json'));
const money = (x: number) => (x < 0 ? '-' : '') + '$' + Math.abs(x).toFixed(2);

const kindOf = (bet: BetRecord): string => (bet.product === 'range' || bet.product === 'breakout' ? bet.product : bet.direction === 'down' ? 'falling parlay' : 'parlay');

function printBet(bet: ReturnType<Ledger['bet']>): void {
  if (!bet) return;
  console.log(`\nBet ${bet.id} [${bet.status}]  ${kindOf(bet)}  ${bet.eventTitle} (${bet.eventTicker})`);
  console.log(`  Given "${bet.condition.label}", will "${bet.target.label}"?   quoted ${bet.quotedPrice.toFixed(3)} per $1`);
  for (const leg of bet.legs) {
    console.log(
      `  ${leg.role.padEnd(7)} ${leg.side} ${leg.outcome.toUpperCase().padEnd(3)} ${leg.symbol}  ` +
        `asked ${leg.quantityRequested} @ <=${leg.limitPrice.toFixed(2)}  filled ${leg.quantityFilled} @ ${leg.avgPrice ?? '-'}  [${leg.status}] ${leg.clientOrderId}` +
        (leg.note ? `  (${leg.note})` : ''),
    );
  }
  if (bet.payoffs) {
    const p = bet.payoffs;
    console.log(`  stake ${money(p.stake)}   paid ${p.conditionalPrice?.toFixed(4) ?? '-'} per $1   hedged: ${p.hedged ? 'yes' : 'NO'}`);
    console.log(
      p.ifConditionFails === undefined
        ? `  if inside the range: ${money(p.ifInRange ?? p.ifBothHit)}   if outside: ${money(p.ifOutside ?? p.ifConditionOnly)}`
        : `  if condition fails: ${money(p.ifConditionFails)}   if both hit: ${money(p.ifBothHit)}   if condition only: ${money(p.ifConditionOnly)}`,
    );
  }
  if (bet.stakeReduced) console.log(`  reduced: ${bet.stakeReduced.reason}`);
  if (bet.secondLegWait) {
    const w = bet.secondLegWait;
    console.log(`  second order waited ${(w.waitedMs / 1000).toFixed(1)}s for its market to open (${w.reads} re-reads): ${w.opened ? 'it opened' : 'it did NOT open'}`);
  }
  if (bet.offer) {
    const o = bet.offer;
    console.log(
      `  offer rule: ${o.verdict}${o.overridden ? ' (waived for sandbox demo)' : ''}   fair ${o.fairPrice?.toFixed(3) ?? '-'}   ` +
        `with production fees ${o.allInPrice?.toFixed(3) ?? '-'}   markup ${o.markup?.toFixed(3) ?? '-'}`,
    );
  }
  if (bet.review) console.log(`  NEEDS REVIEW: ${bet.review.reason}`);
  if (bet.review?.resolved) console.log(`  RECORDED BY HAND: paid ${money(bet.review.resolved.payout)}, result ${money(bet.review.resolved.pnl)} (${bet.review.resolved.note})`);
  if (bet.settlement) {
    const s = bet.settlement;
    console.log(`  SETTLED condition=${s.conditionResolved} target=${s.targetResolved}  payout ${money(s.payout)}  result ${money(s.pnl)}`);
  }
  if (bet.cashOut) {
    const c = bet.cashOut;
    console.log(`  CASHED OUT${c.complete ? '' : ' (in part)'}  cost ${money(c.stake)}  sold for ${money(c.proceeds)}  result ${money(c.pnl)}`);
  }
  if (bet.note) console.log(`  note: ${bet.note}`);
}

async function main(): Promise<void> {
  if (command === 'pairs') {
    const pub = new GeminiPublic(config.baseUrl);
    const events = args[1] && !args[1].startsWith('--') ? [await pub.getEvent(args[1])] : await pub.listEvents('active');
    let shown = 0;
    let refused = 0;
    const c = (x: number | null, digits = 3) => (x === null ? '-' : x.toFixed(digits));
    const direction = has('down') ? 'down' : 'up';
    for (const event of events) {
      const all = linkedPairs(event, { feeCoef: config.takerFeeCoef, waiveMarkup: config.waiveMarkup, direction });
      const pairs = has('all') ? all : all.filter((p) => p.offer.offerable);
      refused += all.filter((p) => !p.offer.offerable).length;
      if (pairs.length === 0) continue;
      console.log(`\n${event.title}  (${event.ticker}, expires ${event.expiryDate ?? '?'})`);
      for (const p of pairs) {
        const o = p.offer;
        if (o.offerable) shown++;
        const verdict = o.overridden ? 'REFUSED (waived for sandbox demo)' : o.verdict.toUpperCase();
        const [a, b] = [realRung(p.a, direction), realRung(p.b, direction)];
        console.log(
          (direction === 'down' ? `  given it stays below ${a.strike} [${a.bid}/${a.ask}]  ->  falls below ${b.strike} [${b.bid}/${b.ask}]   ` : `  given ${a.label} [${a.bid}/${a.ask}]  ->  ${b.label} [${b.bid}/${b.ask}]   `) +
            `pay ${c(o.pricePaid)}  fair ${c(o.fairPrice)}  with prod fees ${c(o.allInPrice)}  markup ${c(o.markup)}  ` +
            `cash-out/$100 ${c(o.cashOutPer100, 2)}  ${verdict}   ${a.symbol} ${b.symbol}` +
            (o.reasons.length > 0 ? `\n      why: ${o.reasons.map((r) => r.message).join(' ')}` : ''),
        );
      }
    }
    console.log(`\n${shown} conditional bets on offer, ${refused} refused by the offer rule, across ${events.length} events.`);
    return;
  }

  if (command === 'flow') {
    console.log(JSON.stringify(flowTotals(ledger, flag('user')), null, 2));
    return;
  }

  if (command === 'bets') {
    for (const bet of ledger.data.bets) printBet(bet);
    console.log(`\n${ledger.data.bets.length} bets in ${ledger.path}`);
    return;
  }

  if (command === 'review') {
    // Bets Gemini settled without a clean yes/no. Until someone records what each paid, the cash check is off by it.
    const flagged = ledger.data.bets.filter((b) => b.status === 'needs_review');
    for (const bet of flagged) {
      const r = bet.review?.resolved;
      console.log(`\nBet ${bet.id}  ${bet.eventTitle} (${bet.eventTicker})   cost ${money(bet.cost)}   could have paid at most ${money(maxPayout(bet))}`);
      console.log(`  ${bet.review?.reason ?? ''}`);
      console.log(r ? `  recorded by hand: paid ${money(r.payout)}, result ${money(r.pnl)} (${r.note})` : `  nothing recorded yet. After reading the account:  node src/cli.ts resolve ${bet.id} <dollars paid> --note "where the number came from"`);
    }
    console.log(`\n${flagged.length} bet(s) settled without a clean result, ${flagged.filter((b) => !b.review?.resolved).length} still to be recorded.`);
    return;
  }

  if (command === 'resolve') {
    const [, betId, amount] = args;
    const note = flag('note');
    if (!betId || amount === undefined || amount.startsWith('--') || !note) {
      console.log('Usage: node src/cli.ts resolve <betId> <dollars paid> --note "where the number came from" [--server http://127.0.0.1:8741]');
      console.log('Records what Gemini actually paid for a bet it settled without a clean result (see: node src/cli.ts review).');
      process.exitCode = 1;
      return;
    }
    const server = flag('server');
    if (server) {
      // A running executor holds the ledger in memory, so the change has to go through it.
      if (!config.adminToken) throw new Error('GIVEN_ADMIN_TOKEN is not set here. It must match the running executor\'s.');
      const res = await fetch(`${server.replace(/\/+$/, '')}/review`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': config.adminToken }, body: JSON.stringify({ betId, payout: Number(amount), note }) });
      const body = (await res.json().catch(() => null)) as { error?: string; review?: { resolved?: { payout: number; pnl: number } } } | null;
      if (!res.ok) throw new Error(`The executor refused (HTTP ${res.status}): ${body?.error ?? 'no reason given'}`);
      console.log(`Recorded on the running executor: bet ${betId} paid ${money(body?.review?.resolved?.payout ?? Number(amount))}, result ${money(body?.review?.resolved?.pnl ?? 0)}.`);
    } else {
      const bet = recordReviewedPayout(ledger, betId, Number(amount), note);
      console.log(`Recorded: bet ${bet.id} paid ${money(bet.review!.resolved!.payout)}, result ${money(bet.review!.resolved!.pnl)}.`);
      console.log('If an executor is running it still has the old ledger in memory: stop it first, or use --server.');
    }
    console.log('Check the cash now ties out:  node src/cli.ts reconcile   (or the Proof page).');
    return;
  }

  const exchange = new GeminiExchange(config, requireUser(config, user));
  try {
    if (command === 'bet') {
      const [, eventTicker, conditionSymbol, targetSymbol, stake] = args;
      if (!eventTicker || !conditionSymbol || !targetSymbol || !stake) {
        throw new Error('Usage: bet <event> <conditionSymbol> <targetSymbol> <stake> [--down] [--max price] [--leave] [--slip ticks]');
      }
      await ensureBaseline(exchange, ledger, user);
      const bet = await placeConditionalBet(
        { exchange, ledger, feeCoef: config.takerFeeCoef, waiveMarkup: config.waiveMarkup, secondLegWaitMs: config.secondLegWaitMs },
        {
          user,
          eventTicker,
          conditionSymbol,
          targetSymbol,
          direction: has('down') ? 'down' : 'up',
          stake: Number(stake),
          maxPrice: flag('max') ? Number(flag('max')) : undefined,
          slippageTicks: flag('slip') ? Number(flag('slip')) : undefined,
          onHedgeFail: has('leave') ? 'leave' : 'unwind',
        },
      );
      printBet(bet);
    } else if (command === 'range' || command === 'breakout') {
      const [, eventTicker, lowSymbol, highSymbol, stake] = args;
      if (!eventTicker || !lowSymbol || !highSymbol || !stake) {
        throw new Error(`Usage: ${command} <event> <lowSymbol> <highSymbol> <stake> [--max price] [--leave] [--slip ticks]`);
      }
      await ensureBaseline(exchange, ledger, user);
      const bet = await (command === 'breakout' ? placeBreakoutBet : placeRangeBet)(
        { exchange, ledger, feeCoef: config.takerFeeCoef, waiveMarkup: config.waiveMarkup, secondLegWaitMs: config.secondLegWaitMs },
        {
          user,
          eventTicker,
          lowSymbol,
          highSymbol,
          stake: Number(stake),
          maxPrice: flag('max') ? Number(flag('max')) : undefined,
          slippageTicks: flag('slip') ? Number(flag('slip')) : undefined,
          onFail: has('leave') ? 'leave' : 'unwind',
        },
      );
      printBet(bet);
    } else if (command === 'cashout') {
      const bet = ledger.bet(args[1] ?? '');
      if (!bet) throw new Error('Usage: cashout <bet> [--sell] [--min dollars] [--slip ticks]   (bet ids: node src/cli.ts bets)');
      const deps = { exchange, ledger, feeCoef: config.takerFeeCoef };
      if (!has('sell')) {
        const q = await quoteCashOut(deps, bet);
        for (const l of q.legs) {
          console.log(`  ${l.role.padEnd(7)} sell ${l.outcome.toUpperCase().padEnd(3)} ${l.symbol}  holds ${l.quantity}  best price ${l.price ?? '-'}  wanted there ${l.available ?? '-'}`);
        }
        console.log(
          q.proceeds === null
            ? `  cost ${money(q.stake)}   no price to sell at`
            : `  cost ${money(q.stake)}   sells for ${money(q.proceeds)} now (${money(q.proceedsAtProductionFees ?? q.proceeds)} at production fees)   result ${money(q.pnl ?? 0)}`,
        );
        console.log(q.available ? '  Can be sold now. Add --sell to do it.' : `  Cannot be sold now [${q.code}]: ${q.reason}`);
      } else {
        try {
          printBet(await cashOutBet(deps, bet, { minProceeds: flag('min') ? Number(flag('min')) : undefined, slippageTicks: flag('slip') ? Number(flag('slip')) : undefined }));
        } catch (err) {
          if (!(err instanceof CashOutRefused)) throw err;
          console.log(`Not sold [${err.code}]: ${err.message}`);
          process.exitCode = 1;
        }
      }
    } else if (command === 'settle') {
      const done = await settleBets({ exchange, ledger, feeCoef: config.takerFeeCoef });
      for (const bet of [...done.settled, ...done.needsReview]) printBet(bet);
      console.log(`\n${done.settled.length} bet(s) settled, ${done.needsReview.length} flagged for review, ${done.called.length} sold-back bet(s) given their call's result.`);
    } else if (command === 'recover') {
      console.log(`${await recoverBets({ exchange, ledger, feeCoef: config.takerFeeCoef })} order(s) repaired.`);
    } else if (command === 'reconcile') {
      await ensureBaseline(exchange, ledger, user);
      const r = await reconcile(exchange, ledger, user);
      console.log(JSON.stringify(r, null, 2));
      process.exitCode = r.ok ? 0 : 1;
    } else {
      console.log('Commands: pairs [event] [--all] [--down] | bet ... [--down] | range ... | breakout ... | cashout <bet> [--sell] | bets | settle | recover | reconcile | flow | review | resolve <bet> <paid> --note "..."');
      process.exitCode = 1;
    }
  } finally {
    exchange.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
