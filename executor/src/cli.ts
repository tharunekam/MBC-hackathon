/**
 * Command-line runner for the executor. Examples:
 *
 *   node src/cli.ts pairs                      list tradable conditional bets right now
 *   node src/cli.ts pairs ETH2611180000        ...for one event
 *   node src/cli.ts bet <event> <conditionSymbol> <targetSymbol> <stake> [--max 0.60] [--leave]
 *   node src/cli.ts bets                       show the ledger
 *   node src/cli.ts settle                     record results for resolved bets
 *   node src/cli.ts reconcile                  check the ledger against Gemini
 *   node src/cli.ts recover                    repair bets interrupted mid-flight
 */
import { resolve } from 'node:path';
import { placeConditionalBet, recoverBets, settleBets } from './bets.ts';
import { loadConfig, requireUser } from './config.ts';
import { GeminiExchange } from './exchange.ts';
import { GeminiPublic } from './gemini/rest.ts';
import { Ledger } from './ledger.ts';
import { linkedPairs } from './pairs.ts';
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

function printBet(bet: ReturnType<Ledger['bet']>): void {
  if (!bet) return;
  console.log(`\nBet ${bet.id} [${bet.status}]  ${bet.eventTitle} (${bet.eventTicker})`);
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
    console.log(`  if condition fails: ${money(p.ifConditionFails)}   if both hit: ${money(p.ifBothHit)}   if condition only: ${money(p.ifConditionOnly)}`);
  }
  if (bet.settlement) {
    const s = bet.settlement;
    console.log(`  SETTLED condition=${s.conditionResolved} target=${s.targetResolved}  payout ${money(s.payout)}  result ${money(s.pnl)}`);
  }
  if (bet.note) console.log(`  note: ${bet.note}`);
}

async function main(): Promise<void> {
  if (command === 'pairs') {
    const pub = new GeminiPublic(config.baseUrl);
    const events = args[1] && !args[1].startsWith('--') ? [await pub.getEvent(args[1])] : await pub.listEvents('active');
    let shown = 0;
    for (const event of events) {
      const pairs = linkedPairs(event, { tradableOnly: true });
      if (pairs.length === 0) continue;
      console.log(`\n${event.title}  (${event.ticker}, expires ${event.expiryDate ?? '?'})`);
      for (const p of pairs) {
        shown++;
        console.log(
          `  given ${p.a.label} [bid ${p.a.bid}]  ->  ${p.b.label} [ask ${p.b.ask}]   ${p.conditionalPrice!.toFixed(3)} per $1   ${p.a.symbol} ${p.b.symbol}`,
        );
      }
    }
    console.log(`\n${shown} tradable conditional bets across ${events.length} events.`);
    return;
  }

  if (command === 'bets') {
    for (const bet of ledger.data.bets) printBet(bet);
    console.log(`\n${ledger.data.bets.length} bets in ${ledger.path}`);
    return;
  }

  const exchange = new GeminiExchange(config, requireUser(config, user));
  try {
    if (command === 'bet') {
      const [, eventTicker, conditionSymbol, targetSymbol, stake] = args;
      if (!eventTicker || !conditionSymbol || !targetSymbol || !stake) {
        throw new Error('Usage: bet <event> <conditionSymbol> <targetSymbol> <stake> [--max price] [--leave] [--slip ticks]');
      }
      await ensureBaseline(exchange, ledger, user);
      const bet = await placeConditionalBet(
        { exchange, ledger },
        {
          user,
          eventTicker,
          conditionSymbol,
          targetSymbol,
          stake: Number(stake),
          maxPrice: flag('max') ? Number(flag('max')) : undefined,
          slippageTicks: flag('slip') ? Number(flag('slip')) : undefined,
          onHedgeFail: has('leave') ? 'leave' : 'unwind',
        },
      );
      printBet(bet);
    } else if (command === 'settle') {
      const done = await settleBets({ exchange, ledger });
      for (const bet of done) printBet(bet);
      console.log(`\n${done.length} bet(s) settled.`);
    } else if (command === 'recover') {
      console.log(`${await recoverBets({ exchange, ledger })} order(s) repaired.`);
    } else if (command === 'reconcile') {
      await ensureBaseline(exchange, ledger, user);
      const r = await reconcile(exchange, ledger, user);
      console.log(JSON.stringify(r, null, 2));
      process.exitCode = r.ok ? 0 : 1;
    } else {
      console.log('Commands: pairs [event] | bet ... | bets | settle | recover | reconcile');
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
