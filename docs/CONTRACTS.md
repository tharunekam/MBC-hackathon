# Interfaces between the web app, the executor and the chain service

*Last updated 2026-11-17 (night). The TypeScript source of truth is `web/src/api/types.ts`. The in-browser mock
(`web/src/api/mock.ts`) implements the same shapes. An integration test (`chain/test/e2e.test.ts`) drives the real
executor handler and the real chain service over HTTP, and caught two mismatches between these types and the executor
(`settlement.pnl`, not `profit`; the per-bet flow field names), so the types below are checked against the real thing.*

```
web (Vite/React, :5273) ──/api──►   executor      (:8741)  places the two Gemini orders, owns the ledger
                        └─/chain─►  chain service (:8742)  commits / reveals calls on Solana, serves the leaderboard
QuickNode Stream ──► chain service  POST /hooks/quicknode        (a hint: every signature is re-read from Solana)
```

Ports are fixed on purpose (`scripts/dev.mjs`); the dev server and the chain service refuse to start if a port is held
or if the executor URL answers as something other than the Given executor. Another project on this machine listens on
8787, the executor's historic default, which is why dev uses 8741.

`?live` in the address bar (or `VITE_API_MODE=live`, which `npm run dev` sets) switches the web app from the mock to
the real services. The nav shows what it is talking to: "Demo data", "Local test exchange", or nothing for Gemini's
sandbox.

## Executor (built; behaviour in `executor/README.md`)

| Endpoint | Used by | Notes |
|---|---|---|
| `GET /health` | venue label | `service: "given-executor"`; the chain service checks this at startup. `readOnly: true` when started with `GIVEN_READONLY=1` (real prices, no account): `POST /bets`, `POST /settle` and `GET /reconcile` then answer 403 `read_only` |
| `GET /markets` | ladder chart | Polled every 4 s. Rungs carry `bid`/`ask`; pairs carry the offer quote |
| `GET /quote?event&condition&target&stake` | quote panel | Authoritative. The UI shows its own estimate (`web/src/lib/pricing.ts`, pinned to the README example by a test) until this answers |
| `POST /bets` | place bet | ~4 s on the sandbox. A refusal is HTTP 422 with `code` and `quote` |
| `GET /bets` | My bets, chain service | Newest first. The chain service reads bets from here and never from the browser |
| `POST /settle` | "Check results" | |
| `GET /flow` | Proof page | |
| `GET /reconcile` | Proof page | **New.** Ledger vs Gemini: orders found, cash tied out |

### Hosted-demo protections (new, all opt-in; see `executor/src/server.ts`)

`GIVEN_HOST` (default `127.0.0.1`), `GIVEN_PINNED_USER`, `GIVEN_MAX_STAKE`, `GIVEN_RATE_LIMIT_PER_MIN`,
`GIVEN_TRUST_PROXY`, and a kill switch: create `executor/data/PAUSED` to stop new bets at once, delete it to resume.
**The server refuses to listen beyond loopback unless it is on the Gemini sandbox and the pinned user, stake cap and rate
limit are all set.**

### Still owed by the executor lane

| What | Why |
|---|---|
| Deploy it (Dockerfile, always-on host, HTTPS) and set the protections above | The hosted demo link. Nothing in the repo deploys it yet |
| Gemini OAuth sign-in, and the sandbox test that a bearer token can place a WebSocket order | Plan gate T-V1; nothing built |
| Sandbox liquidity seeder, demo-history script, replay mode, maker-first pricing | Plan tasks T-V4 to T-V7 |

## Chain service (built; see `chain/README.md`)

| Endpoint | Body / result | Behaviour |
|---|---|---|
| `POST /calls` | `{ betId }` → `CallRecord` (state `committed`) | Reads the bet from the executor (must be an open or settled, fully hedged bet of this user), hashes `(betId, symbols, entry price, fair price, time, salt)`, writes the hash to Solana, returns the signature. The app is fee payer; the user never sees a wallet. Repeating it returns the same record and writes nothing |
| `POST /calls/:id/reveal` | → `CallRecord` (state `revealed`) | Only after the bet settled with the condition held. `409 not_settled` before; `409 void_call` if the condition failed (the call is void and never scored) |
| `GET /calls` | → `{ calls }` | This user's calls, newest first |
| `GET /calls/:id/verify` | → `{ commit, reveal, recomputedHash, matches }` | Re-reads both records from Solana and recomputes the hash |
| `GET /leaderboard` | → `LeaderboardResponse` | Only verified reveals. Ranked by total edge, then calls. `source` is `quicknode-stream` if the Stream delivered any row, else `rpc`; `network` says `devnet` or `fake` |
| `POST /hooks/quicknode` | Stream payload | `Authorization: Bearer <GIVEN_HOOK_TOKEN>` (or QuickNode's HMAC headers). Answers `202` at once, then indexes each signature **from Solana, not from the payload** |
| `POST /admin/backfill` | `X-Admin-Token` | Re-scans the authority's recent transactions. Solana Streams cannot backfill, so this and the automatic backfill are the safety net |
| `GET /health` | | `service: "given-chain"`, network, authority public key, counts, balance |

**On chain, there are two memo shapes** (`chain/src/memo.ts`). Commit: `{g:1, t:"c", h:<sha256>, u:<handle>, at}`.
Reveal: every input of the hash plus the salt and the outcome. The hash preimage is
`given1|betId|event|condition|target|entryPrice(6dp)|fairPrice(6dp)|unixSeconds|salt`, pinned by a test so a verifier
written elsewhere can reproduce it. No Gemini account id and no price feed goes on chain; handles are a keyed hash of the
user name.

**Edge** for a revealed call = `outcome − fairPriceAtEntry`: outcome is 1 if the target hit, 0 if the condition held and
the target missed. A refunded call (condition failed) is `void` and not scored. Rank by the sum and show the number of
calls. No volume, no profit.

**Trust model.** Only memos signed by our authority key count. A reveal counts only if it reproduces its commit, names
that commit, and is the first for it. The outcome is attested by our authority (it is unknown at commit time, so no hash
can cover it); the Gemini order IDs on the owner's bet are the evidence.

**Privacy.** The commit is a salted hash and shows nothing about the bet. Only a user-chosen reveal publishes the call,
under a pseudonymous handle. See the guardrails in `CLAUDE.md`.
