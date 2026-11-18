/**
 * QuickNode's Streams REST API, as far as Given needs it: test the filter, create the Stream, pause and resume it.
 * `scripts/stream.ts` is the command line for this.
 *
 * Written from QuickNode's OpenAPI spec (api.quicknode.com/streams/rest/openapi.json) and its Streams docs as read on
 * 2026-11-18. The request shapes are pinned by tests, but NONE of it has been run against the live API from this repo:
 * no key was available where it was written. If QuickNode rejects a request, the script prints its answer in full.
 */

export const API = 'https://api.quicknode.com/streams/rest/v1';
export const NETWORK = 'solana-devnet';
export const DATASET = 'programs_with_logs';

/** Credits QuickNode charges per block for Solana devnet "Programs + Logs" at the default rate (its billing page). */
export const CREDITS_PER_BLOCK = 30;
/** Measured on devnet over public RPC on 2026-11-18: about 4.1 slots a second, 996 in 1000 with a block. */
export const BLOCKS_PER_SECOND = 4.08;
/** What the free trial holds in total. RPC calls draw on the same credits. */
export const TRIAL_CREDITS = 10_000_000;

/** A Stream is charged for every block it reads, whether or not the filter matches anything. */
export const creditsPerDay = (): number => Math.round(CREDITS_PER_BLOCK * BLOCKS_PER_SECOND * 86_400);
export const trialHours = (): number => Math.floor((TRIAL_CREDITS / creditsPerDay()) * 24);

export interface StreamPlan {
  name: string;
  /** Where deliveries go: https://<host>/chain/hooks/quicknode on the hosted demo, https://<host>/hooks/quicknode on a bare chain service. */
  webhookUrl: string;
  /** Sent as `Authorization: Bearer …`; the chain service's GIVEN_HOOK_TOKEN. */
  hookToken: string;
  /** Keys QuickNode's own signature headers; the chain service's QN_SECURITY_TOKEN if it should check them too. */
  securityToken: string;
  /** The text of quicknode/filter.js. */
  filterSource: string;
  /** Start delivering (and spending credits) at once. Default: created paused. */
  active?: boolean;
  batchSize?: number;
  maxRetry?: number;
  retryIntervalSec?: number;
  postTimeoutSec?: number;
  region?: 'usa_east' | 'europe_central' | 'asia_east';
}

const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** The body of `POST /streams`. Every field the spec marks required is present. */
export function createBody(p: StreamPlan): Record<string, unknown> {
  let url: URL;
  try {
    url = new URL(p.webhookUrl);
  } catch {
    throw new Error('The webhook address is not a URL.');
  }
  if (url.protocol !== 'https:') throw new Error('The webhook address must be https.');
  if (!/\/hooks\/quicknode$/.test(url.pathname)) throw new Error('The webhook address must end in /hooks/quicknode.');
  if (!p.hookToken) throw new Error('GIVEN_HOOK_TOKEN is not set: without it the chain service refuses every delivery.');
  if (p.securityToken.length < 32) throw new Error('The security token must be at least 32 characters.');
  const batch = p.batchSize ?? 5;
  // Solana makes several blocks a second; QuickNode rejects a batch below 5 for a stream that follows the tip.
  if (!Number.isInteger(batch) || batch < 5) throw new Error('The batch size must be a whole number of at least 5.');
  if (p.filterSource.trim() === '') throw new Error('The filter is empty.');
  return {
    name: p.name,
    network: NETWORK,
    dataset: DATASET,
    region: p.region ?? 'usa_east',
    filter_function: base64(p.filterSource),
    dataset_batch_size: batch,
    elastic_batch_enabled: true,
    destination: 'webhook',
    destination_attributes: {
      url: url.toString(),
      // The receiver also accepts gzip, but uncompressed is one thing fewer to go wrong.
      compression: 'none',
      headers: { Authorization: `Bearer ${p.hookToken}` },
      security_token: p.securityToken,
      // QuickNode pauses a Stream when its retries run out. These ride out a restart of about half a minute.
      max_retry: p.maxRetry ?? 10,
      retry_interval_sec: p.retryIntervalSec ?? 3,
      post_timeout_sec: p.postTimeoutSec ?? 10,
    },
    status: p.active ? 'active' : 'paused',
  };
}

/** The body of `POST /streams/test_filter`: run the filter on QuickNode against one block, with no Stream. */
export function testFilterBody(filterSource: string, block: number): Record<string, unknown> {
  if (!Number.isInteger(block) || block < 0) throw new Error('The block must be a whole number.');
  return { network: NETWORK, dataset: DATASET, filter_function: base64(filterSource), block: String(block) };
}

/** A request body safe to print: no token, and the filter by its size. */
export function masked(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (typeof out.filter_function === 'string') out.filter_function = `<base64, ${out.filter_function.length} characters>`;
  const d = out.destination_attributes;
  if (d && typeof d === 'object') out.destination_attributes = { ...(d as Record<string, unknown>), headers: { Authorization: 'Bearer <hidden>' }, security_token: '<hidden>' };
  return out;
}

/**
 * QuickNode's ids are UUIDs. This matters: `DELETE /streams/` with an empty id deletes EVERY stream on the account, so
 * nothing here ever builds a path from an id that has not passed this check, and there is no delete command at all.
 */
export const validStreamId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export interface Answer {
  status: number;
  ok: boolean;
  json: unknown;
  text: string;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;

/** One call to the Streams API. The key goes in `x-api-key` and nowhere else. */
export async function call(fetchImpl: Fetch, apiKey: string, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Answer> {
  if (!apiKey) throw new Error('QUICKNODE_API_KEY is not set.');
  if (!path.startsWith('/streams')) throw new Error('Not a Streams path.');
  const res = await fetchImpl(API + path, {
    method,
    headers: { 'x-api-key': apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: the caller prints the text */
  }
  return { status: res.status, ok: res.status >= 200 && res.status < 300, json, text };
}

export const pausePath = (id: string): string => {
  if (!validStreamId(id)) throw new Error('That is not a stream id.');
  return `/streams/${id}/pause`;
};
export const activatePath = (id: string): string => {
  if (!validStreamId(id)) throw new Error('That is not a stream id.');
  return `/streams/${id}/activate`;
};
export const LIST_PATH = '/streams?limit=20&offset=0';

export interface StreamRow {
  id: string;
  name: string;
  status: string;
  network: string;
  dataset: string;
}

/** The streams in a list answer, whichever of the two documented wrappers it came in. */
export function streamsIn(json: unknown): StreamRow[] {
  const list = Array.isArray(json) ? json : json && typeof json === 'object' && Array.isArray((json as { data?: unknown }).data) ? (json as { data: unknown[] }).data : [];
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  return list
    .filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object')
    .map((s) => ({ id: text(s.id), name: text(s.name), status: text(s.status), network: text(s.network), dataset: text(s.dataset) }))
    .filter((s) => validStreamId(s.id));
}

/** The streams that are ours to pause or resume: Solana devnet, Programs + Logs. */
export const givenStreams = (rows: StreamRow[]): StreamRow[] => rows.filter((s) => s.network === NETWORK && s.dataset === DATASET);

/** A test_filter answer's result: QuickNode types it as a string, which may itself be JSON. */
export function filterResult(json: unknown): unknown {
  const result = json && typeof json === 'object' ? (json as { result?: unknown }).result : undefined;
  if (typeof result !== 'string') return result ?? null;
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}
