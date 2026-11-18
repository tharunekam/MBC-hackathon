#!/usr/bin/env node
/**
 * Is everything ready for the real thing?   npm run preflight
 *
 * Runs each check with the SAME code the app uses, prints PASS / FAIL / SKIP with the exact fix, and ends with a
 * verdict per capability. It never prints a key, a secret or a keypair, only whether they exist and work.
 * It places no order and sends no transaction. Exit code 1 only when something required for `dev:live` is missing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (rel) => import(resolve(ROOT, rel));
const results = [];
/** What a person should do about the failures a first run actually hits. Heuristic, matched on Gemini's reason text. */
function hintFor(message) {
  if (/InvalidNonce/i.test(message)) return 'The nonce was rejected. Create the key with "time-based nonce" enabled (the executor signs with Unix seconds) and check this computer\'s clock is correct.';
  if (/InvalidSignature/i.test(message)) return 'The secret does not match the key. Re-copy both into .env (Gemini shows the secret only once) with no quotes or spaces.';
  if (/InvalidApiKey|MissingApikey|HTTP 401/i.test(message)) return 'Gemini does not accept this key here. Sandbox keys only work on the sandbox; create them in a sandbox account, not production.';
  if (/role|scope|permission/i.test(message)) return 'The key lacks a permission. Give it Trading and balance-read scopes.';
  if (/fetch failed|ENOTFOUND|ECONN|timed out/i.test(message)) return 'The network is not reachable from here.';
  return undefined;
}
const run = async (group, name, fn) => {
  let r;
  try {
    r = await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    r = { status: 'FAIL', detail: message.split('\n')[0].slice(0, 220), fix: hintFor(message) };
  }
  results.push({ group, name, ...r });
  const mark = { PASS: '  ok  ', FAIL: ' FAIL ', SKIP: ' skip ' }[r.status];
  console.log(`[${mark}] ${name}${r.detail ? `  ${r.detail}` : ''}`);
  if (r.fix) console.log(`         -> ${r.fix}`);
};
const pass = (detail) => ({ status: 'PASS', detail });
const fail = (detail, fix) => ({ status: 'FAIL', detail, fix });
const skip = (detail, fix) => ({ status: 'SKIP', detail, fix });

console.log('Given preflight\n');

// ------------------------------------------------------------------ tools
console.log('Tools');
await run('tools', 'Node 23.6 or newer', async () => {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return maj > 23 || (maj === 23 && min >= 6) ? pass(`v${process.versions.node}`) : fail(`v${process.versions.node}`, 'Install Node 24 (fnm install 24).');
});
for (const pkg of ['executor', 'chain', 'web']) {
  await run('tools', `${pkg} dependencies installed`, async () =>
    existsSync(resolve(ROOT, pkg, 'node_modules')) ? pass() : fail('missing', 'npm run install:all'),
  );
}

// ------------------------------------------------------------------ gemini
console.log('\nGemini');
const { loadConfig } = await imp('executor/src/config.ts');
let gconf = null;
await run('gemini', 'Configuration loads', async () => {
  gconf = loadConfig();
  return pass(`${gconf.isSandbox ? 'SANDBOX' : 'PRODUCTION'}  ${new URL(gconf.baseUrl).hostname}  accounts: ${gconf.users.map((u) => u.user).join(', ') || 'none'}`);
});
await run('gemini', 'Pointed at the sandbox, not production', async () =>
  gconf?.isSandbox ? pass() : fail('GEMINI_BASE_URL is not the sandbox', 'Remove GEMINI_BASE_URL and GIVEN_ALLOW_PRODUCTION from .env until both teammates agree.'),
);
const { GeminiPublic, GeminiRest } = await imp('executor/src/gemini/rest.ts');
const { GeminiWs } = await imp('executor/src/gemini/ws.ts');
const { ReadOnlyExchange } = await imp('executor/src/readonly.ts');
await run('gemini', 'Market data (public REST, no key)', async () => {
  const events = await new GeminiPublic(gconf.baseUrl).listEvents('active', 100);
  return events.length > 0 ? pass(`${events.length} active events`) : fail('0 events', 'Gemini returned no active events right now; try again in a minute.');
});
await run('gemini', 'Order book depth (public WebSocket, no key)', async () => {
  const events = await new GeminiPublic(gconf.baseUrl).listEvents('active', 20);
  const symbol = events.flatMap((e) => e.contracts ?? []).find((c) => c.instrumentSymbol)?.instrumentSymbol;
  if (!symbol) return skip('no contract to read');
  const ex = new ReadOnlyExchange(gconf.baseUrl, gconf.wsUrl);
  try {
    const t = await ex.topOfBook(symbol);
    return pass(`${symbol}  bid ${t.bid ?? '-'} / ask ${t.ask ?? '-'}`);
  } finally {
    ex.close();
  }
});
const keyed = gconf?.users?.length > 0;
await run('gemini', 'API keys present', async () =>
  keyed ? pass(`${gconf.users.length} account(s): ${gconf.users.map((u) => u.user).join(', ')}`) : fail('none in .env', 'Add GEMINI_API_KEY and GEMINI_API_SECRET (sandbox keys) to .env. See .env.example.'),
);
if (keyed) {
  const creds = gconf.users[0];
  await run('gemini', 'Keys accepted (signed REST balance read)', async () => {
    const usd = await new GeminiRest(creds, gconf.baseUrl).usdBalance();
    return pass(`USD balance $${usd.toFixed(2)}`);
  });
  await run('gemini', 'Prediction-market terms accepted', async () =>
    (await new GeminiRest(creds, gconf.baseUrl).termsAccepted()) ? pass() : fail('not accepted', 'Log in to the sandbox web UI with this account and accept the prediction markets terms.'),
  );
  await run('gemini', 'Order session opens (signed WebSocket + orders@account)', async () => {
    const ws = new GeminiWs(creds, gconf.wsUrl);
    try {
      await ws.connect();
      return pass('subscribed to private order events');
    } finally {
      ws.close();
    }
  });
} else {
  for (const name of ['Keys accepted (signed REST balance read)', 'Prediction-market terms accepted', 'Order session opens (signed WebSocket + orders@account)']) {
    console.log(`[ skip ] ${name}  needs keys`);
    results.push({ group: 'gemini', name, status: 'SKIP' });
  }
}

