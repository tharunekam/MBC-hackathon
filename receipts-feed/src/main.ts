// The chain service: `node src/main.ts`. Settings come from the repo-root .env,
// the same convention as the executor; README.md lists them.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executorSource, ledgerSource } from './bets.ts';
import { CallService, CallStore } from './calls.ts';
import { DEFAULT_PROGRAM_ID, chainFromEnv } from './chain.ts';
import { buildLeaderboard, decodeReceipt } from './receipts.ts';
import { createFeedServer, ingest } from './server.ts';
import { ReceiptStore, type Receipt } from './store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;

function required(name: string): string {
  const v = env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}
const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const dataFile = (name: string, fallback: string): string => resolve(here, '..', env[name] ?? fallback);

const programId = env.RECEIPTS_PROGRAM_ID ?? DEFAULT_PROGRAM_ID;
const port = Number(env.RECEIPTS_FEED_PORT ?? 8788);
const publicPort = Number(env.RECEIPTS_PUBLIC_PORT ?? 8789);
const store = new ReceiptStore(dataFile('RECEIPTS_FILE', 'data/receipts.jsonl'));
const feed = { programId, store, decode: decodeReceipt };
const chain = chainFromEnv();
const calls = new CallService({
  store: new CallStore(dataFile('CALLS_FILE', 'data/calls.json'), env.GIVEN_HANDLE_SALT),
  chain,
  bets: env.GIVEN_LEDGER ? ledgerSource(resolve(env.GIVEN_LEDGER)) : executorSource(env.GIVEN_EXECUTOR_URL ?? 'http://127.0.0.1:8787'),
  log: console.log,
});
const minCalls = Number(env.LEADERBOARD_MIN_CALLS ?? 3);

const server = {
  ...feed,
  securityToken: required('QUICKNODE_STREAM_TOKEN'),
  score: (receipts: Receipt[]) => buildLeaderboard(receipts, { minCalls }),
  calls,
  defaultUser: env.GIVEN_DEFAULT_USER,
  corsOrigins: list(env.GIVEN_CORS_ORIGINS),
};
// Two listeners. The full API stays on this machine, like the executor's. The
// one a tunnel or proxy exposes takes the Stream and serves public reads only.
createFeedServer(server).listen(port, env.CHAIN_BIND ?? '127.0.0.1', () => {
  console.log(`chain service listening on :${port} (${store.size} receipts loaded, Solana ${chain ? 'connected' : 'not configured'})`);
});
createFeedServer({ ...server, publicOnly: true }).listen(publicPort, env.CHAIN_PUBLIC_BIND ?? '127.0.0.1', () => {
  console.log(`public listener (Stream webhook, leaderboard) on :${publicPort}`);
});

if (chain) {
  try {
    const signature = await chain.initialize();
    if (signature) console.log(`initialized the program config ${signature}`);
    // A Stream cannot replay what happened before it started or while this was down.
    const missed = await chain.history((signature) => store.hasSignature(signature));
    const added = ingest({ txs: missed }, feed, 'rpc');
    if (added) console.log(`read ${added} events the Stream had not delivered from RPC`);
  } catch (err) {
    console.error(`Solana start-up check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const autoCommit = env.CHAIN_AUTOCOMMIT !== '0';
  const autoRevealUsers = new Set(list(env.CHAIN_AUTOREVEAL_USERS));
  if (autoCommit || autoRevealUsers.size > 0) {
    const everyMs = Number(env.CHAIN_POLL_MS ?? 5000);
    let warned = false;
    for (;;) {
      try {
        await calls.sync({ autoCommit, autoRevealUsers });
        warned = false;
      } catch (err) {
        if (!warned) console.error(`cannot read bets, will keep trying: ${err instanceof Error ? err.message : String(err)}`);
        warned = true;
      }
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }
}
