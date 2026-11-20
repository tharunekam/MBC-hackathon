/**
 * Creates the authority keypair at chain/data/authority.json (git-ignored, owner-only).
 * Prints the PUBLIC key only. Never overwrites an existing key.
 *   npm run keygen
 */
import { loadConfig } from '../src/config.ts';
import { createKeypairFile } from '../src/keypair.ts';

const config = loadConfig();
const { created, publicKey } = createKeypairFile(config.keypairPath);
console.log(created ? 'Created a new authority keypair.' : 'An authority keypair already exists; left untouched.');
console.log(`Public key: ${publicKey}`);
console.log('');
console.log('This wallet pays the ~0.000005 SOL fee for each record, so 1 devnet SOL covers about 200,000 of them.');
console.log(`Fund it on devnet yourself (the Solana faucet asks that AI agents not use it): https://faucet.solana.com  -> paste the public key above.`);
console.log('Then check it with: npm run status');
