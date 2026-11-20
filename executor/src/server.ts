/**
 * Starts the HTTP API for the frontend:  node src/server.ts
 *
 * Listens on 127.0.0.1 by default (this process holds trading keys), on GIVEN_PORT
 * (default 8787). GIVEN_HOST can widen that, but only with a pinned user, a stake
 * cap and a rate limit on the Gemini sandbox; otherwise the server refuses to start. Keeps ONE long-lived Gemini session per configured user and
 * reuses it for every request.
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createApi } from './api.ts';
import { recoverBets } from './bets.ts';
import { isLoopback, loadConfig, requireUser } from './config.ts';
import type { Config } from './config.ts';
import { GeminiExchange } from './exchange.ts';
import type { Exchange } from './exchange.ts';
import { GeminiPublic } from './gemini/rest.ts';
import { Ledger } from './ledger.ts';
import { createLiveHub } from './live.ts';
import { ReadOnlyExchange } from './readonly.ts';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  // A setting that is wrong (a stake cap of "$25", say) is reported plainly and nothing is started.
  console.error(`Refusing to start. ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// A network-facing executor holds trading keys. It must be sandbox-only and must not let the browser pick the account or the size.
if (!isLoopback(config.host)) {
  const missing: string[] = [];
  if (!config.isSandbox) missing.push('the Gemini sandbox (production is not allowed on a network address)');
  if (!config.pinnedUser) missing.push('GIVEN_PINNED_USER');
  if (!config.maxStake) missing.push('GIVEN_MAX_STAKE');
  if (!config.rateLimitPerMin) missing.push('GIVEN_RATE_LIMIT_PER_MIN');
  if (missing.length > 0) {
    console.error(`Refusing to listen on ${config.host}. A network-facing executor needs: ${missing.join(', ')}.`);
    process.exit(1);
  }
}
const pausedFile = resolve(config.dataDir, 'PAUSED');
const ledger = new Ledger(resolve(config.dataDir, 'ledger.json'));
const pub = new GeminiPublic(config.baseUrl);
// GIVEN_READONLY=1: real prices and order books with no account. One stand-in user, no keys, every order refused.
const readOnlyExchange = config.readOnly ? new ReadOnlyExchange(config.baseUrl, config.wsUrl) : null;
const users = config.readOnly ? ['primary'] : config.users.map((u) => u.user);

/** One exchange session per user, created on first use and kept for the life of the process. */
const sessions = new Map<string, GeminiExchange>();
function exchangeFor(user: string): Exchange {
  if (readOnlyExchange) return readOnlyExchange;
  let session = sessions.get(user);
  if (!session) {
    session = new GeminiExchange(config, requireUser(config, user));
    sessions.set(user, session);
  }
  return session;
}

const live = createLiveHub();
const api = createApi({
  ledger,
  users,
  exchangeFor,
  isConnected: (user) => sessions.get(user)?.connected ?? false,
  readOnly: config.readOnly,
  live,
  quoteCacheMs: 1500,
  autoSettleMs: config.autoSettleMs,
  markets: { listEvents: () => pub.listEvents('active'), getEvent: (ticker) => pub.getEvent(ticker) },
  isSandbox: config.isSandbox,
  feeCoef: config.takerFeeCoef,
  waiveMarkup: config.waiveMarkup,
  secondLegWaitMs: config.secondLegWaitMs,
  seeded: config.seeded,
  corsOrigins: config.corsOrigins,
  pinnedUser: config.pinnedUser ?? undefined,
  adminToken: config.adminToken ?? undefined,
  maxStake: config.maxStake ?? undefined,
  isPaused: () => existsSync(pausedFile), // creating executor/data/PAUSED stops new bets at once; deleting it resumes
  rateLimit: config.rateLimitPerMin ? { max: config.rateLimitPerMin, windowMs: 60_000 } : undefined,
  trustProxy: config.trustProxy,
});

// Before taking requests: repair anything a previous run left half-done, each bet on its own user's account.
for (const user of config.readOnly ? [] : users) {
  try {
    const fixed = await recoverBets({ exchange: exchangeFor(user), ledger, feeCoef: config.takerFeeCoef }, user);
    if (fixed > 0) console.log(`Repaired ${fixed} order(s) for "${user}" left unfinished by a previous run.`);
  } catch (err) {
    console.error(`Could not check "${user}" for unfinished orders: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const server = createServer(api);
server.on('error', (err) => {
  console.error(`Could not start the server: ${err.message}`);
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  console.log(`Given executor API on http://${config.host}:${config.port}  (${config.isSandbox ? 'Gemini SANDBOX' : 'Gemini PRODUCTION'})`);
  console.log(`Accounts: ${config.readOnly ? 'none (READ-ONLY: real prices, no orders)' : users.join(', ') || 'none configured'}   fee coefficient charged: ${config.takerFeeCoef}`);
  if (!config.readOnly && users.length === 0) console.warn('No Gemini keys found in .env. Quotes will fail and nothing can be traded. For real prices without keys, set GIVEN_READONLY=1.');
  if (config.waiveMarkup) console.log('Sandbox demo mode: pairs refused only for markup can be traded (GIVEN_SANDBOX_WAIVE_MARKUP=1).');
  if (config.secondLegWaitMs > 0) console.log(`Second-order wait ON: up to ${config.secondLegWaitMs}ms for a post-only contract to open before a bet is sold back (GIVEN_SECOND_LEG_WAIT_MS). Run "node src/cli.ts reconcile" after the first bets placed with it.`);

  // Open each user's session now rather than on the first bet.
  for (const user of config.readOnly ? [] : users) {
    (exchangeFor(user) as GeminiExchange)
      .connect()
      .then(() => console.log(`Connected to Gemini for "${user}".`))
      .catch((err: unknown) => console.error(`Could not connect to Gemini for "${user}": ${err instanceof Error ? err.message : String(err)}`));
  }
});

function shutdown(): void {
  api.close();
  live.close();
  for (const session of sessions.values()) session.close();
  readOnlyExchange?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
