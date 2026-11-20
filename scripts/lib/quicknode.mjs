/**
 * QuickNode Streams: the request that creates our Stream, and a signed delivery that looks like QuickNode's. Pure, so the
 * shapes are tested without a network. Field names and slugs are from QuickNode's OpenAPI spec
 * (https://api.quicknode.com/streams/rest/openapi.json), read 2026-11-18; none has been run against the live API yet.
 */
import { createHmac, randomBytes } from 'node:crypto';

export const API = 'https://api.quicknode.com/streams/rest/v1';
export const NETWORK = 'solana-devnet';
export const DATASET = 'programs_with_logs';

/** Credits per block on Solana devnet for this dataset, from QuickNode's billing page (account rates may differ). */
export const CREDITS_PER_BLOCK = 30;
/** Devnet's slot time, measured over 30 minutes on 2026-11-18 (getRecentPerformanceSamples: 4.17 slots a second). Not 400 ms. */
const SLOT_SECONDS = 0.24;

/** What a Stream costs to leave running, so nobody finds out from the credit meter. */
export function creditEstimate(hours = 24) {
  const blocks = (hours * 3600) / SLOT_SECONDS;
  return { blocks: Math.round(blocks), credits: Math.round(blocks * CREDITS_PER_BLOCK) };
}

export const newToken = (bytes = 24) => randomBytes(bytes).toString('hex'); // 48 hex chars (QuickNode needs at least 32)

/**
 * The body of POST /streams.
 *  - dataset_batch_size is 1: the live API rejected 5 because the maximum for this dataset is 1.
 *  - compression is none, so the receiver verifies the signature over the body exactly as received.
 *  - The Stream is created paused unless asked otherwise: it bills per block, matched or not.
 *  - Two ways to authenticate, both accepted by the receiver: our shared token as a custom header, and QuickNode's own
 *    signature headers keyed by `securityToken`.
 */
export function buildStreamBody({ name = 'given-calls', webhookUrl, filterSource, hookToken, securityToken, active = false, region = 'usa_east', batchSize = 1, externalId = 'given-calls-devnet' }) {
  if (!/^https:\/\/[^/\s]+\/.*hooks\/quicknode\/?$/.test(webhookUrl ?? '')) throw new Error('the webhook URL must be https and end in /hooks/quicknode (through our proxy: https://<host>/chain/hooks/quicknode)');
  if (!hookToken || hookToken.length < 16) throw new Error('GIVEN_HOOK_TOKEN is missing or too short');
  if (!securityToken || securityToken.length < 32) throw new Error('QN_SECURITY_TOKEN must be at least 32 characters');
  if (!/function\s+main\s*\(/.test(filterSource ?? '')) throw new Error('the filter must define main(stream)');
  return {
    name,
    network: NETWORK,
    dataset: DATASET,
    region,
    dataset_batch_size: batchSize,
    elastic_batch_enabled: false,
    filter_function: Buffer.from(filterSource).toString('base64'),
    filter_language: 'javascript',
    destination: 'webhook',
    destination_attributes: {
      url: webhookUrl,
      compression: 'none',
      // QuickNode pauses a Stream when its retries run out. The dashboard's default (3 tries, a second apart) would
      // pause it on any restart of the service; these ride out about half a minute.
      max_retry: 10,
      retry_interval_sec: 3,
      post_timeout_sec: 10,
      security_token: securityToken,
      headers: { Authorization: `Bearer ${hookToken}` },
    },
    status: active ? 'active' : 'paused',
    external_id: externalId,
  };
}

/**
 * QuickNode's stream ids are UUIDs. This matters: `DELETE /streams/` with an empty id deletes EVERY stream on the
 * account, so no path is ever built from an id that has not passed this.
 */
export const validStreamId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** The body of POST /streams/test_filter: QuickNode runs the filter against one block, with no Stream. `block` goes as text. */
export function testFilterBody(filterSource, block) {
  if (!Number.isInteger(block) || block < 0) throw new Error('the block must be a whole number');
  return { network: NETWORK, dataset: DATASET, filter_function: Buffer.from(filterSource).toString('base64'), block: String(block) };
}

/** A test_filter answer's result: QuickNode types it as a string, which may itself be JSON. */
export function filterResult(json) {
  const result = json && typeof json === 'object' ? json.result : undefined;
  if (typeof result !== 'string') return result ?? null;
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

/** True if `value` (whatever shape the filter returned) contains this transaction signature. */
export function mentions(value, signature) {
  if (typeof value === 'string') return value === signature;
  if (Array.isArray(value)) return value.some((v) => mentions(v, signature));
  if (value && typeof value === 'object') return Object.values(value).some((v) => mentions(v, signature));
  return false;
}

/** The headers QuickNode adds to a delivery: HMAC-SHA256 (hex) over nonce + timestamp + body, keyed by the security token. */
export function signDelivery(body, securityToken, { nonce = randomBytes(8).toString('hex'), timestamp = String(Math.floor(Date.now() / 1000)) } = {}) {
  const signature = createHmac('sha256', Buffer.from(securityToken)).update(Buffer.from(nonce + timestamp + body)).digest('hex');
  return { 'x-qn-nonce': nonce, 'x-qn-timestamp': timestamp, 'x-qn-signature': signature };
}

/** A programs_with_logs delivery with one Given memo transaction in it, in the shape QuickNode documents. */
export function sampleDelivery(signature, slot = 1) {
  return JSON.stringify({
    data: [
      [
        {
          signature,
          slot,
          blockTime: Math.floor(Date.now() / 1000),
          programInvocations: [],
          logs: ['Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr invoke [1]', 'Program log: Memo (len 12): "{\\"g\\":1,\\"t\\":\\"c\\"}"', 'Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr success'],
          success: true,
        },
      ],
    ],
    metadata: { network: NETWORK, dataset: DATASET, batch_start_range: slot, batch_end_range: slot, stream_id: 'sample' },
  });
}

/** Adds KEY=value lines to the text of an env file for keys that are not set there yet. Never touches an existing value. */
export function addMissing(envText, wanted) {
  let text = envText;
  const added = [];
  for (const [key, value] of Object.entries(wanted)) {
    if (new RegExp(`^${key}=.+`, 'm').test(text)) continue;
    text = text.replace(new RegExp(`^${key}=\\s*$`, 'm'), '').replace(/\n*$/, '\n') + `${key}=${value}\n`;
    added.push(key);
  }
  return { text, added };
}

/**
 * True when QuickNode refused to resume a Stream because it had fallen too far behind the chain. The free plan only resumes
 * within 100 blocks of the tip ("upgrade to a paid plan to backfill more than 100 blocks"); the fix is a fresh Stream, which
 * starts at the tip and so has nothing to backfill.
 */
export const needsFreshStream = (status, text) => status === 422 && /backfill more than \d+ blocks/i.test(String(text));

/** The address a listed Stream delivers to, or null when QuickNode did not say. */
export const destinationUrl = (stream) => (typeof stream?.destination_attributes?.url === 'string' ? stream.destination_attributes.url : null);

/** True when a Stream is known to deliver somewhere other than where this machine's webhook now is (a tunnel that restarted). */
export const pointsElsewhere = (stream, webhookUrl) => {
  const now = destinationUrl(stream);
  return now !== null && now.replace(/\/+$/, '') !== String(webhookUrl).replace(/\/+$/, '');
};
