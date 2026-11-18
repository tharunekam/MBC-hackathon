/**
 * A stand-in Solana node that speaks the real JSON-RPC protocol over HTTP, so the REAL chain code
 * (@solana/web3.js, transaction building, signing, sending, confirming, parsing) runs end to end without a
 * network, a faucet or any SOL.
 *
 * It is not a validator, but it applies the rules that decide whether a first real run works:
 *  - the transaction bytes are decoded and every signature is checked (a mis-signed transaction is refused);
 *  - the fee payer must hold lamports (an unfunded wallet fails the way devnet fails);
 *  - the recent blockhash must be known and not expired, and a signature cannot be processed twice;
 *  - the Memo program refuses a memo that is not valid UTF-8 or lacks the signer it lists;
 *  - responses use the shapes devnet returns (`jsonParsed`, with the `spl-memo` instruction parsed to a string).
 *
 * Fault injection for the failures that bite on a first run: `expireBlockhashes()`, `dropNext()`,
 * `rateLimitNext(n)`, `failSendNext(message)`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PublicKey, Transaction } from '@solana/web3.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const FEE = 5000;
/** Blocks a blockhash stays valid, as on the real network. */
const VALID_BLOCKS = 150;

interface StoredTx {
  signature: string;
  slot: number;
  blockTime: number;
  signer: string;
  keys: Array<{ pubkey: string; signer: boolean; writable: boolean }>;
  memo: string;
  blockhash: string;
}

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface FakeRpc {
  /** http://127.0.0.1:<port> */
  url: string;
  /** Gives an account lamports, as a faucet would. */
  fund(pubkey: string, lamports: number): void;
  balance(pubkey: string): number;
  /** Every transaction the node has processed, oldest first. */
  txs(): StoredTx[];
  /** Counts of each RPC method called, for asserting the code did not spam the node. */
  calls: Map<string, number>;
  /** Moves the chain forward so blockhashes handed out so far are no longer valid. */
  expireBlockhashes(): void;
  /** Accept the next transaction but never include it (a dropped transaction). */
  dropNext(): void;
  /** Answer the next n requests with HTTP 429. */
  rateLimitNext(n: number): void;
  /** Make the next sendTransaction fail with this simulation error. */
  failSendNext(message: string): void;
  close(): Promise<void>;
}

