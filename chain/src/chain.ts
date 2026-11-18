/**
 * The only code that touches Solana. Everything else talks to the `Chain` interface,
 * so the service is tested against an in-memory chain and run against devnet.
 */
import { randomBytes } from 'node:crypto';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { MEMO_PROGRAM_ID } from './memo.ts';

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

export interface Chain {
  readonly network: 'devnet' | 'fake';
  /** Public key of the authority that signs and pays for every record. */
  readonly authority: string;
  sendMemo(text: string): Promise<{ signature: string; slot: number }>;
  /** A confirmed, successful transaction carrying a memo, or null (missing, failed, or no memo). */
  getTx(signature: string): Promise<ChainTx | null>;
  /** Signatures of confirmed, successful transactions that involve the authority, newest first. */
  recentSignatures(limit: number, before?: string): Promise<string[]>;
  /** Lamports, or null when unknown. */
  balanceLamports(): Promise<number | null>;
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
    return this.forge(text, this.authority);
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

export class SolanaChain implements Chain {
  readonly network = 'devnet' as const;
  readonly authority: string;
  private readonly connection: Connection;
  private readonly keypair: Keypair;
  private readonly memoProgram = new PublicKey(MEMO_PROGRAM_ID);

  constructor(rpcUrl: string, keypair: Keypair) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.keypair = keypair;
    this.authority = keypair.publicKey.toBase58();
  }

  async sendMemo(text: string): Promise<{ signature: string; slot: number }> {
    const instruction = new TransactionInstruction({
      // The Memo program requires every listed account to sign; the authority is the only one.
      keys: [{ pubkey: this.keypair.publicKey, isSigner: true, isWritable: false }],
      programId: this.memoProgram,
      data: Buffer.from(text, 'utf8'),
    });
    const signature = await sendAndConfirmTransaction(this.connection, new Transaction().add(instruction), [this.keypair], { commitment: 'confirmed' });
    const status = (await this.connection.getSignatureStatuses([signature])).value[0];
    return { signature, slot: status?.slot ?? 0 };
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
