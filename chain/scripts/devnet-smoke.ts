/**
 * The real thing, once, on devnet: commit a call, read it back from Solana, reveal it, index both from the chain,
 * and check the hash recomputes. Uses a synthetic bet (no executor needed) and spends about 0.00001 SOL.
 *   npm run smoke
 * Needs a funded authority (see `npm run keygen` and `npm run status`). Prints explorer links for the two records.
 */
import { SolanaChain } from '../src/chain.ts';
import { loadConfig } from '../src/config.ts';
import type { BetSource, ExecutorBet } from '../src/executor.ts';
import { loadKeypair } from '../src/keypair.ts';
import { ChainService } from '../src/service.ts';
import { Store } from '../src/store.ts';

const config = loadConfig();
const chain = new SolanaChain(config.rpcUrl, loadKeypair(config.keypairPath));
if ((await chain.balanceLamports()) === 0) {
  console.error(`The authority ${chain.authority} has no SOL. Fund it at https://faucet.solana.com and run this again.`);
  process.exit(1);
}

const bet: ExecutorBet = {
  id: `smoke${Date.now().toString(36)}`,
  user: 'primary',
  createdAt: new Date().toISOString(),
  eventTicker: 'SMOKE2611190100',
  eventTitle: 'Smoke test',
  condition: { symbol: 'GEMI-SMOKE2611190100-HI100', label: '$100 or above', strike: 100 },
  target: { symbol: 'GEMI-SMOKE2611190100-HI110', label: '$110 or above', strike: 110 },
  status: 'open',
  quotedPrice: 0.45,
  payoffs: { hedged: true, conditionalPrice: 0.45 },
  offer: { fairPrice: 0.41 },
};
const bets: BetSource = {
  assertExecutor: async () => {},
  getBet: async () => bet,
};

const service = new ChainService({ chain, store: new Store(null, () => 'smoke-secret'), bets, selfIngest: false });
const link = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const call = await service.commitCall(bet.id, 'primary');
console.log(`commit  ${link(call.commitSignature)}`);

bet.status = 'settled';
bet.settlement = { conditionResolved: 'yes', targetResolved: 'yes', payout: 1 };
const revealed = await service.revealCall(call.id, 'primary');
console.log(`reveal  ${link(revealed.reveal!.signature)}`);

// Index both the way the Stream would, from the chain alone (a fresh store knows nothing).
const fresh = new ChainService({ chain, store: new Store(null, () => 'other-secret'), bets, selfIngest: false });
console.log(`ingest commit  -> ${await fresh.ingest(call.commitSignature, 'rpc')}`);
console.log(`ingest reveal  -> ${await fresh.ingest(revealed.reveal!.signature, 'rpc')}`);
const board = fresh.leaderboard();
console.log(`leaderboard rebuilt from chain only: ${JSON.stringify(board.rows)}`);

const check = await service.verifyCall(call.id, 'primary');
console.log(`verify: hash on chain ${check.commit.hash}\n        recomputed    ${check.recomputedHash}\n        matches       ${check.matches}`);
if (!check.matches || board.rows.length !== 1) {
  console.error('SMOKE TEST FAILED');
  process.exit(1);
}
console.log('SMOKE TEST PASSED');
