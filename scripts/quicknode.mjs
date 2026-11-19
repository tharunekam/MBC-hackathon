#!/usr/bin/env node
/**
 * QuickNode Streams for Given, from the terminal. Reads the repo-root .env.
 *
 *   npm run quicknode -- keys                 make GIVEN_HOOK_TOKEN and QN_SECURITY_TOKEN in .env (never overwrites, never prints them)
 *   npm run quicknode -- plan                 print the Stream that would be created (secrets hidden), and what it costs. Sends nothing
 *   npm run quicknode -- test-filter [SIG]    run chain/quicknode/filter.js ON QUICKNODE against the block of a real Given record. No Stream needed
 *   npm run quicknode -- test-delivery        send a correctly signed sample delivery to our webhook, as QuickNode would
 *   npm run quicknode -- create [--active]    create the Stream (paused unless --active)
 *   npm run quicknode -- status               the Stream's state
 *   npm run quicknode -- activate | pause     start or stop it (it bills per block while active, matched or not)
 *   npm run quicknode -- delete --yes
 *   npm run quicknode -- pitch-on [--recreate]  the one command before presenting: checks our webhook answers, then starts the Stream
 *   npm run quicknode -- pitch-off            the one command after: pauses it
 *
 * Needs: QUICKNODE_API_KEY (dashboard > API keys, with Streams access) for create/status/activate/pause/delete, and a webhook
 * URL: QN_WEBHOOK_URL, or GIVEN_PUBLIC_URL (then <it>/chain/hooks/quicknode).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, CREDITS_PER_BLOCK, addMissing, buildStreamBody, creditEstimate, filterResult, mentions, needsFreshStream, newToken, sampleDelivery, signDelivery, testFilterBody, validStreamId } from './lib/quicknode.mjs';

/** The first call recorded through our program on devnet: a block known to hold a Given record. */
const KNOWN_RECORD = '2DFD8UjXaPofQh82UXFpwsUm47ArcVkteQAxFSeyjp76CRFtr8tNK7JvZD8Th8NepmctkYqnDypHdKRavEJxQnQL';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = resolve(ROOT, '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const env = process.env;
const [cmd = 'help', ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);
const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

const webhookUrl = () => env.QN_WEBHOOK_URL || (env.GIVEN_PUBLIC_URL ? `${env.GIVEN_PUBLIC_URL.replace(/\/+$/, '')}/chain/hooks/quicknode` : '');
const filterSource = () => readFileSync(resolve(ROOT, 'chain/quicknode/filter.js'), 'utf8');
const body = (active = false) => {
  try {
    return buildStreamBody({ webhookUrl: webhookUrl(), filterSource: filterSource(), hookToken: env.GIVEN_HOOK_TOKEN, securityToken: env.QN_SECURITY_TOKEN, active });
  } catch (err) {
    // A missing setting is something to fix, not a crash to read a stack trace for.
    return die(`Cannot describe the Stream yet: ${err.message}. Set GIVEN_PUBLIC_URL (or QN_WEBHOOK_URL) and run: npm run quicknode -- keys`);
  }
};
const mask = (b) => ({ ...b, filter_function: `<${b.filter_function.length} chars of base64>`, destination_attributes: { ...b.destination_attributes, security_token: '<hidden>', headers: { Authorization: 'Bearer <hidden>' } } });

/** With `soft`, an error answer is returned ({ failed, status, text }) instead of ending the program. */
async function api(method, path, payload, soft = false) {
  if (!env.QUICKNODE_API_KEY) die('QUICKNODE_API_KEY is not set (QuickNode dashboard > API keys, with Streams access). Put it in .env.');
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': env.QUICKNODE_API_KEY }, body: payload ? JSON.stringify(payload) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  if (!res.ok) {
    if (soft) return { failed: true, status: res.status, text };
    die(`QuickNode answered HTTP ${res.status} to ${method} ${path}:\n${text}`);
  }
  return json;
}

