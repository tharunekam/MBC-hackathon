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
`given_receipts` (`../receipts-program`, id [`8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK`](https://explorer.solana.com/address/8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK?cluster=devnet), deployed on devnet
2026-11-17). The Memo is unchanged, so everything that reads Memos keeps working. What the program adds:

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
npm test                     # 122 tests, no network
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
# The program is already deployed on devnet (how: ../receipts-program/README.md).
# On the machine that runs this service: add to the repo-root .env and run the smoke test
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

| | |
|---|---|
| Network | Solana devnet (`solana-devnet`) |
| Dataset | Programs + Logs (`programs_with_logs`) |
| Filter | `quicknode/filter.js`: of each batch of blocks, keeps successful transactions that logged a Given memo, as `{ sig, slot }`; `null` for a batch with none |
| Destination | Webhook: `https://<host>/chain/hooks/quicknode` on the hosted demo (`https://<host>/hooks/quicknode` on a bare chain service), with the header `Authorization: Bearer <GIVEN_HOOK_TOKEN>` |

**Mind the credits.** A Stream is charged for every block it reads, whether or not the filter matches: 30 credits a
block for this dataset, and devnet makes about four blocks a second. That is **about 10.6 million credits a day. The
free trial holds 10 million in total, about 22 hours of running**, and RPC calls draw on the same credits. Create the
Stream paused, start it for a test or a demo, and pause it afterwards. A paused Stream costs nothing and resumes where
it stopped.

From the command line (`QUICKNODE_API_KEY` and `GIVEN_HOOK_TOKEN` in the repo-root `.env`; the API key needs the Streams
application enabled):

```bash
npm run stream -- plan --url https://<host>/chain/hooks/quicknode   # what would be created, tokens hidden; sends nothing
npm run stream -- test-filter      # runs the filter on QuickNode against the block of a real Given record; no Stream needed
npm run stream -- create --url https://<host>/chain/hooks/quicknode # creates it PAUSED
npm run stream -- activate         # start delivering
npm run stream -- pause            # stop spending
npm run stream -- list
```

Or in the dashboard: create a Stream with the four settings above, paste `quicknode/filter.js` as the filter, and set:

1. **Batch size 5 or more, Elastic Batch on.** QuickNode rejects a smaller batch on a chain this fast. The filter
   handles a batch of many blocks.
2. **Payload compression: none.** (The receiver also accepts gzip; QuickNode signs the uncompressed JSON.)
3. **Retries: about 10, a few seconds apart.** The default pauses the Stream after 3 failed tries one second apart, so
   a restart of the service would pause it. **Check it is not paused** before every demo.
4. Optional: put the Stream's security token in `QN_SECURITY_TOKEN` to also check QuickNode's own signature
   (`X-QN-Nonce`, `X-QN-Timestamp`, `X-QN-Signature`: HMAC-SHA256 of nonce + timestamp + body, hex).

Solana Streams cannot replay the past, so anything before the Stream started, or while it was paused longer than
QuickNode keeps its place, is filled by `POST /admin/backfill` (`X-Admin-Token`) or the automatic backfill
(`GIVEN_BACKFILL_MS`, every 60 s on devnet by default). The leaderboard says which rows came from the Stream.

### What is and is not verified

| Verified by running | Not yet verified |
|---|---|
| Hash, memo format, tamper cases, forged signers, duplicate reveals (46 tests) | A commit and reveal driven by a **real executor bet** (the devnet runs below use a synthetic bet) |
| Real executor + chain service over HTTP: win, refund, loss (5 e2e tests) | The filter on a **live Stream**. Its field names match QuickNode's documented payload (checked 2026-11-18) and it is tested on the log lines of real devnet records; `npm run stream -- test-filter` runs it on QuickNode itself |
| Our parser against a real devnet Memo transaction (`npm run inspect -- --latest`) | QuickNode's signature on a **live delivery**. The construction matches QuickNode's docs and sample code (checked 2026-11-18), gzip included; the shared-token header remains the dependable path |
| Webhook auth, replay window, size cap, rate limit, gzipped deliveries | `npm run stream` against the live API: written from QuickNode's published spec with no key to hand; its request shapes are pinned by 12 tests |
| The program: hash check, tamper cases, double reveal, other signers (8 tests against the built program) | |
| **Our own authority key on real devnet, 2026-11-18**, Memo only and through the program: `npm run smoke` passed both ways. Through the program, a reveal with a changed fair price and a second reveal were refused on chain, and the program's own score matched (edge 0.59). Polled confirmation (no WebSocket) worked against the real network. Commit and reveal: [Memo](https://explorer.solana.com/tx/2dA2XhyJyomMuTVXNhs7CSR2nouBnUp96bd8V54djtNiA1aa8n93sy3ynxjgk3Rv86tDCifDJJ82Fdt4Rq7nKHQo?cluster=devnet) / [program](https://explorer.solana.com/tx/5TpSzKdai8P4DVrS7cneVMeR3nJtYKukwdHMnjNBzqPTUcnmrnUN13GL8VQ3gK8u9Qyh8gHRmpPWdN7NJgY6Sj6g?cluster=devnet) | |
| **The proof page in a real browser on real devnet data** (Victor's first program call, ingested through the webhook route): all seven checks passed, program row included | |
| Crash consistency: a salt is saved before its commit is sent; a commit or reveal that landed unrecorded is adopted on retry; a damaged store falls back to its backup or refuses to start (17 tests) | |
| This service's program instructions against bytes captured from the real program (8 tests) | |
| Memo + program in one transaction through this service, **on devnet** (`npm run smoke`, 2026-11-17): [commit](https://explorer.solana.com/tx/2DFD8UjXaPofQh82UXFpwsUm47ArcVkteQAxFSeyjp76CRFtr8tNK7JvZD8Th8NepmctkYqnDypHdKRavEJxQnQL?cluster=devnet), [reveal](https://explorer.solana.com/tx/45iRt5TRfiiyBTY8PDJNp4gbscBsTSfmsW4sZkqPSbKLPgAiGcFTLTKX9hvEgA8hYCP6oFx1iGsBL6LoBJ3DT9xU?cluster=devnet); a changed reveal and a repeated reveal were refused by the program | |

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
