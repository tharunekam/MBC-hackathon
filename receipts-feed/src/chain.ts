// Talks to the given_receipts program: the service's key is fee payer and
// recorder, so users never see a wallet. Also reads the program's history back
// from RPC, for the gaps a Stream cannot fill (Solana Streams do not backfill).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  bytes32, commitHash, decodeCallAccount, encodeCommitCall, encodeInitialize, encodeRevealCall,
  type CallAccount, type CallDetails,
} from './codec.ts';
import type { StreamTx } from './logs.ts';

export const DEFAULT_PROGRAM_ID = '8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK';

/** A transaction the program rejected. `code` is the program's error name, e.g. NotExpiredYet. */
export class ChainError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.code = code;
  }
}

/** What the call service needs from the chain; tests substitute a fake. */
export interface ChainApi {
  /** Sends `commit_call`. Returns the transaction signature. */
  commit(commit: string): Promise<string>;
  /** Sends `reveal_call`. Returns the transaction signature. */
  reveal(details: CallDetails, salt: string, targetHit: boolean): Promise<string>;
  /** The call's record on chain, or null if that hash was never committed. */
  call(commit: string): Promise<CallAccount | null>;
  /** The most recent transaction that touched the call's record. */
  lastSignature(commit: string): Promise<string | null>;
}

export interface ChainOptions {
  connection: Connection;
  programId: PublicKey;
  recorder: Keypair;
}

export class Chain implements ChainApi {
  private readonly o: ChainOptions;
  private readonly config: PublicKey;

  constructor(options: ChainOptions) {
    this.o = options;
    this.config = this.pda(Buffer.from('config'));
  }

  private pda(...seeds: Buffer[]): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, this.o.programId)[0];
  }

  callAddress(commit: string): PublicKey {
    return this.pda(Buffer.from('call'), bytes32(commit, 'commit'));
  }

  statsAddress(handle: string): PublicKey {
    return this.pda(Buffer.from('caller'), Buffer.from(handle));
  }

  private async send(data: Buffer, accounts: PublicKey[]): Promise<string> {
    const me = this.o.recorder.publicKey;
    const ix = new TransactionInstruction({
      programId: this.o.programId,
      keys: [
        { pubkey: me, isSigner: true, isWritable: true },
        ...accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: !pubkey.equals(SystemProgram.programId) })),
      ],
      data,
    });
    try {
      return await sendAndConfirmTransaction(this.o.connection, new Transaction().add(ix), [this.o.recorder], {
        commitment: 'confirmed',
      });
    } catch (err) {
      const logs = (err as { logs?: string[] }).logs ?? [];
      const text = [err instanceof Error ? err.message : String(err), ...logs].join('\n');
      const code = /Error Code: (\w+)/.exec(text)?.[1] ?? null;
      const said = /Error Message: (.+?)\.?$/m.exec(text)?.[1];
      throw new ChainError(said ?? (err instanceof Error ? err.message : String(err)), code);
    }
  }

  /** Creates the program's config with this key as admin and recorder. No-op if it exists. */
  async initialize(): Promise<string | null> {
    if (await this.o.connection.getAccountInfo(this.config)) return null;
    return this.send(encodeInitialize(this.o.recorder.publicKey.toBase58()), [this.config, SystemProgram.programId]);
  }

  commit(commit: string): Promise<string> {
    return this.send(encodeCommitCall(commit), [this.config, this.callAddress(commit), SystemProgram.programId]);
  }

  reveal(details: CallDetails, salt: string, targetHit: boolean): Promise<string> {
    return this.send(encodeRevealCall({ details, salt, targetHit }), [
      this.config,
      this.callAddress(commitHash(details, salt)),
      this.statsAddress(details.handle),
      SystemProgram.programId,
    ]);
  }

  async call(commit: string): Promise<CallAccount | null> {
    const info = await this.o.connection.getAccountInfo(this.callAddress(commit));
    return info ? decodeCallAccount(info.data) : null;
  }

  async lastSignature(commit: string): Promise<string | null> {
    const found = await this.o.connection.getSignaturesForAddress(this.callAddress(commit), { limit: 1 });
    return found[0]?.signature ?? null;
  }

  /**
   * Every successful transaction of the program that `known` does not have
   * yet, oldest first, in the shape the Stream delivers.
   */
  async history(known: (signature: string) => boolean, maxPages = 20): Promise<StreamTx[]> {
    const missing: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.o.connection.getSignaturesForAddress(this.o.programId, { limit: 1000, before });
      for (const s of batch) if (!s.err && !known(s.signature)) missing.push(s.signature);
      if (batch.length < 1000) break;
      before = batch[batch.length - 1]!.signature;
    }
    const out: StreamTx[] = [];
    for (const signature of missing.reverse()) {
      const tx = await this.o.connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!tx?.meta?.logMessages || tx.meta.err) continue;
      out.push({ signature, slot: tx.slot, blockTime: tx.blockTime ?? null, logs: tx.meta.logMessages });
    }
    return out;
  }
}

/** Builds the client from the repo-root .env. Returns null when no RPC endpoint is set. */
export function chainFromEnv(env: NodeJS.ProcessEnv = process.env): Chain | null {
  const rpc = env.SOLANA_RPC_URL;
  if (!rpc) return null;
  const keypairPath = env.RECORDER_KEYPAIR ?? resolve(homedir(), '.config/solana/id.json');
  if (!existsSync(keypairPath)) throw new Error(`No recorder keypair at ${keypairPath}. Set RECORDER_KEYPAIR.`);
  return new Chain({
    connection: new Connection(rpc, 'confirmed'),
    programId: new PublicKey(env.RECEIPTS_PROGRAM_ID ?? DEFAULT_PROGRAM_ID),
    recorder: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8')) as number[])),
  });
}

// `node src/chain.ts init`: once per deployment, right after `solana program deploy`
// (the first key to call initialize becomes the admin).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  try {
    if (process.argv[2] !== 'init') throw new Error('Usage: node src/chain.ts init');
    const chain = chainFromEnv();
    if (!chain) throw new Error('Set SOLANA_RPC_URL (the QuickNode Solana endpoint).');
    const signature = await chain.initialize();
    console.log(signature ? `initialized ${signature}` : 'already initialized');
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
