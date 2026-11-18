/**
 * The only code that touches Solana. Everything else talks to the `Chain` interface,
 * so the service is tested against an in-memory chain and run against devnet.
 */
import { randomBytes } from 'node:crypto';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { MEMO_PROGRAM_ID } from './memo.ts';
import { callAddress, decodeCallAccount, decodeStatsAccount, instructionFor, statsFilters } from './program.ts';
import type { CallAccount, StatsAccount } from './program.ts';

export interface ChainTx {
  signature: string;
  slot: number;
  /** Unix seconds, when the cluster reports it. */
  blockTime: number | null;
  /** The memo text of the (first) Memo-program instruction. */
  memo: string;
  /** The fee payer / first signer. */
  signer: string;
}

/** Why a write to Solana failed, so callers never have to match on message wording. */
export class ChainError extends Error {
  readonly kind: 'unfunded' | 'refused' | 'unconfirmed' | 'too_large';
  constructor(kind: ChainError['kind'], message: string) {
    super(message);
    this.name = 'ChainError';
    this.kind = kind;
  }
}

export interface Chain {
  readonly network: 'devnet' | 'fake';
  /** Public key of the authority that signs and pays for every record. */
  readonly authority: string;
  /** The given_receipts program checking each record in the same transaction, when one is configured. */
  readonly program?: string;
  sendMemo(text: string): Promise<{ signature: string; slot: number }>;
  /** A confirmed, successful transaction carrying a memo, or null (missing, failed, or no memo). */
  getTx(signature: string): Promise<ChainTx | null>;
  /** Signatures of confirmed, successful transactions that involve the authority, newest first. */
  recentSignatures(limit: number, before?: string): Promise<string[]>;
  /** Lamports, or null when unknown. */
  balanceLamports(): Promise<number | null>;
  /**
   * Signatures of the successful transactions that touched one call's own on-chain record, oldest first, when the
   * chain keeps one (the program does: one account per call, found from the commit hash). Empty when there is no
   * record. Lets the service learn in one lookup whether a commit or reveal it lost track of did land, however long
   * ago. Anyone can mention an account in a transaction, so each signature still has to be read and verified.
   */
  recordsFor?(hashHex: string): Promise<string[]>;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fakeSignature = (): string => Array.from(randomBytes(88), (b) => B58[b % B58.length]).join('');

/** An in-memory chain for tests and for running the stack without any SOL. Its signatures are not real. */
export class FakeChain implements Chain {
  readonly network = 'fake' as const;
  readonly authority: string;
  readonly txs: ChainTx[] = [];
  /** Make the next sendMemo fail (e.g. out of funds). */
  failNext: string | null = null;
  /** Make the next sendMemo LAND on the chain and then fail, as a timeout or a lost reply does. */
  landThenFailNext: string | null = null;
  private slot = 1000;

  constructor(authority = 'FakeAuthority1111111111111111111111111111111') {
    this.authority = authority;
  }

  async sendMemo(text: string): Promise<{ signature: string; slot: number }> {
    if (this.failNext) {
      const message = this.failNext;
      this.failNext = null;
      throw new Error(message);
    }
    const landed = this.forge(text, this.authority);
    if (this.landThenFailNext) {
      const message = this.landThenFailNext;
      this.landThenFailNext = null;
      throw new Error(message);
    }
    return landed;
  }

  /** Adds a transaction as if `signer` had sent it. Lets tests simulate other people writing memos. */
  forge(text: string, signer: string): { signature: string; slot: number } {
    const signature = fakeSignature();
    const slot = ++this.slot;
    this.txs.push({ signature, slot, blockTime: Math.floor(Date.now() / 1000), memo: text, signer });
    return { signature, slot };
  }

  async getTx(signature: string): Promise<ChainTx | null> {
    return this.txs.find((t) => t.signature === signature) ?? null;
  }

