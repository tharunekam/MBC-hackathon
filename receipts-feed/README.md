# Given chain service: calls on Solana, leaderboard from QuickNode Streams

This is the "chain service" of `docs/CONTRACTS.md` (on the `plan/scope-v2`
branch) together with its Solana program. When a bet fills, a salted hash of the
call goes on Solana. After the event closes the caller may reveal it; the
program checks the reveal against the hash, scores it, and the leaderboard is
built from the reveal events as QuickNode Streams delivers them.

```
web app ── POST /calls {betId} ──► chain service ◄── GET /bets ── executor
                                        │ commit_call(hash) / reveal_call(details, salt, result)
                                        ▼
                    given_receipts program (../receipts-program), Solana devnet
                                        │ CallCommitted / CallRevealed events
                                        ▼
                    QuickNode Stream (Programs + Logs, quicknode/filter.js)
                                        │ signed webhook
                                        ▼
web app ◄── GET /leaderboard ── chain service  POST /hooks/quicknode
```

## How Solana is used

Program `given_receipts`, Anchor 1.2.2, id
`8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK` (devnet deployment: not done yet).

- **`commit_call(hash)`** creates one record per call holding only
  `sha256("given:call:v1" ‖ borsh(call details) ‖ salt)` and the chain's time.
  Nothing about the user or the trade can be read from it.
