// Writes a receipt on Solana for every conditional call in the executor's
// ledger, and settles it once Gemini has resolved the bet. The chain is the
// source of truth for what is already recorded, so this can be stopped,
// restarted or run twice without duplicating anything.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { decodeReceiptAccount, encodeInitialize, encodeRecordCall, encodeSettleCall } from './codec.ts';
import { recordArgs, settleArgs, type LedgerBet } from './ledger-map.ts';

export const DEFAULT_PROGRAM_ID = '8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK';

export interface RecorderOptions {
  connection: Connection;
  programId: PublicKey;
  recorder: Keypair;
  /** Leaderboard handle -> wallet address. Handles without one are attributed to the recorder's key. */
  wallets?: Record<string, string>;
  log?: (line: string) => void;
}

export interface SyncResult {
  recorded: Array<{ betId: string; signature: string }>;
  settled: Array<{ betId: string; signature: string }>;
  skipped: Array<{ betId: string; reason: string }>;
}

export class Recorder {
  private readonly o: RecorderOptions;
  private readonly config: PublicKey;
  /** Bets whose receipt is already settled on chain: nothing left to do. */
  private readonly done = new Set<string>();
  private readonly reported = new Set<string>();

  constructor(options: RecorderOptions) {
    this.o = options;
    this.config = PublicKey.findProgramAddressSync([Buffer.from('config')], options.programId)[0];
  }

  receiptAddress(betId: string): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from('call'), Buffer.from(betId)], this.o.programId)[0];
  }

  private send(ix: TransactionInstruction): Promise<string> {
    return sendAndConfirmTransaction(this.o.connection, new Transaction().add(ix), [this.o.recorder], {
      commitment: 'confirmed',
    });
  }

  /** Creates the program's config with this key as admin and recorder. No-op if it exists. */
  async initialize(): Promise<string | null> {
    if (await this.o.connection.getAccountInfo(this.config)) return null;
    const me = this.o.recorder.publicKey;
    return this.send(
      new TransactionInstruction({
        programId: this.o.programId,
        keys: [
          { pubkey: me, isSigner: true, isWritable: true },
          { pubkey: this.config, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: encodeInitialize(me.toBase58()),
      }),
    );
  }

  async sync(bets: LedgerBet[]): Promise<SyncResult> {
    const out: SyncResult = { recorded: [], settled: [], skipped: [] };
    const me = this.o.recorder.publicKey;
    for (const bet of bets) {
      if (this.done.has(bet.id)) continue;
      const mapped = recordArgs(bet, this.o.wallets?.[bet.user] ?? me.toBase58());
      if (!mapped.ok) {
        const key = `${bet.id}:${mapped.reason}`;
        if (!this.reported.has(key)) out.skipped.push({ betId: bet.id, reason: mapped.reason });
        this.reported.add(key);
        continue;
      }
      const receipt = this.receiptAddress(bet.id);
      const existing = await this.o.connection.getAccountInfo(receipt);
      let settledOnChain = existing ? decodeReceiptAccount(existing.data).status === 'settled' : false;

      if (!existing) {
        const signature = await this.send(
          new TransactionInstruction({
            programId: this.o.programId,
            keys: [
              { pubkey: me, isSigner: true, isWritable: true },
              { pubkey: this.config, isSigner: false, isWritable: true },
              { pubkey: receipt, isSigner: false, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: encodeRecordCall(mapped.args),
          }),
        );
        out.recorded.push({ betId: bet.id, signature });
        this.o.log?.(`recorded ${bet.id} (${bet.user}) ${signature}`);
      }

      const settle = settleArgs(bet);
      if (settle && !settledOnChain) {
        const signature = await this.send(
          new TransactionInstruction({
            programId: this.o.programId,
            keys: [
              { pubkey: me, isSigner: true, isWritable: false },
              { pubkey: this.config, isSigner: false, isWritable: true },
              { pubkey: receipt, isSigner: false, isWritable: true },
            ],
            data: encodeSettleCall(settle),
          }),
        );
        out.settled.push({ betId: bet.id, signature });
        this.o.log?.(`settled  ${bet.id} (${bet.user}) ${signature}`);
        settledOnChain = true;
      }
      if (settledOnChain) this.done.add(bet.id);
    }
    return out;
  }
}

export function readLedgerBets(path: string): LedgerBet[] {
  if (!existsSync(path)) return [];
  return ((JSON.parse(readFileSync(path, 'utf8')) as { bets?: LedgerBet[] }).bets ?? []);
}

async function main(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const envFile = resolve(repoRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const command = process.argv[2] ?? 'watch';
  const rpc = process.env.SOLANA_RPC_URL;
  if (!rpc) throw new Error('Set SOLANA_RPC_URL (the QuickNode Solana endpoint).');
  const keypairPath = process.env.RECORDER_KEYPAIR ?? resolve(homedir(), '.config/solana/id.json');
  if (!existsSync(keypairPath)) throw new Error(`No recorder keypair at ${keypairPath}. Set RECORDER_KEYPAIR.`);
  const recorder = new Recorder({
    connection: new Connection(rpc, 'confirmed'),
    programId: new PublicKey(process.env.RECEIPTS_PROGRAM_ID ?? DEFAULT_PROGRAM_ID),
    recorder: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8')) as number[])),
    wallets: process.env.GIVEN_WALLETS ? (JSON.parse(process.env.GIVEN_WALLETS) as Record<string, string>) : undefined,
    log: console.log,
  });
  const ledgerPath = process.env.GIVEN_LEDGER ?? resolve(repoRoot, 'executor/data/ledger.json');

  if (command === 'init') {
    const signature = await recorder.initialize();
    console.log(signature ? `initialized ${signature}` : 'already initialized');
    return;
  }
  const pass = async () => {
    const result = await recorder.sync(readLedgerBets(ledgerPath));
    for (const s of result.skipped) console.log(`skipped  ${s.betId}: ${s.reason}`);
    return result;
  };
  if (command === 'sync') {
    const r = await pass();
    console.log(`${r.recorded.length} recorded, ${r.settled.length} settled`);
    return;
  }
  if (command !== 'watch') throw new Error(`Unknown command "${command}". Use init, sync or watch.`);
  const intervalMs = Number(process.env.RECORDER_INTERVAL_MS ?? 5000);
  console.log(`watching ${ledgerPath} every ${intervalMs} ms`);
  for (;;) {
    try {
      await pass();
    } catch (err) {
      console.error(`sync failed, will retry: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
