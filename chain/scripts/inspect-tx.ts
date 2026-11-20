/**
 * Reads a transaction from Solana through the same code the service uses and prints what it sees.
 *   npm run inspect -- <signature>
 *   npm run inspect -- --latest        (the newest Memo-program transaction on the cluster, to check parsing)
 * Read-only: uses a throwaway key and spends nothing.
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { SolanaChain } from '../src/chain.ts';
import { loadConfig } from '../src/config.ts';
import { MEMO_PROGRAM_ID, parseMemo } from '../src/memo.ts';

const config = loadConfig();
const chain = new SolanaChain(config.rpcUrl, Keypair.generate());
let signature = process.argv[2];
if (!signature) {
  console.error('Usage: npm run inspect -- <signature> | --latest');
  process.exit(1);
}
if (signature === '--latest') {
  const sigs = await new Connection(config.rpcUrl, 'confirmed').getSignaturesForAddress(new PublicKey(MEMO_PROGRAM_ID), { limit: 10 });
  const ok = sigs.find((s) => !s.err);
  if (!ok) {
    console.error('No recent successful Memo transactions found.');
    process.exit(1);
  }
  signature = ok.signature;
}
const tx = await chain.getTx(signature);
if (!tx) {
  console.log(`No successful memo transaction found for ${signature}.`);
  process.exit(2);
}
const memo = parseMemo(tx.memo);
console.log(`signature  ${tx.signature}`);
console.log(`slot       ${tx.slot}   blockTime ${tx.blockTime === null ? 'n/a' : new Date(tx.blockTime * 1000).toISOString()}`);
console.log(`signer     ${tx.signer}`);
console.log(`memo       ${JSON.stringify(tx.memo.length > 120 ? `${tx.memo.slice(0, 120)}…` : tx.memo)}   (${Buffer.byteLength(tx.memo)} bytes)`);
console.log(`a Given record? ${memo ? `yes (${memo.t === 'c' ? 'commit' : 'reveal'})` : 'no'}`);