- **`reveal_call(details, salt, target_hit)`** publishes a call. The program:
  recomputes the hash and rejects any detail that was changed after the fact;
  requires that the commitment was made **before** the event closed and that
  the event **has** closed (the chain's clock, not ours); computes
  `edge = (1 if the target hit, else 0) − fair price at entry`; and adds it to
  that handle's running total (a `CallerStats` account per handle).
- A call whose condition failed is refunded and never revealed, so it is never
  scored. A call that is never revealed stays a bare hash forever.
- What a reveal publishes: bet id, pseudonymous handle, event ticker, the two
  contract symbols, fair price at entry, placed and closing times, a SHA-256 of
  the bet's Gemini order legs, and the result. **No stake, payout or profit**
  ever goes on chain, and the leaderboard cannot rank by size.
- The service's key is fee payer and the only signer the program accepts, so
  users never see a wallet. This also means the result (`target_hit`) is
  attested by our key: the program proves *when* the call was made and that it
  was not altered, and the order-leg hash lets the account holder show the
  orders behind it; it does not prove what Gemini resolved.

The leaderboard can be rebuilt three ways that must agree, and `npm run e2e`
checks that they do: from the Stream, from RPC transaction history, and from
the `CallerStats` accounts alone.

```bash
cd receipts-program && anchor build && cargo test
```

## How QuickNode Streams is used

| | |
| --- | --- |
| Network | Solana devnet |
| Dataset | Programs + Logs |
| Filter | `quicknode/filter.js`: keeps successful transactions whose logs show our program being invoked (directly or by CPI) and trims each to signature, slot, block time and logs. Blocks without one deliver nothing. |
| Destination | Webhook, `POST /hooks/quicknode` on this service |
| Why | The Stream is the leaderboard's data source: every row comes from a `CallRevealed` event it delivered. The service does not score its own transactions. |

Deliveries are checked against `X-QN-Signature` (HMAC-SHA256 over nonce +
timestamp + body with the stream's security token; 401 otherwise), answered at
once, and deduplicated by transaction signature, so redeliveries are harmless.
Solana Streams cannot replay the past, so on start-up the service reads any
program transactions it has not seen from RPC. Those are marked `rpc`, and
`GET /leaderboard` reports `source: "rpc"` whenever a counted call had to come
that way.

## API

Shapes follow `web/src/api/types.ts`. Errors are `{ error, code }`; the web app
shows `error` as written.

| Route | Result |
| --- | --- |
| `POST /calls` `{ betId }` | `CallRecord`, state `committed`. Idempotent. 404 `not_found`, 409 `not_filled` / `too_late` / `no_fair_price` / `no_expiry`, 503 `chain_unavailable` |
| `POST /calls/:id/reveal` | `CallRecord`, state `revealed`. Idempotent. 409 `not_settled` / `void_call` / `not_scorable` |
| `GET /calls[?user=]` | `{ calls }`, newest first. Calls whose condition failed show as `void` |
| `GET /calls/:id` | One `CallRecord` |
| `GET /leaderboard` | `LeaderboardResponse`: rows ranked by total edge, plus `totals` |
| `GET /receipts?limit=` | Raw decoded events, newest first, each with its `source` |
| `GET /events` | Server-sent events: `receipt` and `leaderboard` on every new event |
| `POST /hooks/quicknode` | Streams destination |
| `GET /health` | `{ ok, receipts, calls }` |

The service listens twice. The full API above is on `:8788`, bound to this
machine like the executor. A second listener on `:8789` is the one to put
behind a tunnel or proxy: it takes the Stream and serves the public reads
(`/leaderboard`, `/receipts`, `/events`, `/calls/:id`, `/health`), and answers
404 to committing, revealing and listing calls, because until the executor has
sessions nothing can tell whose request it is.

Where this differs from, or adds to, the contract as written:

- `GET /calls` cannot know who is signed in until the executor has sessions. It
  takes `?user=` and otherwise `GIVEN_DEFAULT_USER`; with neither it lists every
  call.
- `LeaderboardResponse` carries an extra `totals: { committed, revealed, handles }`.
- `minCalls` is 3 (the plan's number; the mock uses 1). `LEADERBOARD_MIN_CALLS` changes it.
- "Fair price at entry" is the executor's `offer.fairPrice`. If a bet has none,
  the price paid stands in, which can only understate the edge.
- Writes are accepted from this machine and from `GIVEN_CORS_ORIGINS`, nowhere
  else, so another site cannot publish a user's call.
- The web dev server needs a `/chain` proxy to `http://127.0.0.1:8788`
  (`web/vite.config.ts` has only `/api` today).

The service also commits filled bets by itself (every `CHAIN_POLL_MS`), so
bets placed outside the web app are covered. A reveal is the user's choice,
except for the users listed in `CHAIN_AUTOREVEAL_USERS` (meant for the seeded
demo accounts).

## Settings (repo-root `.env`)

| Variable | Meaning |
| --- | --- |
| `QUICKNODE_STREAM_TOKEN` | Required. The stream's security token |
| `SOLANA_RPC_URL` | Solana RPC endpoint (the QuickNode one). Without it the service still takes the Stream and serves the leaderboard; commits and reveals answer 503 |
| `RECORDER_KEYPAIR` | Fee payer and recorder key; default `~/.config/solana/id.json` |
| `GIVEN_EXECUTOR_URL` | Where to read bets; default `http://127.0.0.1:8787` |
| `GIVEN_LEDGER` | Read bets from this ledger file instead of the executor's API |
| `GIVEN_DEFAULT_USER` | Whose calls `GET /calls` lists when no `user` is given |
| `GIVEN_CORS_ORIGINS` | Comma-separated web origins allowed to commit and reveal |
| `GIVEN_HANDLE_SALT` | Secret behind the handles; generated and kept in `data/calls.json` if unset |
| `LEADERBOARD_MIN_CALLS` | Revealed calls needed to appear; default 3 |
| `CHAIN_AUTOCOMMIT` | `0` stops the service committing filled bets by itself |
| `CHAIN_AUTOREVEAL_USERS` | Comma-separated executor users whose settled calls are revealed without asking |
| `CHAIN_POLL_MS` | How often to look for new bets; default 5000 |
| `RECEIPTS_PROGRAM_ID` | Defaults to the id declared in the program |
| `RECEIPTS_FEED_PORT`, `CHAIN_BIND` | The full API; default 8788 on 127.0.0.1 |
| `RECEIPTS_PUBLIC_PORT`, `CHAIN_PUBLIC_BIND` | Webhook and public reads; default 8789 on 127.0.0.1 |

`data/` (git-ignored) holds `calls.json`, which contains the salts that open
the commitments, and `receipts.jsonl`, the delivered events. Losing
`calls.json` means the calls committed so far can never be revealed.

## Going live on devnet

Not done yet. Order matters: the stream needs the public URL, the service
needs the deployed program.

```bash
# 1. Deploy (needs about 2 devnet SOL on the deploy key; get it at faucet.solana.com,
#    the RPC airdrop is closed on devnet)
cd receipts-program && anchor build
solana program deploy target/deploy/given_receipts.so --program-id target/deploy/given_receipts-keypair.json --url devnet

# 2. Repo-root .env
#    SOLANA_RPC_URL=<QuickNode Solana devnet endpoint>
#    QUICKNODE_API_KEY=<QuickNode API key with Streams access>

# 3. Service, public URL, stream
cd ../receipts-feed && npm install
npm run init                                        # once: makes the deploy key admin and recorder
node src/main.ts                                    # API on :8788, public listener on :8789
cloudflared tunnel --url http://127.0.0.1:8789      # prints the public URL
#    add WEBHOOK_URL=https://<that host>/hooks/quicknode to .env
npm run create-stream                               # also writes QUICKNODE_STREAM_TOKEN to .env if missing
```

`initialize` makes its first caller the admin, so run `npm run init` (or start
the service, which does the same) straight after deploying.

The program id is tied to `receipts-program/target/deploy/given_receipts-keypair.json`,
which is not in git. Deploying from another machine needs that file, or a new
id (`anchor keys sync`, then update `DEFAULT_PROGRAM_ID` and the fixture).

`scripts/create-stream.ts` has not been run against the live API; its network
and dataset names are guesses the API will correct on the first call. A Stream
is billed per block whether or not the filter matches, so pause it in the
QuickNode dashboard outside demo and test windows.

## Tests

```bash
npm test          # unit tests, no network
npm run typecheck
npm run e2e       # local validator: bets -> commit -> reveal -> filter -> webhook -> leaderboard
```

`test/fixtures/program-logs.json` holds instruction, event and account bytes
captured from the real program, so the TypeScript wire format and commitment
hash in `src/codec.ts` are checked against Rust. Regenerate it after changing
the program:

```bash
cd receipts-program && anchor build && WRITE_LOG_FIXTURE="$PWD/../receipts-feed/test/fixtures/program-logs.json" cargo test
```

`npm run e2e` runs the real program on a local validator, including the
program refusing a reveal before the event closes. It simulates only the
executor (a list of bets in memory) and QuickNode's delivery: it wraps the real
transaction logs in the Streams payload shape and signs them itself.
