/**
 * The real thing, once, on devnet: commit a call, read it back from Solana, reveal it, index both from the chain,
 * and check the hash recomputes. Uses a synthetic bet (no executor needed) and spends about 0.00001 SOL.
 * With GIVEN_PROGRAM_ID set it also checks the program's side: its record of the call before and after the reveal,
 * its refusal of a changed reveal, and its running score (about 0.004 SOL more, for the two accounts it creates).
 *   npm run smoke
 * Needs a funded authority (see `npm run keygen` and `npm run status`). Prints explorer links for the two records.
 */
import { SolanaChain } from '../src/chain.ts';
import { loadConfig } from '../src/config.ts';
import type { BetSource, ExecutorBet } from '../src/executor.ts';
import { loadKeypair } from '../src/keypair.ts';
import { encode } from '../src/memo.ts';
import { ChainService } from '../src/service.ts';
import { Store } from '../src/store.ts';

const config = loadConfig();
const chain = new SolanaChain(config.rpcUrl, loadKeypair(config.keypairPath), config.programId);
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
  // A call can only be sealed while its market is still open (with 90 seconds to spare), so this stand-in market closes an
  // hour from now instead of at the time written into its code.
  expiry: new Date(Date.now() + 60 * 60_000).toISOString(),
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

if (chain.program) {
  await chain.assertProgram().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
  console.log(`program ${chain.program} checks each record`);
}
const store = new Store(null, () => 'smoke-secret');
const service = new ChainService({ chain, store, bets, selfIngest: false });
let failed = false;
const expect = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};
// Why the program turned a transaction down, from the error the RPC reports. Null: it failed for some other reason.
const REASONS: Record<string, string> = { bc4: 'no committed record matches these fields', '1773': 'already revealed', '1774': 'hash mismatch' };
const refusal = (text: string): Promise<string | null> =>
  chain.sendMemo(text).then(
    () => null,
    (err: unknown) => {
      const code = /custom program error: 0x([0-9a-f]+)/i.exec(String(err instanceof Error ? err.message : err))?.[1]?.toLowerCase();
      return code ? (REASONS[code] ?? `program error 0x${code}`) : null;
    },
  );
const link = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const call = await service.commitCall(bet.id, 'primary');
console.log(`commit  ${link(call.commitSignature)}`);
const row = store.data.calls.find((c) => c.id === call.id)!;
if (chain.program) {
  const held = await chain.programCall(row.hash);
  expect(held?.state === 'committed' && held.hash === row.hash && held.fairPrice === null, 'the program holds the hash and nothing about the trade');
  // A reveal that lowers the fair price would score higher. It hashes to something that was never committed.
  const f = row.fields;
  const changed = encode({ g: 1, t: 'r', c: row.commitSignature, u: row.handle, b: f.betId, e: f.event, k: f.condition, x: f.target, p: f.entryPrice, f: f.fairPrice - 0.2, at: f.at, s: row.salt, o: 1 });
  const why = await refusal(changed);
  expect(why !== null, `the program refuses a reveal whose fair price was changed, and its Memo with it (${why})`);
}

bet.status = 'settled';
bet.settlement = { conditionResolved: 'yes', targetResolved: 'yes', payout: 1 };
const revealed = await service.revealCall(call.id, 'primary');
console.log(`reveal  ${link(revealed.reveal!.signature)}`);
if (chain.program) {
  const held = await chain.programCall(row.hash);
  expect(held?.state === 'revealed' && held.outcome === 1 && held.edge === revealed.reveal!.edge, `the program scored the call itself: edge ${held?.edge}`);
  const again = encode({ g: 1, t: 'r', c: row.commitSignature, u: row.handle, b: row.fields.betId, e: row.fields.event, k: row.fields.condition, x: row.fields.target, p: row.fields.entryPrice, f: row.fields.fairPrice, at: row.fields.at, s: row.salt, o: 0 });
  const whyNot = await refusal(again);
  expect(whyNot !== null, `the program refuses a second reveal that would flip the result (${whyNot})`);
  const score = (await chain.programScores()).find((s) => s.handle === row.handle);
  expect(score !== undefined && score.calls >= 1, `the program's running score for ${row.handle}: ${score?.calls} call(s), edge ${score?.edge}`);
}

// Index both the way the Stream would, from the chain alone (a fresh store knows nothing).
const fresh = new ChainService({ chain, store: new Store(null, () => 'other-secret'), bets, selfIngest: false });
console.log(`ingest commit  -> ${await fresh.ingest(call.commitSignature, 'rpc')}`);
console.log(`ingest reveal  -> ${await fresh.ingest(revealed.reveal!.signature, 'rpc')}`);
const board = fresh.leaderboard();
console.log(`leaderboard rebuilt from chain only: ${JSON.stringify(board.rows)}`);

const check = await service.verifyCall(call.id, 'primary');
console.log(`verify: hash on chain ${check.commit.hash}\n        recomputed    ${check.recomputedHash}\n        matches       ${check.matches}`);
if (failed || !check.matches || board.rows.length !== 1) {
  console.error('SMOKE TEST FAILED');
  process.exit(1);
}
console.log('SMOKE TEST PASSED');
