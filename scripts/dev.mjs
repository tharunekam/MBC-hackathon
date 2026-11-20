#!/usr/bin/env node
/**
 * Runs, inspects and stops this project's dev stack on fixed ports.
 *
 *   node scripts/dev.mjs fake     executor over a local test exchange + chain service on an in-memory chain + web
 *                                 (no Gemini key, no SOL; the signatures are not real)
 *   node scripts/dev.mjs quotes  REAL Gemini sandbox prices and order books with no keys: ladders and quotes are live,
 *                                 every order is refused (read-only). Chain is the in-memory test chain.
 *   node scripts/dev.mjs live     real Gemini SANDBOX executor + Solana DEVNET chain service + web
 *                                 (needs .env Gemini keys and a funded chain/data/authority.json)
 *   node scripts/dev.mjs status   what is listening on this project's ports, and whose it is
 *   node scripts/dev.mjs stop     stop this project's servers
 *
 * Ports are fixed: web 5273, executor 8741, chain 8742. If one is taken the stack refuses to start and says by
 * whom; it never moves to another port, because a service that silently talks to another project's server is worse
 * than one that does not start. `stop` only ever signals processes whose working directory is inside this repo.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORTS = { web: 5273, executor: 8741, chain: 8742 };

function lsof(args) {
  try {
    return execFileSync('lsof', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Process listening on a TCP port: { pid, cwd, ours } or null. */
function owner(port) {
  const pid = lsof(['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'])
    .split('\n')
    .find((l) => l.startsWith('p'))
    ?.slice(1);
  if (!pid) return null;
  const cwd = lsof(['-p', pid, '-a', '-d', 'cwd', '-Fn'])
    .split('\n')
    .find((l) => l.startsWith('n'))
    ?.slice(1);
  return { pid: Number(pid), cwd: cwd ?? '(unknown)', ours: Boolean(cwd) && (cwd === ROOT || cwd.startsWith(ROOT + sep)) };
}

function describe(port) {
  const o = owner(port);
  if (!o) return 'free';
  return `${o.ours ? 'THIS PROJECT' : 'ANOTHER PROJECT'}  pid ${o.pid}  in ${o.cwd}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stop() {
  let stopped = 0;
  for (const [name, port] of Object.entries(PORTS)) {
    const o = owner(port);
    if (!o) continue;
    if (!o.ours) {
      console.log(`${name} (${port}): held by another project (pid ${o.pid} in ${o.cwd}); left alone.`);
      continue;
    }
    process.kill(o.pid, 'SIGTERM');
    for (let i = 0; i < 20 && owner(port); i++) await sleep(150);
    if (owner(port)) process.kill(o.pid, 'SIGKILL');
    console.log(`${name} (${port}): stopped pid ${o.pid}.`);
    stopped++;
  }
  if (stopped === 0) console.log('Nothing of this project was running.');
}

function status() {
  for (const [name, port] of Object.entries(PORTS)) console.log(`${name.padEnd(9)} ${String(port).padEnd(6)} ${describe(port)}`);
}

function hasGeminiKey() {
  const f = resolve(ROOT, '.env');
  return existsSync(f) && /^GEMINI_API_KEY=\S+/m.test(readFileSync(f, 'utf8'));
}

async function start(mode) {
  const busy = Object.entries(PORTS).filter(([, p]) => owner(p));
  if (busy.length > 0) {
    console.error('Cannot start. These ports are in use:');
    for (const [n, p] of busy) console.error(`  ${n} ${p}: ${describe(p)}`);
    console.error('Run `node scripts/dev.mjs stop` to stop this project\'s own servers. Servers from other projects are never touched.');
    process.exit(1);
  }
  if (mode === 'live') {
    if (!hasGeminiKey()) {
      console.error('Live mode needs Gemini sandbox keys in .env (GEMINI_API_KEY / GEMINI_API_SECRET). See executor/README.md.');
      process.exit(1);
    }
    if (!existsSync(resolve(ROOT, 'chain/data/authority.json'))) {
      console.error('Live mode needs the Solana authority key. Run: cd chain && npm run keygen, then fund it and check with npm run status.');
      process.exit(1);
    }
  }

  const exec = `http://127.0.0.1:${PORTS.executor}`;
  const services = [
    {
      name: 'exec ',
      cwd: 'executor',
      cmd: ['node', mode === 'fake' ? 'test/serve-fake.ts' : 'src/server.ts'],
      // On the local test exchange the ladder runs in rounds: it closes, settles its bets and opens again by itself, so a
      // bet placed with no keys reaches a result, a reveal and the leaderboard without anyone calling /dev/resolve.
      env: {
        GIVEN_PORT: String(PORTS.executor),
        ...(mode === 'fake' ? { FAKE_ROUND_MINUTES: process.env.FAKE_ROUND_MINUTES ?? '5' } : {}),
        ...(mode === 'live' ? { GIVEN_SANDBOX_WAIVE_MARKUP: '1' } : {}),
        ...(mode === 'quotes' ? { GIVEN_READONLY: '1', GIVEN_SANDBOX_WAIVE_MARKUP: '1' } : {}),
      },
    },
    {
      name: 'chain',
      cwd: 'chain',
      cmd: ['node', 'src/server.ts'],
      env: { GIVEN_CHAIN: mode === 'live' ? 'devnet' : 'fake', GIVEN_CHAIN_PORT: String(PORTS.chain), GIVEN_EXECUTOR_URL: exec },
    },
    { name: 'web  ', cwd: 'web', cmd: ['npx', 'vite'], env: { VITE_API_MODE: 'live' } },
  ];

  const children = [];
  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const c of children) c.kill('SIGTERM');
    await sleep(800);
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  for (const s of services) {
    const child = spawn(s.cmd[0], s.cmd.slice(1), { cwd: resolve(ROOT, s.cwd), env: { ...process.env, ...s.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const tag = `[${s.name}] `;
    for (const stream of [child.stdout, child.stderr]) {
      let buf = '';
      stream.on('data', (d) => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) console.log(tag + l);
      });
    }
    child.on('exit', (code) => {
      if (!shuttingDown) {
        console.error(`${tag}exited with code ${code}; stopping the rest.`);
        shutdown(1);
      }
    });
    await sleep(700); // executor and chain first, so the proxy target exists when the web server starts
  }
  console.log(`\nGiven dev stack (${mode}):  web http://127.0.0.1:${PORTS.web}   executor ${exec}   chain http://127.0.0.1:${PORTS.chain}`);
  console.log('Ctrl-C stops all three. `node scripts/dev.mjs status` shows what is running.\n');
}

const mode = process.argv[2] ?? 'fake';
if (mode === 'stop') await stop();
else if (mode === 'status') status();
else if (mode === 'fake' || mode === 'live' || mode === 'quotes') await start(mode);
else {
  console.error('Usage: node scripts/dev.mjs fake | quotes | live | status | stop');
  process.exit(1);
}
