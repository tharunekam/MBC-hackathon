import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFeedServer } from './server.ts';
import { ReceiptStore } from './store.ts';
import { decodeReceipt, scoreLeaderboard } from './receipts.ts';

// Same convention as the executor: settings live in the repo-root .env.
const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

const port = Number(process.env.RECEIPTS_FEED_PORT ?? 8788);
const store = new ReceiptStore(process.env.RECEIPTS_FILE ?? 'receipts.jsonl');

createFeedServer({
  programId: process.env.RECEIPTS_PROGRAM_ID ?? '8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK',
  securityToken: required('QUICKNODE_STREAM_TOKEN'),
  store,
  decode: decodeReceipt,
  score: scoreLeaderboard,
}).listen(port, () => {
  console.log(`receipts-feed listening on :${port} (${store.size} receipts loaded)`);
});
