import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Keypair } from '@solana/web3.js';

/** Reads a keypair in the Solana CLI's format: a JSON array of the 64 secret-key bytes. */
export function loadKeypair(path: string): Keypair {
  if (!existsSync(path)) throw new Error(`No authority keypair at ${path}. Run: npm run keygen`);
  const bytes: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`${path} is not a 64-byte Solana keypair.`);
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}

/** Creates a new keypair file readable only by the owner. Never overwrites an existing one. */
export function createKeypairFile(path: string): { created: boolean; publicKey: string } {
  if (existsSync(path)) return { created: false, publicKey: loadKeypair(path).publicKey.toBase58() };
  mkdirSync(dirname(path), { recursive: true });
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { created: true, publicKey: kp.publicKey.toBase58() };
}
