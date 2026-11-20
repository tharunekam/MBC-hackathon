import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const CHAIN_ROOT = resolve(here, '..');
export const REPO_ROOT = resolve(CHAIN_ROOT, '..');

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export interface ChainConfig {
  network: 'devnet' | 'fake';
  rpcUrl: string;
  keypairPath: string;
  /** The deployed given_receipts program (GIVEN_PROGRAM_ID). Unset: records are Memos only. */
  programId: string | undefined;
  dataDir: string;
  host: string;
  port: number;
  executorUrl: string;
  /** Executor account whose calls this service serves. */
  user: string;
  corsOrigins: string[];
  hookToken: string | undefined;
  qnSecurityToken: string | undefined;
  hookInsecure: boolean;
  adminToken: string | undefined;
  minCalls: number;
  /** Re-scan our authority's transactions this often, in ms (0 = off). The safety net for a paused Stream. */
  backfillMs: number;
  /** Index our own reveals immediately instead of waiting for the Stream. On for the fake chain. */
  selfIngest: boolean;
  /** Extra authority public keys whose memos count (GIVEN_EXTRA_AUTHORITIES, comma-separated). */
  extraAuthorities: string[];
  rateLimitPerMin: number | null;
  trustProxy: boolean;
}

export const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === 'localhost' || host === '::1';

/** Repo-root .env, then chain/.env, then the real environment (later wins). Secrets are never logged. */
export function mergedEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return { ...parseEnvFile(resolve(REPO_ROOT, '.env')), ...parseEnvFile(resolve(CHAIN_ROOT, '.env')), ...env };
}

/**
 * A limit that must be a plain number above zero if it is set at all. "20/min" would otherwise become NaN, which is falsy, and
 * quietly switch the rate limiter off.
 */
function positiveSetting(name: string, raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || !(n > 0)) throw new Error(`${name} must be a number above 0, but it is "${raw.slice(0, 40)}".`);
  return n;
}

/**
 * A whole number of at least `min` (at most `max`), or `fallback` when not set. A value such as "three" or "60s" stops the
 * service with a sentence instead of becoming NaN, which would silently empty the leaderboard or switch the backfill off.
 */
function wholeSetting(name: string, raw: string | undefined, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = /^\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}, but it is "${raw.slice(0, 40)}".`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ChainConfig {
  const m = mergedEnv(env);
  const network = m.GIVEN_CHAIN === 'fake' ? 'fake' : 'devnet';
  const dataDir = m.GIVEN_CHAIN_DATA_DIR ? resolve(m.GIVEN_CHAIN_DATA_DIR) : resolve(CHAIN_ROOT, 'data');
  return {
    network,
    rpcUrl: m.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    keypairPath: m.GIVEN_CHAIN_KEYPAIR ? resolve(m.GIVEN_CHAIN_KEYPAIR) : resolve(dataDir, 'authority.json'),
    programId: m.GIVEN_PROGRAM_ID || undefined,
    dataDir,
    host: m.GIVEN_CHAIN_HOST ?? '127.0.0.1',
    port: wholeSetting('GIVEN_CHAIN_PORT', m.GIVEN_CHAIN_PORT, 8742, 0, 65535),
    executorUrl: m.GIVEN_EXECUTOR_URL ?? 'http://127.0.0.1:8787',
    user: m.GIVEN_PINNED_USER ?? 'primary',
    corsOrigins: (m.GIVEN_CORS_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
    hookToken: m.GIVEN_HOOK_TOKEN || undefined,
    qnSecurityToken: m.QN_SECURITY_TOKEN || undefined,
    hookInsecure: m.GIVEN_HOOK_INSECURE === '1',
    adminToken: m.GIVEN_ADMIN_TOKEN || undefined,
    minCalls: wholeSetting('GIVEN_LB_MIN_CALLS', m.GIVEN_LB_MIN_CALLS, 1),
    backfillMs: wholeSetting('GIVEN_BACKFILL_MS', m.GIVEN_BACKFILL_MS, network === 'devnet' ? 60_000 : 0),
    selfIngest: m.GIVEN_SELF_INGEST ? m.GIVEN_SELF_INGEST === '1' : network === 'fake',
    extraAuthorities: (m.GIVEN_EXTRA_AUTHORITIES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    rateLimitPerMin: positiveSetting('GIVEN_RATE_LIMIT_PER_MIN', m.GIVEN_RATE_LIMIT_PER_MIN),
    trustProxy: m.GIVEN_TRUST_PROXY === '1',
  };
}
