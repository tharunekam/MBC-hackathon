import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const EXECUTOR_ROOT = resolve(here, '..');
export const REPO_ROOT = resolve(EXECUTOR_ROOT, '..');

export interface Credentials {
  /** Short id used in the ledger and the leaderboard. */
  user: string;
  apiKey: string;
  apiSecret: string;
}

export interface Config {
  baseUrl: string;
  wsUrl: string;
  isSandbox: boolean;
  users: Credentials[];
  dataDir: string;
  port: number;
  /**
   * Taker fee coefficient c in fee = c x contracts x price x (1 - price).
   * Gemini publishes 0.07 for production; the sandbox charged nothing.
   */
  takerFeeCoef: number;
  /**
   * Sandbox demo switch (GIVEN_SANDBOX_WAIVE_MARKUP=1): allow bets the offer
   * rule refuses ONLY because the price is too far above fair. The sandbox's
   * bot-run books are about 19 cents wide, so without this nothing passes
   * there. Always false outside the sandbox, whatever the setting says.
   */
  waiveMarkup: boolean;
  /** Extra browser origins allowed to call the HTTP API (GIVEN_CORS_ORIGINS, comma-separated). Localhost is always allowed. */
  corsOrigins: string[];
  /** Address to listen on (GIVEN_HOST). Default 127.0.0.1; anything else needs the hosted-demo protections below. */
  host: string;
  /** GIVEN_PINNED_USER: every request acts as this one account; the browser cannot choose. */
  pinnedUser: string | null;
  /** GIVEN_MAX_STAKE: refuse bets above this many dollars. */
  maxStake: number | null;
  /** GIVEN_RATE_LIMIT_PER_MIN: bets and settles allowed per client per minute. */
  rateLimitPerMin: number | null;
  /** GIVEN_TRUST_PROXY=1: take the client address from X-Forwarded-For. */
  trustProxy: boolean;
}

/** True for loopback addresses: the only ones that may run without the hosted-demo protections. */
export const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === 'localhost' || host === '::1';

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Reads settings from the repo-root .env, then executor/.env, then the real
 * environment (later sources win). Secrets are never logged.
 *
 * Accounts:
 *   GEMINI_API_KEY / GEMINI_API_SECRET            -> user "primary"
 *   GEMINI_USER_<NAME>_KEY / GEMINI_USER_<NAME>_SECRET -> user "<name>" (lower-cased)
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const merged: Record<string, string | undefined> = {
    ...parseEnvFile(resolve(REPO_ROOT, '.env')),
    ...parseEnvFile(resolve(EXECUTOR_ROOT, '.env')),
    ...env,
  };

  const baseUrl = (merged.GEMINI_BASE_URL ?? 'https://api.sandbox.gemini.com').replace(/\/+$/, '');
  const isSandbox = new URL(baseUrl).hostname === 'api.sandbox.gemini.com';
  if (!isSandbox && merged.GIVEN_ALLOW_PRODUCTION !== '1') {
    throw new Error(
      `GEMINI_BASE_URL is ${baseUrl}, which is not the sandbox. This executor places real orders; ` +
        'set GIVEN_ALLOW_PRODUCTION=1 only if real-money trading is intended.',
    );
  }
  const wsUrl = merged.GEMINI_WS_URL ?? (isSandbox ? 'wss://ws.sandbox.gemini.com' : 'wss://ws.gemini.com');

  const users: Credentials[] = [];
  if (merged.GEMINI_API_KEY && merged.GEMINI_API_SECRET) {
    users.push({ user: 'primary', apiKey: merged.GEMINI_API_KEY, apiSecret: merged.GEMINI_API_SECRET });
  }
  for (const [name, value] of Object.entries(merged)) {
    const m = /^GEMINI_USER_([A-Z0-9]+)_KEY$/.exec(name);
    if (!m || !value) continue;
    const secret = merged[`GEMINI_USER_${m[1]}_SECRET`];
    if (secret) users.push({ user: m[1]!.toLowerCase(), apiKey: value, apiSecret: secret });
  }

  return {
    baseUrl,
    wsUrl,
    isSandbox,
    users,
    dataDir: merged.GIVEN_DATA_DIR ? resolve(merged.GIVEN_DATA_DIR) : resolve(EXECUTOR_ROOT, 'data'),
    port: Number(merged.GIVEN_PORT ?? 8787),
    takerFeeCoef: merged.GIVEN_TAKER_FEE_COEF !== undefined ? Number(merged.GIVEN_TAKER_FEE_COEF) : isSandbox ? 0 : 0.07,
    waiveMarkup: isSandbox && merged.GIVEN_SANDBOX_WAIVE_MARKUP === '1',
    corsOrigins: (merged.GIVEN_CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    host: merged.GIVEN_HOST ?? '127.0.0.1',
    pinnedUser: merged.GIVEN_PINNED_USER ? merged.GIVEN_PINNED_USER : null,
    maxStake: merged.GIVEN_MAX_STAKE ? Number(merged.GIVEN_MAX_STAKE) : null,
    rateLimitPerMin: merged.GIVEN_RATE_LIMIT_PER_MIN ? Number(merged.GIVEN_RATE_LIMIT_PER_MIN) : null,
    trustProxy: merged.GIVEN_TRUST_PROXY === '1',
  };
}

export function requireUser(config: Config, user = 'primary'): Credentials {
  const found = config.users.find((u) => u.user === user);
  if (!found) {
    const known = config.users.map((u) => u.user).join(', ') || 'none';
    throw new Error(`No Gemini credentials for user "${user}" (configured: ${known}). Add them to .env.`);
  }
  return found;
}
