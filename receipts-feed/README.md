# Given receipts and leaderboard feed

Every conditional call the executor places on Gemini gets a receipt on Solana,
and the leaderboard is built from those receipts as QuickNode Streams delivers
them.

```
executor/data/ledger.json
        │  recorder (src/recorder.ts)
        ▼
given_receipts program (../receipts-program)   record_call / settle_call
        │  CallRecorded / CallSettled events
        ▼
QuickNode Streams (Programs + Logs, quicknode/filter.js)
        │  signed webhook
        ▼
feed (src/server.ts)   /leaderboard  /receipts  /events (SSE)
```

## The program

`receipts-program/programs/given_receipts`, Anchor 1.2.2.

- `record_call` writes one receipt account per bet id (PDA `["call", betId]`):
  who called, the event, condition and target contracts, stake, conditional
  price, payout if it hits, and a SHA-256 of the bet's Gemini order legs.
- `settle_call` records how Gemini resolved it. Profit is computed on chain from
  the stake already on the receipt.
- Only the recorder key named in the config account can write. `initialize`
  makes the first signer admin, so run it right after deploying.

Dollar amounts are micro-USD (6 decimals). Price is micro-dollars per $1 of payout.

```bash
cd receipts-program && anchor build && cargo test
```

## The recorder

Reads the executor's ledger and brings the chain up to date: a receipt for each
bet that is `open`, `unhedged` or `settled`, and a settlement once the ledger
has one. It asks the chain what already exists, so restarts never double-send.

```bash
cd receipts-feed && npm install
node src/recorder.ts init     # once per deployment
node src/recorder.ts sync     # one pass
node src/recorder.ts watch    # keep following the ledger
```

## The feed

```bash
node src/main.ts              # listens on :8788
```

| Route | Returns |
| --- | --- |
| `POST /webhooks/quicknode` | Streams destination. Rejects deliveries with a bad `X-QN-Signature`. |
| `GET /leaderboard` | `{ leaderboard, calls, totals }`: ranked by realised profit, then hit rate. |
| `GET /receipts?limit=` | Raw decoded events, newest first. |
| `GET /events` | Server-sent events: `receipt` and `leaderboard` on every new receipt. |

A call settles as `hit` (condition held, target hit), `miss` (condition held,
target missed) or `refund` (condition failed). Hit rate ignores refunds.

## Settings (repo-root `.env`)

| Variable | Used by | Meaning |
| --- | --- | --- |
| `SOLANA_RPC_URL` | recorder | Solana RPC endpoint (the QuickNode one) |
| `RECORDER_KEYPAIR` | recorder | Keypair file; default `~/.config/solana/id.json` |
| `GIVEN_WALLETS` | recorder | JSON map of ledger user to wallet address, e.g. `{"alice":"..."}`. Users without one are attributed to the recorder key. |
| `GIVEN_LEDGER` | recorder | Ledger path; default `executor/data/ledger.json` |
| `RECEIPTS_PROGRAM_ID` | both | Defaults to the id declared in the program |
| `QUICKNODE_STREAM_TOKEN` | feed | The stream's security token |
| `RECEIPTS_FEED_PORT` | feed | Default 8788 |

## Going live on devnet

Not done yet. Order matters: the stream needs the public URL, the recorder
needs the deployed program.

```bash
# 1. Deploy (needs about 2 devnet SOL on the deploy key; get it at faucet.solana.com,
#    the RPC airdrop is closed on devnet)
cd receipts-program && anchor build
solana program deploy target/deploy/given_receipts.so --program-id target/deploy/given_receipts-keypair.json --url devnet

# 2. Repo-root .env
#    SOLANA_RPC_URL=<QuickNode Solana devnet endpoint>
#    QUICKNODE_API_KEY=<QuickNode API key with Streams access>

# 3. Feed, tunnel, stream
cd ../receipts-feed
cloudflared tunnel --url http://localhost:8788      # prints the public URL
#    add WEBHOOK_URL=https://<that host>/webhooks/quicknode to .env
npm run create-stream                               # also writes QUICKNODE_STREAM_TOKEN to .env
node src/main.ts

# 4. Recorder
node src/recorder.ts init
node src/recorder.ts watch
```

The program id is tied to `receipts-program/target/deploy/given_receipts-keypair.json`,
which is not in git. Deploying from another machine needs that file, or a new
id (`anchor keys sync`, then update `DEFAULT_PROGRAM_ID` and the fixture).

`scripts/create-stream.ts` has not been run against the live API; its network
and dataset names are guesses the API will correct on the first call.

## Tests

```bash
npm test          # unit tests, no network
npm run typecheck
npm run e2e       # local validator: ledger -> chain -> filter -> webhook -> leaderboard
```

`test/fixtures/program-logs.json` holds instruction, event and account bytes
captured from the real program, so the TypeScript wire format in `src/codec.ts`
is checked against Rust. Regenerate it after changing the program:

```bash
cd receipts-program && WRITE_LOG_FIXTURE="$PWD/../receipts-feed/test/fixtures/program-logs.json" cargo test
```

`npm run e2e` simulates only QuickNode's delivery: it wraps the real transaction
logs in the Streams payload shape and signs them itself.