  async recentSignatures(limit: number, before?: string): Promise<string[]> {
    const mine = this.txs.filter((t) => t.signer === this.authority).map((t) => t.signature).reverse();
    const start = before ? mine.indexOf(before) + 1 : 0;
    return mine.slice(start, start + limit);
  }

  async balanceLamports(): Promise<number | null> {
    return null;
  }
}

/** Minimal base58 decoder, used only if the RPC returns the memo instruction undecoded. */
function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('not base58');
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

export interface SolanaChainOptions {
  /** How often to ask the node whether the transaction landed (ms). */
  pollMs?: number;
  /** Give up waiting for one send after this long (ms). The outcome is then unknown, so nothing is retried. */
  confirmTimeoutMs?: number;
  /** Sends allowed when a blockhash expires before the transaction lands. */
  attempts?: number;
}

const isBlockhashError = (message: string): boolean => /blockhash not found|block height exceeded/i.test(message);
const isUnfundedError = (message: string): boolean => /no record of a prior credit|AccountNotFound|insufficient funds|InsufficientFunds/i.test(message);

export class SolanaChain implements Chain {
  readonly network = 'devnet' as const;
  readonly authority: string;
  private readonly connection: Connection;
  private readonly keypair: Keypair;
  private readonly memoProgram = new PublicKey(MEMO_PROGRAM_ID);
  private readonly pollMs: number;
  private readonly confirmTimeoutMs: number;
  private readonly attempts: number;
  private readonly receipts: PublicKey | null;
  readonly program?: string;

  /** `programId`: the deployed given_receipts program. Without it, records are Memos only. */
  constructor(rpcUrl: string, keypair: Keypair, programId?: string, options: SolanaChainOptions = {}) {
    // No WebSocket: confirmation is polled over plain HTTP, which public RPCs and proxies handle far more reliably.
    this.connection = new Connection(rpcUrl, { commitment: 'confirmed' });
    this.keypair = keypair;
    this.authority = keypair.publicKey.toBase58();
    this.pollMs = options.pollMs ?? 500;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? 60_000;
    this.attempts = options.attempts ?? 3;
    this.receipts = programId ? new PublicKey(programId) : null;
    if (this.receipts) this.program = this.receipts.toBase58();
  }

  /** The instructions of one record: the Memo, and beside it the program's check when a program is configured. */
  instructions(text: string): TransactionInstruction[] {
    const memo = new TransactionInstruction({
      // The Memo program requires every listed account to sign; the authority is the only one.
      keys: [{ pubkey: this.keypair.publicKey, isSigner: true, isWritable: false }],
      programId: this.memoProgram,
      data: Buffer.from(text, 'utf8'),
    });
    const check = this.receipts ? instructionFor(this.receipts, this.keypair.publicKey, text) : null;
    return check ? [memo, check] : [memo];
  }

  /** Throws unless the configured program is deployed on this cluster. */
  async assertProgram(): Promise<void> {
    if (!this.receipts) return;
    const info = await this.connection.getAccountInfo(this.receipts, 'confirmed');
    if (!info?.executable) throw new Error(`GIVEN_PROGRAM_ID ${this.program} is not a deployed program on this cluster.`);
  }

  /** The program's own record of one call, by its commit hash. Null if there is none (or no program). */
  async programCall(hashHex: string): Promise<CallAccount | null> {
    if (!this.receipts) return null;
    const info = await this.connection.getAccountInfo(callAddress(this.receipts, this.keypair.publicKey, hashHex), 'confirmed');
    return info ? decodeCallAccount(info.data) : null;
  }

  async recordsFor(hashHex: string): Promise<string[]> {
    if (!this.receipts) return [];
    const address = callAddress(this.receipts, this.keypair.publicKey, hashHex);
    if (!(await this.connection.getAccountInfo(address, 'confirmed'))) return [];
    // The commit created this account and a reveal, if any, changed it. A handful of signatures at most.
    const rows = await this.connection.getSignaturesForAddress(address, { limit: 25 }, 'confirmed');
    return rows.filter((r) => !r.err).map((r) => r.signature).reverse();
  }

