/**
 * A crash drill against a real Solana node, with the program on:  npm run drill
 *
 * The unit tests cover "the transaction landed but we never recorded it" on an in-memory chain. This does it for real:
 * it commits and reveals a synthetic call through given_receipts, makes the service forget each one the way a crash
 * between sending and saving would, cuts off the authority's transaction history (as a rate-limited RPC does), and
 * asks again. The service must find each record through the call's own account, adopt it, and send nothing twice,
 * because the program would refuse a second commit or a second reveal.
 *
 * Needs GIVEN_PROGRAM_ID and a funded authority, like `npm run smoke`. Costs about 0.004 SOL. Against a local
 * validator:  SOLANA_RPC_URL=http://127.0.0.1:8899 GIVEN_PROGRAM_ID=<id> GIVEN_CHAIN_KEYPAIR=<key> npm run drill
 */
import { SolanaChain } from '../src/chain.ts';
import { loadConfig } from '../src/config.ts';
import type { BetSource, ExecutorBet } from '../src/executor.ts';
import { loadKeypair } from '../src/keypair.ts';
import { ChainService } from '../src/service.ts';
import { Store } from '../src/store.ts';

/** The real chain, with a switch that makes the authority's history unreadable. */
class Drill extends SolanaChain {
  historyDown = false;
  override async recentSignatures(limit: number, before?: string): Promise<string[]> {
    if (this.historyDown) throw new Error('history unavailable (drill)');
    return super.recentSignatures(limit, before);
  }
}

const config = loadConfig();
if (!config.programId) {
  console.error('GIVEN_PROGRAM_ID is not set. This drill is about the program; without it use `npm run smoke`.');
  process.exit(1);
}
const chain = new Drill(config.rpcUrl, loadKeypair(config.keypairPath), config.programId);
try {
  await chain.assertProgram();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
if (!(await chain.balanceLamports())) {
  console.error(`The authority ${chain.authority} has no SOL.`);
  process.exit(1);
}

const bet: ExecutorBet = {
  id: `drill${Date.now().toString(36)}`,
  user: 'primary',
  createdAt: new Date().toISOString(),
  eventTicker: 'DRILL2611190100',
  eventTitle: 'Recovery drill',
  condition: { symbol: 'GEMI-DRILL2611190100-HI100', label: '$100 or above', strike: 100 },
  target: { symbol: 'GEMI-DRILL2611190100-HI110', label: '$110 or above', strike: 110 },
  status: 'open',
  quotedPrice: 0.45,
  payoffs: { hedged: true, conditionalPrice: 0.45 },
  offer: { fairPrice: 0.41 },
};
const bets: BetSource = { assertExecutor: async () => {}, getBet: async () => bet };
const store = new Store(null, () => 'drill-secret');
const service = new ChainService({ chain, store, bets, selfIngest: false, log: () => {} });

let failed = false;
const expect = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};
// How many transactions the authority has sent since the drill began: the ones newer than the newest one before it.
const history = (limit: number) => SolanaChain.prototype.recentSignatures.call(chain, limit);
const marker = (await history(1))[0];
const sent = async (): Promise<number> => {
  const recent = await history(25);
  const at = marker ? recent.indexOf(marker) : recent.length;
  return at < 0 ? recent.length : at;
};

// ---- a commit that landed and was forgotten
const first = await service.commitCall(bet.id, 'primary');
const row = store.data.calls.find((c) => c.id === first.id)!;
console.log(`commit  ${first.commitSignature}`);
row.state = 'pending';
row.commitSignature = '';
delete store.data.commits[first.commitSignature];
chain.historyDown = true;
const again = await service.commitCall(bet.id, 'primary').catch(() => null);
expect(again !== null && again.state === 'committed' && again.commitSignature === first.commitSignature, 'a forgotten commit is found through the call\'s own account and adopted, with history unreadable');
chain.historyDown = false;
expect((await sent()) === 1, 'exactly one commit was sent');

// ---- a reveal that landed and was forgotten
bet.status = 'settled';
bet.settlement = { conditionResolved: 'yes', targetResolved: 'yes', payout: 1 };
const revealed = await service.revealCall(first.id, 'primary');
console.log(`reveal  ${revealed.reveal!.signature}`);
row.state = 'committed';
row.revealing = true;
delete row.reveal;
delete store.data.reveals[revealed.reveal!.signature];
chain.historyDown = true;
const revealedAgain = await service.revealCall(first.id, 'primary').catch(() => null);
expect(
  revealedAgain !== null && revealedAgain.state === 'revealed' && revealedAgain.reveal?.signature === revealed.reveal!.signature,
  'a forgotten reveal is found the same way and adopted',
);
chain.historyDown = false;
expect((await sent()) === 2, 'exactly one commit and one reveal were sent in all');
const held = await chain.programCall(row.hash);
expect(held?.state === 'revealed' && held.outcome === 1, 'the program holds one revealed call');

if (failed) {
  console.error('RECOVERY DRILL FAILED');
  process.exit(1);
}
console.log('RECOVERY DRILL PASSED');
