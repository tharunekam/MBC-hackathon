# Given chain service

Records each call on Solana in two steps and serves the leaderboard.

- **Commit** (when the bet is placed): a salted SHA-256 of the call goes on chain through the Memo program. It shows
  nothing about the bet and nothing about the player.
- **Reveal** (after the bet settles, if the player chooses): the plaintext fields and the salt go on chain. Anyone can
  recompute the hash and compare it with the commit made earlier. A call whose first half failed is refunded, is
  **void**, and is never revealed or scored.
- **Edge** = outcome − fair price at entry (outcome is 1 if the target hit, 0 if the condition held and the target
  missed). The leaderboard ranks by total edge.

Memo records are the shipped path and work alone. The memo format is in `src/memo.ts`; the hash preimage is pinned by a
test in `test/memo.test.ts`, so a verifier written anywhere else can reproduce it.

**On-chain check (opt-in).** With `GIVEN_PROGRAM_ID` set, every record's transaction also calls our Solana program,
`given_receipts` (`../receipts-program`, id `8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK`; built and tested, **not deployed on devnet
yet**). The Memo is unchanged, so everything that reads Memos keeps working. What the program adds:

- A commit creates one account holding the hash, the handle and Solana's own clock time. Nothing about the trade.
- A reveal **fails, and its Memo with it**, unless the revealed fields and salt hash to what was committed. The program
  rebuilds the same preimage text and hashes it on chain. A second reveal of the same call fails too, so a result cannot
  be flipped or counted twice.
- It scores the call (outcome − fair price) and keeps a running total per handle in an account, so the leaderboard can
  be read from accounts alone, with no history replay (`SolanaChain.programScores()`).
- No admin and no setup: records are filed under the key that signed them, and only that key can reveal its own calls.
  A reader counts the authority it trusts, the same rule as for Memos.

## Run

```bash
cd chain && npm install
npm test                     # 64 tests, no network
GIVEN_CHAIN=fake npm start   # in-memory chain: no SOL needed; signatures are not real and are labelled "test chain"
```

From the repo root, `npm run dev` starts the executor (local test exchange), this service (fake chain) and the web app
on fixed ports (web 5273, executor 8741, chain 8742); `npm run stop` stops them; `npm run status` shows who holds the
ports. `npm run dev:live` uses the real Gemini sandbox and Solana devnet (below).

## Real devnet

```bash
npm run keygen    # creates chain/data/authority.json (git-ignored, owner-only) and prints the PUBLIC key
# fund that key on devnet yourself: https://faucet.solana.com  (the faucet asks that AI agents not use it)
npm run status    # shows the balance
npm run smoke     # commit, read back, reveal, index from chain alone, verify; prints explorer links
npm run inspect -- <signature>   # read any transaction through the service's own parser (--latest: newest memo tx)
```

One devnet SOL pays for roughly 200,000 Memo records. Use a QuickNode devnet endpoint instead of the public one for the
demo: `SOLANA_RPC_URL=https://<your-endpoint>`.

### With the program

```bash
# once, from a machine with the Solana and Anchor toolchains and about 1.5 devnet SOL (see ../receipts-program/README.md)
cd ../receipts-program && anchor build && cargo test
solana program deploy target/deploy/given_receipts.so --program-id target/deploy/given_receipts-keypair.json --url devnet

# then, on the machine that runs this service: add to the repo-root .env and run the smoke test
#   GIVEN_PROGRAM_ID=8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK
npm run smoke     # as above, plus: the program's record before and after the reveal, a changed reveal refused,
                  # a repeated reveal refused, and the program's running score
```

The program's accounts hold rent, so a call costs about 0.002 SOL (plus about 0.0015 SOL the first time a handle
reveals) instead of a fee alone: one devnet SOL pays for roughly 450 calls. The service refuses to start if
`GIVEN_PROGRAM_ID` names something that is not a deployed program. Unset it to go back to Memos only; nothing else changes.

## QuickNode Stream (the live feed)

The Stream tells the service which transactions to look at; the service re-reads each one from Solana and verifies it,
so the payload is never trusted.

