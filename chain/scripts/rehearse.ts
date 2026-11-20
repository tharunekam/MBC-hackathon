/**
 * Dress rehearsal of the day the wallet is funded:   npm run rehearse
 *
 * Starts a stand-in Solana node (test/fake-rpc.ts), funds the REAL authority key on it, then runs the exact commands
 * you will run against devnet (`npm run status`, `npm run smoke`) with only the RPC address changed. If this passes,
 * the only thing left between you and a real commit is SOL in the wallet.
 *
 * It spends nothing and touches no network. It does not prove devnet itself (rate limits, real confirmation times).
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { loadKeypair } from '../src/keypair.ts';
import { startFakeRpc } from '../test/fake-rpc.ts';

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const authority = loadKeypair(config.keypairPath).publicKey.toBase58();
const rpc = await startFakeRpc();
rpc.fund(authority, 1_000_000_000);

let failed = false;
for (const script of ['status.ts', 'devnet-smoke.ts']) {
  console.log(`\n$ node scripts/${script}   (SOLANA_RPC_URL=${rpc.url})`);
  // Async on purpose: the stand-in node lives in THIS process, so blocking here would starve it.
  const code = await new Promise<number | null>((done) => spawn(process.execPath, [resolve(here, script)], { stdio: 'inherit', env: { ...process.env, SOLANA_RPC_URL: rpc.url } }).on('close', done));
  if (code !== 0) failed = true;
}
console.log(`\nAuthority ${authority} made ${rpc.txs().length} records on the stand-in node.`);
await rpc.close();
if (failed) {
  console.error('REHEARSAL FAILED');
  process.exit(1);
}
console.log('REHEARSAL PASSED. Fund the wallet on devnet, then run: npm run status && npm run smoke');
