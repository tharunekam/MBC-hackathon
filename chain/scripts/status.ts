/**
 * Shows the authority key, its devnet balance and whether the RPC answers.   npm run status
 */
import { SolanaChain } from '../src/chain.ts';
import { loadConfig } from '../src/config.ts';
import { loadKeypair } from '../src/keypair.ts';

const config = loadConfig();
const kp = loadKeypair(config.keypairPath);
const chain = new SolanaChain(config.rpcUrl, kp);
console.log(`RPC        ${new URL(config.rpcUrl).hostname}`);
console.log(`Authority  ${chain.authority}`);
try {
  const lamports = await chain.balanceLamports();
  const sol = (lamports ?? 0) / 1e9;
  console.log(`Balance    ${sol} SOL${sol === 0 ? '   <- unfunded: use https://faucet.solana.com' : ''}`);
} catch (err) {
  console.error(`RPC error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