/** Finds our Stream by its external id (a repeat create returns the same one). */
async function ours() {
  const list = await api('GET', '/streams?limit=100&offset=0');
  const rows = Array.isArray(list) ? list : (list?.data ?? list?.streams ?? []);
  const found = rows.find((s) => s.external_id === 'given-calls-devnet' || s.name === 'given-calls');
  if (!found) die('No Given Stream on this account yet. Run: npm run quicknode -- create');
  // Never build a path from anything but a full id: an empty one would address every stream on the account.
  if (!validStreamId(found.id)) die(`QuickNode listed our Stream without a usable id (${JSON.stringify(found.id)}). Nothing was done.`);
  return found;
}

const hr = (s) => console.log(`\n${s}`);

switch (cmd) {
  case 'keys': {
    const current = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
    const { text, added } = addMissing(current, { GIVEN_HOOK_TOKEN: newToken(), QN_SECURITY_TOKEN: newToken() });
    if (added.length > 0) writeFileSync(ENV_FILE, text, { mode: 0o600 });
    console.log(added.length > 0 ? `Wrote ${added.join(' and ')} to .env (git-ignored). Copy the same values into the host's secrets.` : 'Both tokens are already in .env. Nothing changed.');
    break;
  }
  case 'plan': {
    const b = body(flag('--active'));
    console.log(JSON.stringify(mask(b), null, 2));
    const day = creditEstimate(24);
    hr(`Cost: ${CREDITS_PER_BLOCK} credits a block on Solana devnet whether or not the filter matches. Left running that is about ${day.blocks.toLocaleString()} blocks and ${(day.credits / 1e6).toFixed(1)}M credits a day.`);
    console.log('Compare with the free plan\'s credit allowance on the dashboard; pause the Stream outside testing and demo windows.');
    console.log(`Delivers to: ${b.destination_attributes.url}`);
    break;
  }
  case 'test-filter': {
    const signature = rest.find((a) => !a.startsWith('--')) ?? KNOWN_RECORD;
    const rpc = async (method, params) => {
      const res = await fetch(env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return (await res.json()).result ?? null;
    };
    const tx = await rpc('getTransaction', [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
    if (!tx) die(`Solana has no transaction ${signature}.`);
    // QuickNode's docs call the argument a block number and do not say whether, for Solana, that is the slot or the block
    // height. Try the slot first, then the height, and say which one found the record.
    const block = await rpc('getBlock', [tx.slot, { transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }]);
    const tries = [['slot', tx.slot], ...(block?.blockHeight ? [['block height', block.blockHeight]] : [])];
    let found = false;
    for (const [what, number] of tries) {
      const result = filterResult(await api('POST', '/streams/test_filter', testFilterBody(filterSource(), number)));
      console.log(`by ${what} ${number}: the filter returned ${result === null ? 'nothing' : JSON.stringify(result).slice(0, 300)}`);
      if (mentions(result, signature)) {
        hr(`FILTER OK. QuickNode ran chain/quicknode/filter.js on that block and it returned our record. (Solana blocks are numbered by ${what} here.)`);
        found = true;
        break;
      }
    }
    if (!found) die('\nFILTER DID NOT RETURN THE RECORD. Compare the output above with what chain/quicknode/filter.js expects before creating a Stream.');
    break;
  }
  case 'test-delivery': {
    const url = webhookUrl();
    if (!url) die('Set GIVEN_PUBLIC_URL or QN_WEBHOOK_URL.');
    if (!env.QN_SECURITY_TOKEN) die('QN_SECURITY_TOKEN is not set (npm run quicknode -- keys).');
    const signature = rest.find((a) => !a.startsWith('--')) ?? '1'.repeat(88);
    const payload = sampleDelivery(signature);
    for (const [label, headers] of [
      ['QuickNode signature headers', signDelivery(payload, env.QN_SECURITY_TOKEN)],
      ['shared-token header', { authorization: `Bearer ${env.GIVEN_HOOK_TOKEN ?? ''}` }],
      ['no credentials (must be refused)', {}],
    ]) {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload });
      const expected = label.startsWith('no ') ? 401 : 202;
      console.log(`${res.status === expected ? 'ok  ' : 'FAIL'} ${label}: HTTP ${res.status} (expected ${expected})`);
      if (res.status !== expected) process.exitCode = 1;
    }
    console.log('The signature in the sample is not a real transaction, so the service finds nothing on chain for it and adds no row.');
    break;
  }
  case 'create': {
    const made = await api('POST', '/streams', body(flag('--active')));
    console.log(`Stream ${made?.id ?? '(no id returned)'} created, status ${made?.status ?? 'unknown'}.`);
    if (!flag('--active')) console.log('It is paused. Start it with: npm run quicknode -- activate');
    break;
  }
  case 'status': {
    const s = await ours();
    console.log(JSON.stringify({ id: s.id, name: s.name, network: s.network, dataset: s.dataset, status: s.status, destination: s.destination, sequence: s.sequence_id ?? s.sequence }, null, 2));
    break;
  }
  case 'activate':
  case 'pause': {
    const s = await ours();
    console.log(JSON.stringify(await api('POST', `/streams/${s.id}/${cmd}`, cmd === 'activate' ? {} : undefined), null, 2));
    break;
  }
  case 'pitch-on': {
    // 1. Never burn credits into a dead endpoint: our webhook must answer, over the public address, before the Stream starts.
    const url = webhookUrl();
    if (!url || !env.QN_SECURITY_TOKEN) die('Set GIVEN_PUBLIC_URL and run: npm run quicknode -- keys');
    const probe = sampleDelivery('1'.repeat(88));
    const answered = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...signDelivery(probe, env.QN_SECURITY_TOKEN) }, body: probe }).then((r) => r.status, () => 0);
    if (answered !== 202) die(`Our webhook did not accept a signed test delivery (HTTP ${answered || 'no answer'}). Is the server up and GIVEN_PUBLIC_URL the address people open? The Stream was NOT started.`);
    console.log('ok   our webhook accepts a signed delivery at the public address');
    // 2. Start it. A Stream paused for long cannot be resumed on the free plan; then a fresh one, which starts at the tip.
    let s = await ours();
    if (s.status === 'active') console.log('ok   the Stream is already active');
    else {
      const r = await api('POST', `/streams/${s.id}/activate`, {}, true);
      if (r?.failed && needsFreshStream(r.status, r.text)) {
        if (!flag('--recreate')) die('QuickNode will not resume this Stream: it fell too far behind for the free plan. Run again with --recreate to replace it with a fresh Stream that starts at the tip (this deletes the old one).');
        await api('DELETE', `/streams/${s.id}`);
        await api('POST', '/streams', body(true));
        console.log('ok   replaced it with a fresh Stream, started at the tip');
      } else if (r?.failed) die(`QuickNode answered HTTP ${r.status} to activate:\n${r.text}`);
      else console.log('ok   the Stream was resumed');
    }
    s = await ours();
    console.log(`Stream status: ${s.status}.`);
    const hour = creditEstimate(1);
    hr(`It now bills about ${(hour.credits / 1000).toFixed(0)}k credits an hour. When you are done presenting: npm run quicknode -- pitch-off`);
    break;
  }
  case 'pitch-off': {
    const s = await ours();
    const r = await api('POST', `/streams/${s.id}/pause`, undefined, true);
    if (r?.failed) die(`QuickNode answered HTTP ${r.status} to pause:\n${r.text}`);
    console.log(`Stream status: ${(await ours()).status}. Nothing is billed while it is paused.`);
    break;
  }
  case 'delete': {
    if (!flag('--yes')) die('This removes the Stream. Re-run with --yes.');
    const s = await ours();
    await api('DELETE', `/streams/${s.id}`);
    console.log(`Deleted ${s.id}.`);
    break;
  }
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^[#/ *]*\n?/gm, ''));
}
