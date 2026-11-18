/**
 * The QuickNode Stream from the command line.
 *
 *   npm run stream -- plan                    what `create` would send, tokens hidden. Sends nothing, needs no key
 *   npm run stream -- test-filter [--tx SIG]  run quicknode/filter.js on QuickNode against the block of a real Given record
 *   npm run stream -- create [--active]       create the Stream. Paused unless --active, so it spends nothing until you say
 *   npm run stream -- list                    the account's streams and whether each is running
 *   npm run stream -- activate [ID]           start delivering (and spending credits)
 *   npm run stream -- pause [ID]              stop. A paused Stream costs nothing and resumes where it stopped
 *
 * Settings, from the repo-root .env or the environment:
 *   QUICKNODE_API_KEY   an API key with the Streams application enabled (QuickNode dashboard, API Keys)
 *   GIVEN_STREAM_URL    where deliveries go, or pass --url. On the hosted demo: https://<host>/chain/hooks/quicknode
 *                       (GIVEN_PUBLIC_URL is used for that when this is unset). A bare chain service: https://<host>/hooks/quicknode
 *   GIVEN_HOOK_TOKEN    the secret the chain service expects; sent as the Authorization header of every delivery
 *   QN_SECURITY_TOKEN   optional, 32+ characters: keys QuickNode's own signature. One is made up if unset
 *
 * A running Stream is charged for every block whether or not anything of ours is in it: see the numbers `plan` prints.
 * There is deliberately no delete command (see validStreamId in src/quicknode.ts); delete in the dashboard.
 *
 * NOT YET RUN AGAINST THE LIVE API: written from QuickNode's published spec. A rejected request prints QuickNode's answer.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Connection } from '@solana/web3.js';
import { CHAIN_ROOT, mergedEnv } from '../src/config.ts';
import {
  LIST_PATH, TRIAL_CREDITS, activatePath, call, createBody, creditsPerDay, filterResult, givenStreams, masked, pausePath, streamsIn, testFilterBody, trialHours, validStreamId,
} from '../src/quicknode.ts';
import type { Answer, Fetch } from '../src/quicknode.ts';
import { signaturesIn } from '../src/webhook.ts';

/** The first call recorded through our program on devnet: a block known to hold a Given record. */
const KNOWN_RECORD = '2DFD8UjXaPofQh82UXFpwsUm47ArcVkteQAxFSeyjp76CRFtr8tNK7JvZD8Th8NepmctkYqnDypHdKRavEJxQnQL';

