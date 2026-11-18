/**
 * Starts the chain service:  node src/server.ts
 *
 * GIVEN_CHAIN=devnet (default) writes real Memo transactions from the authority key in chain/data/authority.json.
 * GIVEN_CHAIN=fake keeps an in-memory chain, so the whole stack runs with no SOL; its signatures are not real.
 * Listens on 127.0.0.1:8742 by default. A network address needs a rate limit and a webhook secret.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { FakeChain, SolanaChain } from './chain.ts';
import type { Chain } from './chain.ts';
import { isLoopback, loadConfig } from './config.ts';
import { ExecutorClient, ServiceError } from './executor.ts';
import { createHandler } from './http.ts';
import { loadKeypair } from './keypair.ts';
import { ChainService } from './service.ts';
import { Store } from './store.ts';

const config = loadConfig();

if (!isLoopback(config.host)) {
  const missing: string[] = [];
  if (!config.rateLimitPerMin) missing.push('GIVEN_RATE_LIMIT_PER_MIN');
  if (!config.hookToken && !config.qnSecurityToken) missing.push('GIVEN_HOOK_TOKEN or QN_SECURITY_TOKEN');
  if (config.hookInsecure) missing.push('GIVEN_HOOK_INSECURE unset');
  if (missing.length > 0) {
    console.error(`Refusing to listen on ${config.host}. A network-facing chain service needs: ${missing.join(', ')}.`);
    process.exit(1);
  }
}

let chain: Chain;
try {
  chain = config.network === 'fake' ? new FakeChain() : new SolanaChain(config.rpcUrl, loadKeypair(config.keypairPath));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const executor = new ExecutorClient(config.executorUrl);
try {
  await executor.assertExecutor();
} catch (err) {
  if (err instanceof ServiceError && err.code === 'not_the_executor') {
    console.error(`${err.message} Set GIVEN_EXECUTOR_URL to the right address.`);
    process.exit(1);
  }
  console.warn(`The executor at ${config.executorUrl} is not reachable yet; bets will be looked up once it is.`);
}

const store = new Store(config.network === 'fake' ? null : resolve(config.dataDir, 'calls.json'), () => randomBytes(32).toString('hex'));
const service = new ChainService({
  chain,
  store,
  bets: executor,
  authorities: [chain.authority, ...config.extraAuthorities],
  minCalls: config.minCalls,
  selfIngest: config.selfIngest,
});

let cachedBalance: { at: number; value: number | null } = { at: 0, value: null };
const balance = async () => {
  if (Date.now() - cachedBalance.at > 30_000) cachedBalance = { at: Date.now(), value: await chain.balanceLamports().catch(() => null) };
  return cachedBalance.value;
};

const server = createServer(
  createHandler({
    service,
    user: config.user,
    corsOrigins: config.corsOrigins,
    hook: { token: config.hookToken, qnSecurityToken: config.qnSecurityToken, insecure: config.hookInsecure },
    adminToken: config.adminToken,
    rateLimit: config.rateLimitPerMin ? { max: config.rateLimitPerMin, windowMs: 60_000 } : undefined,
    trustProxy: config.trustProxy,
    balance,
  }),
);
server.on('error', (err) => {
  console.error(`Could not start the server: ${err.message}`);
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  console.log(`Given chain service on http://${config.host}:${config.port}  (${config.network === 'fake' ? 'FAKE in-memory chain' : `Solana devnet via ${new URL(config.rpcUrl).hostname}`})`);
  console.log(`Authority ${chain.authority}   executor ${config.executorUrl}   serving user "${config.user}"`);
  if (!config.hookToken && !config.qnSecurityToken && !config.hookInsecure) console.log('No webhook secret set: Stream deliveries will be refused until GIVEN_HOOK_TOKEN is set.');
  if (config.hookInsecure) console.log('GIVEN_HOOK_INSECURE=1: webhook deliveries are NOT authenticated. Local testing only.');
});

let timer: NodeJS.Timeout | undefined;
if (config.backfillMs > 0) {
  const run = () =>
    service.backfill().then(
      (r) => r.added > 0 && console.log(`Backfill added ${r.added} record(s) the Stream had not delivered.`),
      (e: unknown) => console.error(`Backfill failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  timer = setInterval(run, config.backfillMs);
  timer.unref();
  void run();
}

function shutdown(): void {
  if (timer) clearInterval(timer);
  void service.idle().then(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