  /** Each handle's running score as the program holds it, read from its accounts alone. Empty without a program. */
  async programScores(): Promise<StatsAccount[]> {
    if (!this.receipts) return [];
    const accounts = await this.connection.getProgramAccounts(this.receipts, { commitment: 'confirmed', filters: statsFilters(this.keypair.publicKey) });
    return accounts.map((a) => decodeStatsAccount(a.account.data)).filter((s): s is StatsAccount => s !== null);
  }

  async sendMemo(text: string): Promise<{ signature: string; slot: number }> {
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: this.keypair.publicKey, blockhash, lastValidBlockHeight }).add(...this.instructions(text));
      let wire: Buffer;
      try {
        tx.sign(this.keypair);
        wire = tx.serialize();
      } catch {
        throw new ChainError('too_large', `A ${Buffer.byteLength(text, 'utf8')}-byte memo does not fit in one Solana transaction (the limit is about 566 bytes).`);
      }
      let signature: string;
      try {
        signature = await this.connection.sendRawTransaction(wire, { preflightCommitment: 'confirmed', maxRetries: 5 });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isBlockhashError(message) && attempt < this.attempts) continue;
        if (isUnfundedError(message)) {
          throw new ChainError('unfunded', `The authority ${this.authority} has no SOL on devnet, so it cannot pay to record a call. Fund it at https://faucet.solana.com (network: devnet).`);
        }
        throw new ChainError('refused', `Solana refused the transaction: ${message.slice(0, 300)}`);
      }
      const landed = await this.waitToLand(signature, lastValidBlockHeight);
      if (landed) return landed;
      // The blockhash expired, so this transaction can never land; a fresh attempt cannot double-write.
    }
    throw new ChainError('unconfirmed', `Solana did not confirm the transaction after ${this.attempts} attempts. Check the network and try again.`);
  }

  /** Polls until the transaction is confirmed (returns it), or its blockhash expires (returns null). Throws if it fails or the wait times out. */
  private async waitToLand(signature: string, lastValidBlockHeight: number): Promise<{ signature: string; slot: number } | null> {
    const deadline = Date.now() + this.confirmTimeoutMs;
    for (;;) {
      const status = (await this.connection.getSignatureStatuses([signature])).value[0];
      if (status?.err) throw new ChainError('refused', `Solana accepted the transaction but it failed: ${JSON.stringify(status.err)}`);
      if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return { signature, slot: status.slot };
      if ((await this.connection.getBlockHeight('confirmed')) > lastValidBlockHeight) return null;
      if (Date.now() > deadline) throw new ChainError('unconfirmed', `Solana did not confirm ${signature} within ${Math.round(this.confirmTimeoutMs / 1000)}s; it may still land, so check it before retrying.`);
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  async getTx(signature: string): Promise<ChainTx | null> {
    const tx = await this.connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta?.err) return null;
    let memo: string | null = null;
    for (const ix of tx.transaction.message.instructions) {
      if (ix.programId.toBase58() !== MEMO_PROGRAM_ID) continue;
      if ('parsed' in ix && typeof ix.parsed === 'string') memo = ix.parsed;
      else if ('data' in ix) memo = base58Decode(ix.data).toString('utf8');
      break;
    }
    if (memo === null) return null;
    const signer = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey.toBase58();
    if (!signer) return null;
    return { signature, slot: tx.slot, blockTime: tx.blockTime ?? null, memo, signer };
  }

  async recentSignatures(limit: number, before?: string): Promise<string[]> {
    const rows = await this.connection.getSignaturesForAddress(this.keypair.publicKey, { limit, before }, 'confirmed');
    return rows.filter((r) => !r.err).map((r) => r.signature);
  }

  async balanceLamports(): Promise<number | null> {
    return this.connection.getBalance(this.keypair.publicKey, 'confirmed');
  }
}