const env = mergedEnv();
const [command = 'plan', ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = (name: string): boolean => rest.includes(`--${name}`);
const positional = rest.find((a, i) => !a.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'));

const apiKey = env.QUICKNODE_API_KEY ?? '';
const filterSource = readFileSync(resolve(CHAIN_ROOT, 'quicknode/filter.js'), 'utf8');
const send: Fetch = (url, init) => fetch(url, init);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Stops with QuickNode's own words when it says no. */
function must(answer: Answer, doing: string): Answer {
  if (answer.ok) return answer;
  fail(`QuickNode refused to ${doing}: HTTP ${answer.status}\n${answer.text.slice(0, 2000)}`);
}

function budget(): string {
  const day = (creditsPerDay() / 1e6).toFixed(1);
  return `A running Stream uses about ${day} million credits a day here. The free trial holds ${TRIAL_CREDITS / 1e6} million in all, about ${trialHours()} hours of running, and RPC calls draw on the same credits. Pause it whenever nobody is watching.`;
}

function plan(): Record<string, unknown> {
  const publicUrl = (env.GIVEN_PUBLIC_URL ?? '').replace(/\/+$/, '');
  const webhookUrl = flag('url') ?? env.GIVEN_STREAM_URL ?? (publicUrl ? `${publicUrl}/chain/hooks/quicknode` : '');
  if (!webhookUrl) fail('Where should deliveries go? Pass --url https://<host>/chain/hooks/quicknode, or set GIVEN_STREAM_URL or GIVEN_PUBLIC_URL.');
  try {
    return createBody({
      name: flag('name') ?? 'given-devnet',
      webhookUrl,
      hookToken: env.GIVEN_HOOK_TOKEN ?? '',
      securityToken: env.QN_SECURITY_TOKEN || randomBytes(24).toString('hex'),
      filterSource,
      active: has('active'),
      ...(flag('batch') ? { batchSize: Number(flag('batch')) } : {}),
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/** The one stream to act on: the id given, or the only Given stream on the account. */
async function target(): Promise<string> {
  if (positional !== undefined) {
    if (!validStreamId(positional)) fail(`"${positional}" is not a stream id. Run: npm run stream -- list`);
    return positional;
  }
  const ours = givenStreams(streamsIn(must(await call(send, apiKey, 'GET', LIST_PATH), 'list the streams').json));
  if (ours.length === 1) return ours[0]!.id;
  fail(ours.length === 0 ? 'There is no Solana devnet Programs + Logs stream on this account. Create one first.' : `There are ${ours.length} such streams; say which:\n${ours.map((s) => `  ${s.id}  ${s.status}  ${s.name}`).join('\n')}`);
}

if (command !== 'plan' && !apiKey) fail('QUICKNODE_API_KEY is not set. Put an API key with Streams access in the repo-root .env (never in git).');

switch (command) {
  case 'plan': {
    console.log(JSON.stringify(masked(plan()), null, 2));
    console.log(`\nNothing was sent. ${budget()}`);
    break;
  }

  case 'test-filter': {
    const signature = flag('tx') ?? KNOWN_RECORD;
    const connection = new Connection(env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
    const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx) fail(`Solana has no transaction ${signature}.`);
    // QuickNode's docs call the argument a block number and do not say whether, for Solana, that is the slot or the
    // block height. Try the slot first, then the height, and say which one found the record.
    const block = await connection.getBlock(tx.slot, { maxSupportedTransactionVersion: 0, transactionDetails: 'none', rewards: false }).catch(() => null);
    const height = (block as { blockHeight?: number | null } | null)?.blockHeight; // returned by the RPC, missing from the library's types
    const tries: Array<[string, number]> = [['slot', tx.slot]];
    if (height) tries.push(['block height', height]);
    let found = false;
    for (const [what, number] of tries) {
      const answer = must(await call(send, apiKey, 'POST', '/streams/test_filter', testFilterBody(filterSource, number)), 'test the filter');
      const result = filterResult(answer.json);
      const got = signaturesIn(result);
      console.log(`by ${what} ${number}: the filter returned ${result === null ? 'nothing' : JSON.stringify(result).slice(0, 300)}`);
      if (got.includes(signature)) {
        console.log(`\nFILTER OK. QuickNode ran quicknode/filter.js on that block and it returned our record, in a shape the webhook reads. (Solana blocks are numbered by ${what} here.)`);
        found = true;
        break;
      }
    }
    if (!found) fail('\nFILTER DID NOT RETURN THE RECORD. Compare the output above with what quicknode/filter.js expects before creating a Stream.');
    break;
  }

  case 'create': {
    const body = plan();
    const made = must(await call(send, apiKey, 'POST', '/streams', body), 'create the Stream').json as { id?: unknown; status?: unknown } | null;
    console.log(`Created stream ${String(made?.id)} (${String(made?.status)}), delivering to ${String((body.destination_attributes as { url: string }).url)}`);
    if (!env.QN_SECURITY_TOKEN) console.log('Its security token was made up and not kept: the chain service authenticates deliveries by the Authorization header.');
    console.log(body.status === 'active' ? budget() : `It is paused and costs nothing. Start it with: npm run stream -- activate\n${budget()}`);
    break;
  }

  case 'list': {
    const rows = streamsIn(must(await call(send, apiKey, 'GET', LIST_PATH), 'list the streams').json);
    if (rows.length === 0) console.log('No streams on this account.');
    for (const s of rows) console.log(`${s.id}  ${s.status.padEnd(7)}  ${s.network}  ${s.dataset}  ${s.name}`);
    if (rows.some((s) => s.status === 'active')) console.log(`\n${budget()}`);
    break;
  }

  case 'activate': {
    const id = await target();
    must(await call(send, apiKey, 'POST', activatePath(id)), 'start the Stream');
    console.log(`Stream ${id} is running. ${budget()}`);
    break;
  }

  case 'pause': {
    const id = await target();
    must(await call(send, apiKey, 'POST', pausePath(id)), 'pause the Stream');
    console.log(`Stream ${id} is paused. It costs nothing now and resumes where it stopped.`);
    break;
  }

  default:
    fail('Usage: npm run stream -- plan | test-filter [--tx SIG] | create [--url URL] [--active] | list | activate [ID] | pause [ID]');
}