export async function startFakeRpc(): Promise<FakeRpc> {
  const balances = new Map<string, number>();
  const known = new Map<string, number>(); // blockhash -> last valid block height
  const txs: StoredTx[] = [];
  const bySig = new Map<string, StoredTx>();
  const calls = new Map<string, number>();
  let height = 1_000_000;
  let dropNext = false;
  let rateLimited = 0;
  let failSend: string | null = null;
  const startedAt = Date.now();
  // Time moves the chain on, about 2.5 blocks a second, plus whatever the test adds.
  let skipped = 0;
  const currentHeight = () => height + skipped + Math.floor((Date.now() - startedAt) / 400);
  const slot = () => currentHeight() + 100;

  const context = () => ({ slot: slot(), apiVersion: '2.1.0' });

  function newBlockhash(): { blockhash: string; lastValidBlockHeight: number } {
    const blockhash = base58Encode(createHash('sha256').update(randomBytes(32)).digest());
    const lastValidBlockHeight = currentHeight() + VALID_BLOCKS;
    known.set(blockhash, lastValidBlockHeight);
    return { blockhash, lastValidBlockHeight };
  }

  function simulationError(message: string, err: unknown): RpcError {
    return { code: -32002, message: `Transaction simulation failed: ${message}`, data: { accounts: null, err, logs: [], unitsConsumed: 0 } };
  }

  function sendTransaction(params: unknown[]): string {
    if (failSend) {
      const m = failSend;
      failSend = null;
      throw simulationError(m, 'Custom');
    }
    const [encoded, opts] = params as [string, { encoding?: string }?];
    if (opts?.encoding !== 'base64') throw { code: -32602, message: 'Invalid params: unsupported encoding (this node needs base64)' } satisfies RpcError;
    const raw = Buffer.from(encoded, 'base64');
    if (raw.length > 1232) throw { code: -32602, message: `Invalid params: transaction too large: ${raw.length} > 1232` } satisfies RpcError;
    let tx: Transaction;
    try {
      tx = Transaction.from(raw);
    } catch (err) {
      throw { code: -32602, message: `Invalid params: failed to deserialize transaction: ${err instanceof Error ? err.message : String(err)}` } satisfies RpcError;
    }
    if (!tx.verifySignatures()) throw { code: -32003, message: 'Transaction signature verification failure' } satisfies RpcError;
    const feePayer = tx.feePayer?.toBase58();
    if (!feePayer || !tx.signature) throw { code: -32602, message: 'Invalid params: no fee payer' } satisfies RpcError;
    const signature = base58Encode(tx.signature);
    if (bySig.has(signature)) throw simulationError('This transaction has already been processed', 'AlreadyProcessed');
    const validUntil = known.get(tx.recentBlockhash ?? '');
    if (validUntil === undefined || validUntil < currentHeight()) throw simulationError('Blockhash not found', 'BlockhashNotFound');

    const bal = balances.get(feePayer);
    if (bal === undefined) throw simulationError('Attempt to debit an account but found no record of a prior credit.', 'AccountNotFound');
    if (bal < FEE) throw simulationError('Insufficient funds for fee', { InsufficientFundsForFee: null });

    // The Memo program: valid UTF-8, and every account it lists must have signed.
    const instruction = tx.instructions[0];
    if (!instruction || tx.instructions.length !== 1 || instruction.programId.toBase58() !== MEMO_PROGRAM) {
      throw simulationError('this node only runs the Memo program', 'InvalidProgramForExecution');
    }
    let memo: string;
    try {
      memo = new TextDecoder('utf-8', { fatal: true }).decode(instruction.data);
    } catch {
      throw simulationError('Program log: Invalid UTF-8', { InstructionError: [0, 'InvalidInstructionData'] });
    }
    for (const k of instruction.keys) {
      if (!k.isSigner) throw simulationError('Program log: Missing required signature for account', { InstructionError: [0, 'MissingRequiredSignature'] });
    }

    if (dropNext) {
      dropNext = false;
      return signature; // looks accepted, never lands
    }
    balances.set(feePayer, bal - FEE);
    const stored: StoredTx = {
      signature,
      slot: slot(),
      blockTime: Math.floor(Date.now() / 1000),
      signer: feePayer,
      keys: [
        { pubkey: feePayer, signer: true, writable: true },
        ...instruction.keys.filter((k) => k.pubkey.toBase58() !== feePayer).map((k) => ({ pubkey: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })),
        { pubkey: MEMO_PROGRAM, signer: false, writable: false },
      ],
      memo,
      blockhash: tx.recentBlockhash ?? '',
    };
    txs.push(stored);
    bySig.set(signature, stored);
    return signature;
  }

  function parsedTransaction(t: StoredTx) {
    const len = Buffer.byteLength(t.memo, 'utf8');
    return {
      slot: t.slot,
      blockTime: t.blockTime,
      version: 'legacy',
      meta: {
        err: null,
        status: { Ok: null },
        fee: FEE,
        preBalances: [0, 1],
        postBalances: [0, 1],
        innerInstructions: [],
        logMessages: [`Program ${MEMO_PROGRAM} invoke [1]`, `Program log: Memo (len ${len}): ${JSON.stringify(t.memo)}`, `Program ${MEMO_PROGRAM} consumed 5000 of 200000 compute units`, `Program ${MEMO_PROGRAM} success`],
        preTokenBalances: [],
        postTokenBalances: [],
        rewards: [],
        loadedAddresses: { readonly: [], writable: [] },
        computeUnitsConsumed: 5000,
      },
      transaction: {
        signatures: [t.signature],
        message: {
          accountKeys: t.keys.map((k) => ({ pubkey: k.pubkey, signer: k.signer, writable: k.writable, source: 'transaction' })),
          recentBlockhash: t.blockhash,
          instructions: [{ program: 'spl-memo', programId: MEMO_PROGRAM, parsed: t.memo, stackHeight: null }],
        },
      },
    };
  }

  function handle(method: string, params: unknown[]): unknown {
    switch (method) {
      case 'getLatestBlockhash':
        return { context: context(), value: newBlockhash() };
      case 'getBlockHeight':
        return currentHeight();
      case 'getBalance': {
        const b = balances.get(String(params[0]));
        return { context: context(), value: b ?? 0 };
      }
      case 'sendTransaction':
        return sendTransaction(params);
      case 'getSignatureStatuses': {
        const sigs = (params[0] as string[]) ?? [];
        return {
          context: context(),
          value: sigs.map((s) => {
            const t = bySig.get(s);
            return t ? { slot: t.slot, confirmations: null, err: null, status: { Ok: null }, confirmationStatus: 'finalized' } : null;
          }),
        };
      }
      case 'getTransaction': {
        const t = bySig.get(String(params[0]));
        return t ? parsedTransaction(t) : null;
      }
      case 'getSignaturesForAddress': {
        const address = String(params[0]);
        const o = (params[1] ?? {}) as { limit?: number; before?: string };
        const mine = txs.filter((t) => t.keys.some((k) => k.pubkey === address)).reverse();
        const start = o.before ? mine.findIndex((t) => t.signature === o.before) + 1 : 0;
        return mine.slice(start, start + (o.limit ?? 1000)).map((t) => ({ signature: t.signature, slot: t.slot, err: null, memo: `[${Buffer.byteLength(t.memo)}] ${t.memo}`, blockTime: t.blockTime, confirmationStatus: 'finalized' }));
      }
      default:
        throw { code: -32601, message: `Method not found: ${method}` } satisfies RpcError;
    }
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (rateLimited > 0) {
        rateLimited--;
        res.writeHead(429, { 'content-type': 'text/plain' });
        res.end('Too Many Requests');
        return;
      }
      const reply = (body: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      let call: { id: number; method: string; params?: unknown[] } | Array<{ id: number; method: string; params?: unknown[] }>;
      try {
        call = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const run = (c: { id: number; method: string; params?: unknown[] }) => {
        calls.set(c.method, (calls.get(c.method) ?? 0) + 1);
        try {
          return { jsonrpc: '2.0', id: c.id, result: handle(c.method, c.params ?? []) };
        } catch (err) {
          const e = err as RpcError;
          return { jsonrpc: '2.0', id: c.id, error: { code: e.code ?? -32603, message: e.message ?? String(err), ...(e.data !== undefined ? { data: e.data } : {}) } };
        }
      };
      reply(Array.isArray(call) ? call.map(run) : run(call));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    fund: (pubkey, lamports) => {
      new PublicKey(pubkey); // throws on a malformed address, like the real faucet would
      balances.set(pubkey, (balances.get(pubkey) ?? 0) + lamports);
    },
    balance: (pubkey) => balances.get(pubkey) ?? 0,
    txs: () => [...txs],
    calls,
    expireBlockhashes: () => {
      skipped += VALID_BLOCKS + 10;
    },
    dropNext: () => {
      dropNext = true;
    },
    rateLimitNext: (n) => {
      rateLimited = n;
    },
    failSendNext: (message) => {
      failSend = message;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
