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
export function loadConfig(env: Record<string, string | undefined> = process.env): ChainConfig {
  const m: Record<string, string | undefined> = { ...parseEnvFile(resolve(REPO_ROOT, '.env')), ...parseEnvFile(resolve(CHAIN_ROOT, '.env')), ...env };
  const network = m.GIVEN_CHAIN === 'fake' ? 'fake' : 'devnet';
  const dataDir = m.GIVEN_CHAIN_DATA_DIR ? resolve(m.GIVEN_CHAIN_DATA_DIR) : resolve(CHAIN_ROOT, 'data');
  return {
    network,
    rpcUrl: m.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
    keypairPath: m.GIVEN_CHAIN_KEYPAIR ? resolve(m.GIVEN_CHAIN_KEYPAIR) : resolve(dataDir, 'authority.json'),
    dataDir,
    host: m.GIVEN_CHAIN_HOST ?? '127.0.0.1',
    port: Number(m.GIVEN_CHAIN_PORT ?? 8742),
    executorUrl: m.GIVEN_EXECUTOR_URL ?? 'http://127.0.0.1:8787',
    user: m.GIVEN_PINNED_USER ?? 'primary',
    corsOrigins: (m.GIVEN_CORS_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
    hookToken: m.GIVEN_HOOK_TOKEN || undefined,
    qnSecurityToken: m.QN_SECURITY_TOKEN || undefined,
    hookInsecure: m.GIVEN_HOOK_INSECURE === '1',
    adminToken: m.GIVEN_ADMIN_TOKEN || undefined,
    minCalls: Number(m.GIVEN_LB_MIN_CALLS ?? 1),
    backfillMs: Number(m.GIVEN_BACKFILL_MS ?? (network === 'devnet' ? 60_000 : 0)),
    selfIngest: m.GIVEN_SELF_INGEST ? m.GIVEN_SELF_INGEST === '1' : network === 'fake',
    extraAuthorities: (m.GIVEN_EXTRA_AUTHORITIES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    rateLimitPerMin: m.GIVEN_RATE_LIMIT_PER_MIN ? Number(m.GIVEN_RATE_LIMIT_PER_MIN) : null,
    trustProxy: m.GIVEN_TRUST_PROXY === '1',
  };
}