1. Create a Stream: network **Solana devnet**, dataset **Programs + Logs**, paste `quicknode/filter.js` as the filter.
2. Destination **Webhook**: `https://<public host>/hooks/quicknode`, with a custom header
   `Authorization: Bearer <GIVEN_HOOK_TOKEN>` (set the same value in the service's environment). A laptop needs a tunnel
   for this; the hosted service does not.
3. Optional: also set `QN_SECURITY_TOKEN` to the Stream's security token to accept QuickNode's HMAC headers.
4. Start the Stream before the demo window and **check it is not paused**: a Stream pauses after 3 failed deliveries.
   Solana Streams cannot backfill, so anything before the Stream started is filled by `POST /admin/backfill`
   (`X-Admin-Token`) or the automatic backfill (`GIVEN_BACKFILL_MS`, every 60 s on devnet by default).
5. Streams bill per block processed whether or not the filter matches. Pause the Stream outside dev and demo windows.

### What is and is not verified

| Verified by running | Not yet verified |
|---|---|
| Hash, memo format, tamper cases, forged signers, duplicate reveals (46 tests) | A commit and reveal on **real devnet** (needs the funded key; `npm run smoke` does it) |
| Real executor + chain service over HTTP: win, refund, loss (5 e2e tests) | The filter against a live Stream's payload (`quicknode/filter.js` is written from the docs) |
| Our parser against a real devnet Memo transaction (`npm run inspect -- --latest`) | QuickNode's HMAC construction (the shared-token header is the dependable path until a live delivery confirms it) |
| Webhook auth, replay window, size cap, rate limit | Credits: the Solana devnet per-block multiplier and whether Streams runs on the free trial |
| The program: hash check, tamper cases, double reveal, other signers (8 tests against the built program) | The program **on devnet**: it is not deployed yet |
| This service's program instructions against bytes captured from the real program (8 tests) | |
| Memo + program in one transaction, through this service, on a **local validator** (`npm run smoke` with `SOLANA_RPC_URL=http://127.0.0.1:8899`) | |

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `GIVEN_CHAIN` | `devnet` | `fake` for the in-memory chain |
| `SOLANA_RPC_URL` | public devnet | RPC endpoint |
| `GIVEN_CHAIN_KEYPAIR` | `chain/data/authority.json` | Authority keypair (Solana CLI JSON format) |
| `GIVEN_PROGRAM_ID` | none | The deployed `given_receipts` program. Set: each record is also checked on chain. Unset: Memos only |
| `GIVEN_CHAIN_HOST` / `GIVEN_CHAIN_PORT` | `127.0.0.1` / `8742` | A non-loopback host needs `GIVEN_RATE_LIMIT_PER_MIN` and a webhook secret, or the service refuses to start |
| `GIVEN_EXECUTOR_URL` | `http://127.0.0.1:8787` | The service refuses to run if this is not the Given executor |
| `GIVEN_PINNED_USER` | `primary` | Executor account whose calls this serves |
| `GIVEN_HOOK_TOKEN`, `QN_SECURITY_TOKEN` | none | Webhook authentication. With neither, deliveries are refused |
| `GIVEN_ADMIN_TOKEN` | none | Enables `POST /admin/backfill` |
| `GIVEN_LB_MIN_CALLS` | `1` | Calls a player needs to appear (the plan says 3 for the real thing) |
| `GIVEN_SELF_INGEST` | on for `fake`, off for `devnet` | Index our own reveals at once instead of waiting for the Stream |
| `GIVEN_BACKFILL_MS` | `60000` on devnet | Re-scan interval; `0` turns it off |

## Trust model

Anyone can write a memo, so only memos **signed by our authority key** count. A reveal counts only if it reproduces its
commit's hash, names that commit, and is the first reveal for it. The outcome is attested by our authority, since it is
unknown at commit time and no hash can cover it; the Gemini order IDs on the owner's bet are the evidence.

With the program, the second rule is enforced by Solana instead of by whoever reads the records: a reveal that does
not reproduce its commit, or repeats one, never lands. The outcome is still attested by our authority.
