// Creates the QuickNode Stream that delivers given_receipts transactions to
// the feed's webhook. Run once per deployment: npm run create-stream
//
// Reads from the repo-root .env:
//   QUICKNODE_API_KEY       required (QuickNode dashboard -> API keys, Streams scope)
//   WEBHOOK_URL             required, e.g. https://<tunnel>/webhooks/quicknode
//   QUICKNODE_STREAM_TOKEN  optional; generated and appended to .env if missing
//   QUICKNODE_NETWORK       default solana-devnet
//   QUICKNODE_DATASET       default programs_with_logs
//
// NOT YET RUN against the live API. The body follows QuickNode's create-stream
// reference, but the docs do not list the network and dataset slugs, so the two
// defaults above are guesses; on a rejection the API's own message is printed.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} in ${envFile}`);
    process.exit(1);
  }
  return v;
}

const apiKey = required('QUICKNODE_API_KEY');
const webhookUrl = required('WEBHOOK_URL');
const programId = process.env.RECEIPTS_PROGRAM_ID ?? '8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK';

let token = process.env.QUICKNODE_STREAM_TOKEN;
if (!token) {
  token = randomBytes(24).toString('hex');
  appendFileSync(envFile, `\nQUICKNODE_STREAM_TOKEN=${token}\n`);
  console.log(`Generated a stream security token and saved it to ${envFile}`);
}

const filter = readFileSync(resolve(here, '../quicknode/filter.js'), 'utf8').replaceAll('__PROGRAM_ID__', programId);

const res = await fetch('https://api.quicknode.com/streams/rest/v1/streams', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': apiKey },
  body: JSON.stringify({
    name: 'given-receipts',
    network: process.env.QUICKNODE_NETWORK ?? 'solana-devnet',
    dataset: process.env.QUICKNODE_DATASET ?? 'programs_with_logs',
    region: 'usa_east',
    dataset_batch_size: 1,
    elastic_batch_enabled: true,
    filter_function: Buffer.from(filter).toString('base64'),
    destination: 'webhook',
    destination_attributes: {
      url: webhookUrl,
      compression: 'none',
      max_retry: 3,
      retry_interval_sec: 1,
      post_timeout_sec: 10,
      security_token: token,
    },
    status: 'active',
  }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`QuickNode rejected the stream (HTTP ${res.status}):\n${text}`);
  process.exit(1);
}
const stream = JSON.parse(text) as { id?: string; status?: string };
console.log(`Stream ${stream.id} created (${stream.status}); delivering ${programId} to ${webhookUrl}`);