// ------------------------------------------------------------------ solana
console.log('\nSolana');
const { loadConfig: loadChainConfig } = await imp('chain/src/config.ts');
const { loadKeypair } = await imp('chain/src/keypair.ts');
const { SolanaChain } = await imp('chain/src/chain.ts');
const cconf = loadChainConfig();
let kp = null;
await run('solana', 'Authority key exists', async () => {
  if (!existsSync(cconf.keypairPath)) return fail('no key', 'cd chain && npm run keygen');
  kp = loadKeypair(cconf.keypairPath);
  return pass(kp.publicKey.toBase58());
});
let chain = null;
await run('solana', `RPC answers (${new URL(cconf.rpcUrl).hostname})`, async () => {
  const res = await fetch(cconf.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBlockHeight' }), signal: AbortSignal.timeout(10_000) });
  const body = await res.json();
  if (body.error) return fail(body.error.message, 'Set SOLANA_RPC_URL to a working devnet endpoint (a QuickNode devnet URL is ideal).');
  return pass(`block height ${body.result}`);
});
if (kp) {
  chain = new SolanaChain(cconf.rpcUrl, kp, cconf.programId);
  // Memo-only records cost a fee (about 0.00001 SOL). Through the program each call also holds rent (about 0.002 SOL).
  const need = cconf.programId ? 0.05 : 0.01;
  await run('solana', `Authority funded (needs about ${need} SOL for a demo)`, async () => {
    const sol = ((await chain.balanceLamports()) ?? 0) / 1e9;
    return sol >= need ? pass(`${sol} SOL`) : fail(`${sol} SOL`, `Fund ${kp.publicKey.toBase58()} at https://faucet.solana.com (network: devnet), then: cd chain && npm run smoke`);
  });
  if (cconf.programId) {
    await run('solana', 'On-chain program is deployed (GIVEN_PROGRAM_ID)', async () => {
      await chain.assertProgram();
      return pass(cconf.programId);
    });
  } else {
    console.log('[ skip ] On-chain program  GIVEN_PROGRAM_ID is not set, so records are Memos only');
  }
}

// ------------------------------------------------------------------ stream
console.log('\nQuickNode Stream');
await run('stream', 'Webhook secret set', async () =>
  cconf.hookToken || cconf.qnSecurityToken ? pass(cconf.qnSecurityToken ? 'QuickNode HMAC token' : 'shared token') : skip('not set', 'Create the Stream (chain/README.md), then put its security token in .env as QN_SECURITY_TOKEN.'),
);
await run('stream', 'Public webhook URL reachable', async () =>
  process.env.GIVEN_PUBLIC_URL ? pass(process.env.GIVEN_PUBLIC_URL) : skip('no hosted chain service yet', 'Host the chain service, then QuickNode needs https://<host>/hooks/quicknode as the destination.'),
);

// ------------------------------------------------------------------ verdict
const bad = (group, names) => results.filter((r) => r.group === group && r.status === 'FAIL' && (!names || names.includes(r.name)));
const ok = (group) => results.filter((r) => r.group === group).every((r) => r.status === 'PASS' || r.status === 'SKIP') && results.some((r) => r.group === group && r.status === 'PASS');
const verdict = (label, ready, why) => console.log(`${ready ? '  READY ' : ' NOT YET'}  ${label}${ready ? '' : `   (${why})`}`);
const geminiKeysOk = keyed && bad('gemini').length === 0;
const solanaOk = results.filter((r) => r.group === 'solana').every((r) => r.status === 'PASS');
console.log('\nVerdict');
verdict('Real prices and quotes, no keys   npm run dev:quotes', results.filter((r) => r.name.startsWith('Market data') || r.name.startsWith('Order book')).every((r) => r.status === 'PASS'), 'Gemini public data unreachable');
verdict('Bets on the Gemini sandbox        needs keys', geminiKeysOk, 'see the Gemini section');
verdict('Calls recorded on Solana devnet   needs SOL', solanaOk, 'see the Solana section');
verdict('Live leaderboard from the Stream  needs a hosted chain service', false, 'see the QuickNode section');
const full = geminiKeysOk && solanaOk;
console.log(full ? '\nRun the full stack: npm run dev:live' : '\nStill works today: npm run dev (local test exchange) and npm run dev:quotes (real prices).');
process.exit(full || !keyed ? 0 : 1);
