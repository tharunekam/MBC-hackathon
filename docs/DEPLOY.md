# Hosting the demo

The submission needs a **working demo or deployed app** a judge can open. This is everything required to put Given on a
host, and how to know it works. The host is not chosen yet; nothing here depends on which one it is.

## What runs

One container, one public port. Inside it `scripts/serve.mjs` starts the executor and the chain service on loopback and
serves the built web app plus a **fixed list of paths** to them (`scripts/lib/edge.mjs`). Dev, admin and anything not
listed is a 404 from outside. Both backends keep their own hosted protections on: one pinned account, a stake cap and a
per-client rate limit.

```
browser ──https──> host proxy ──> :8080  serve.mjs ──> executor :8741  (Gemini sandbox)
                                          │         └─> chain    :8742  (Solana devnet)
                                          └─ web/dist (the app)
```

Verified here: the image builds (515 MB), runs as a non-root user, serves the app and real sandbox prices, and
`scripts/check-deploy.mjs` passes against it. **Not** verified here: any real host, and live mode (it needs Gemini keys,
which are on Victor's machine).

## What the host must provide

| Need | Why |
|---|---|
| Run a Docker image, or `node scripts/serve.mjs` on Node 24 | Node 24 runs the TypeScript directly |
| **Exactly one instance** | The ledger, the salts and the authority key are one unit with the Gemini account. A second instance with its own copy of them breaks the reconcile and can lose a salt |
| A **persistent volume** mounted at `/data` | `ledger.json`, `calls.json` and the authority key live there. Without it a restart forgets every bet and every salt, and a bet that was not revealed can never be proved |
| HTTPS in front, and **no response buffering** | Live updates are server-sent events. A proxy that buffers makes the page fall back to polling (it still works, only slower) |
| A health check on `/healthz` | 200 when both backends answer, 503 otherwise |

## Settings

Set these as the host's secrets/environment. Nothing is read from a `.env` file in the image.

| Variable | Needed | Meaning |
|---|---|---|
| `GIVEN_PUBLIC_URL` | **always** | The address people open, an origin with no path: `https://given.example.com`. It is the one browser origin the backends accept; without it every bet from the page is refused. The server will not start without it |
| `GIVEN_MODE` | no | `auto` (default): live if keys are present, else quotes. `live`, `quotes` or `fake` to force one |
| `GEMINI_API_KEY`, `GEMINI_API_SECRET` | live | **Sandbox** keys, with time-based nonce enabled. The server refuses a non-sandbox `GEMINI_BASE_URL` |
| `GIVEN_AUTHORITY_KEY` | live | The Solana authority key as the JSON array of its 64 bytes (the contents of `chain/data/authority.json`). Written once to `/data/chain/authority.json` with mode 600, never overwritten |
| `GIVEN_PROGRAM_ID` | live, optional | `8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK`: each record is also checked on chain by our program. Costs about 0.002 SOL of rent per call |
| `SOLANA_RPC_URL` | live, recommended | A private devnet RPC (a free QuickNode endpoint works). The public one rate-limits and failed a backfill in the first real run |
| `GIVEN_HOOK_TOKEN`, `QN_SECURITY_TOKEN` | for the Stream | Made by `npm run quicknode -- keys`. The Stream sends the first as an `Authorization: Bearer` header and signs each delivery with the second; the receiver accepts either. Deliveries are refused until one is set |
| `GIVEN_SEEDER` | no | `1` also runs the sandbox liquidity seeder (our own quotes from a second sandbox account) and switches the app's "Seeded prices" label on. Needs `GEMINI_USER_SEEDER_KEY` / `GEMINI_USER_SEEDER_SECRET`, which must not be the betting account's. Live mode only. Read `executor/README.md` first: the seeder has not been run on the sandbox yet |
| `GIVEN_ADMIN_TOKEN` | no | A secret for the two operator-only routes, neither of which is reachable from outside: the chain service's `/admin/backfill`, and the executor's `/review`, which records what Gemini paid for a bet it settled without a plain yes or no (`executor/README.md`, "Recording what such a bet paid"). Without it both are off |
| `GIVEN_MAX_STAKE` | no | Dollars per bet, default 25 |
| `GIVEN_RATE_LIMIT_PER_MIN` | no | Bets and settles per client per minute, default 20 |
| `GIVEN_PINNED_USER` | no | Account every request acts as, default `primary` |
| `GIVEN_SANDBOX_WAIVE_MARKUP` | no | Default 1: the sandbox's books are about 20 cents wide, so without it almost nothing passes the value rule. Sandbox only |
| `GIVEN_EDGE_TRUST_PROXY` | no | The image sets 1: the client address is the last entry the host's proxy appended to `X-Forwarded-For`. Set 0 if the container is reached directly |
| `PORT`, `HOST` | no | Default `8080`, `0.0.0.0` |

## First deploy

1. Build and run it in **quotes mode** first. It needs only `GIVEN_PUBLIC_URL`, shows real sandbox prices, and has bets switched off.
   ```bash
   docker build -t given .
   docker run -p 8080:8080 -e GIVEN_PUBLIC_URL=https://your-address -v given-data:/data given
   ```
2. Check it from outside: `npm run check:deploy -- https://your-address` (11 read-only checks, places nothing).
3. Add the live settings (`GEMINI_API_KEY`, `GEMINI_API_SECRET`, `GIVEN_AUTHORITY_KEY`, `GIVEN_PROGRAM_ID`, `SOLANA_RPC_URL`) and
   restart. Check the authority is funded: `npm run preflight` on any machine with the key, or look at `/chain/health`.
4. Check again, this time with a bet: `npm run check:deploy -- https://your-address --bet` places one $2 sandbox bet and
   records its call. Pick a ladder that has been open a few minutes: new hourly ladders are post-only at first.

## Moving the history that already exists

The first real run happened on Victor's laptop, so the won, lost and refunded bets and their salts are there. To show them
on the host, copy `executor/data/ledger.json` and everything in `chain/data/` (including `authority.json`) into the host's
`/data/executor` and `/data/chain` **before the first live start**, and stop the laptop's executor for good. Two executors
on one Gemini account with different ledgers is the failure that breaks the reconcile. The laptop's leaderboard also has a
synthetic first row from `npm run smoke` (same authority key), so either use a fresh authority for the demo or set
`GIVEN_LB_MIN_CALLS` above 1.

## Keeping it up through judging

- **Sandbox ladders expire hourly.** A bet needs a live ladder; check one is open and not post-only before recording or presenting.
- **The laptop must not sleep** if the demo runs there (the first settle failed once for that reason). A host does not have this problem.
- Logs: the container prints both backends' output, each line tagged `[exec ]` or `[chain]`.
- If either backend exits, the whole process exits so the host restarts a known-good state.

## A fallback for the stage

The first real run showed the sandbox can have no bettable ladder for a few minutes at the top of the hour (new ladders are
post-only first) and often fills only a few dollars. Two things keep a presentation safe:

- Have a ladder already chosen and checked: open `/app`, confirm the button reads "Place bet", and place the bet before
  the pitch if you can. `npm run check:deploy -- <url> --bet` does the same from a terminal.
- If the sandbox is unusable, a second deployment with `GIVEN_MODE=fake` and `GIVEN_I_KNOW_THIS_IS_A_TEST=1` runs the
  whole flow on the local test exchange with an in-memory chain. It labels itself "Local test exchange" in the nav and
  footer, and **must be presented as exactly that**: it shows the product working, not Gemini. Say so on stage.

## Without a host

`npm run build && npm start` runs the same server on this machine. Behind a tunnel (any HTTPS tunnel to port 8080, with
`GIVEN_PUBLIC_URL` set to the tunnel's address) it is a serviceable demo link for a few hours. It is a fallback, not the plan.
