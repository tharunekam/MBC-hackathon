# Pitch day: turning everything on, and off again

The QuickNode Stream is kept **paused** until it is needed, because it bills for every block it reads, matched or not (about
450,000 credits an hour on devnet, measured at about 4.2 blocks a second on 2026-11-20; the free plan holds 10 million). The leaderboard works without it: the chain service reads
our authority's recent transactions from Solana every minute. The Stream's job in the pitch is to be the live feed, and to
be the evidence for the QuickNode bounty, so it is on for a short window only.

## Before the day (once)

- [ ] A host is running the image (`docs/DEPLOY.md`) with `GIVEN_PUBLIC_URL`, the Gemini sandbox keys (**both** key and secret),
      `GIVEN_AUTHORITY_KEY`, `GIVEN_PROGRAM_ID`, `SOLANA_RPC_URL`, `GIVEN_HOOK_TOKEN` and `QN_SECURITY_TOKEN`.
- [ ] `npm run check:deploy -- <url>` passes all 11 checks. A quick `trycloudflare.com` tunnel fails the live-updates check
      because it holds streamed responses back; the page then refreshes by polling and still works. A real host or a named
      tunnel should pass it.
- [ ] `npm run quicknode -- plan` shows the webhook address people really open (`<GIVEN_PUBLIC_URL>/chain/hooks/quicknode`).
- [ ] `npm run quicknode -- test-filter` says FILTER OK (it runs our filter on QuickNode against a real record; no Stream needed).

## Checked end to end on 2026-11-20 (a laptop with no Gemini keys, behind a quick tunnel)

A real devnet commit and reveal (written by `cd chain && npm run smoke`, through our program) were read by the Stream's filter,
delivered to the public webhook, re-read from Solana and verified by the server, and the leaderboard's source changed from
"Read from Solana" to "Live from Solana". What was run, in order, so it can be done again:

1. `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8080`, then put its `https://….trycloudflare.com` address in `.env` as `GIVEN_PUBLIC_URL`.
2. `npm run build`, then `GIVEN_INTERNAL_EXECUTOR_PORT=18741 GIVEN_INTERNAL_CHAIN_PORT=18742 GIVEN_EDGE_TRUST_PROXY=1 PORT=8080 node scripts/serve.mjs`
   (quotes mode with the devnet chain from `.env`; the internal ports keep clear of `npm run dev`, which holds 8741 and 8742).
3. `npm run quicknode -- plan`, `test-filter` (FILTER OK) and `test-delivery` (202, 202, 401).
4. `npm run quicknode -- pitch-on --recreate`: the Stream is replaced by a fresh one pointing at the tunnel.
5. `cd chain && node --env-file=../.env scripts/devnet-smoke.ts`: a commit and a reveal on devnet. Seconds later the leaderboard says "Live from Solana".
6. `npm run quicknode -- pitch-off`.

Notes from the review of that run: the server serves the `index.html` it read at start, so restart it after every `npm run build`; `GIVEN_INTERNAL_EXECUTOR_PORT` and `GIVEN_INTERNAL_CHAIN_PORT` move its two private ports; add `HOST=127.0.0.1` behind a tunnel so it is not also open to the local network. `pitch-on` now checks that the receiver is on devnet, builds the replacement Stream before deleting the old one, and replaces a Stream that still delivers to an old address (`status` shows where it delivers). A 202 from the webhook proves only that the address is reachable and the secret right: judge ingestion by a real record, not by the sample delivery.

A paused Stream cannot be resumed for long on the free plan (devnet moves about 4 blocks a second), so every start after a pause is `pitch-on --recreate`.
A tunnel's address changes whenever it restarts: repeat step 1, then `pitch-on --recreate`.

## Once, on the machine that holds the Gemini keys, after the 2026-11-20 order-path changes

The executor's order path changed on the last day (a repeated request id places one bet, a lost order answer is looked up by its tag, a sale that cannot be confirmed says so, the page sends a price limit). Everything was proven against the local test exchange, a Gemini wire stand-in and the rehearsal, **not** against the real sandbox, which is the repo's own rule for order-path changes. Ten minutes:

- [ ] `npm run preflight` is green, then `npm run dev:live` (or the hosted image in live mode).
- [ ] Place one bet of each kind from the app on a ladder that has been open a few minutes: Stake Back up, Stake Back down, Range, Breakout, and a basket of two. Each shows two filled orders.
- [ ] Press Place bet twice quickly on one of them: exactly one bet appears in My bets.
- [ ] Cash one of them out and check the sale in My bets.
- [ ] `cd executor && node src/cli.ts reconcile` reports every order found and a difference of $0.00 (or the page's Proof check says so).
- [ ] `npm run check:deploy -- <url> --bet` passes.

If any step fails, do not demo live: use the replay (`GIVEN_MODE=replay`, below) and say so.

## About 30 minutes before presenting or recording

1. Open the app on the phone and the laptop. Pick a ladder that has been open at least 15 minutes (new hourly ladders are
   post-only at first) and confirm the button reads **Place bet**.
2. `npm run quicknode -- pitch-on`
   It sends a signed test delivery to the public address first and refuses to start the Stream if that is not accepted, so
   credits are never spent on a Stream that cannot be heard. If QuickNode will not resume the paused Stream (the free plan only
   resumes within 100 blocks of the tip), run `npm run quicknode -- pitch-on --recreate`: it replaces it with a fresh Stream.
3. Check the dashboard: the Stream is **active**, no failed deliveries. A Stream pauses itself after repeated failures.
4. Place one real sandbox bet (`npm run check:deploy -- <url> --bet`, or by hand). Within a few seconds the commit appears;
   once it settles and is revealed, the leaderboard's source changes from "Read from Solana" to "Live from Solana", and the
   Stream's delivery count in the dashboard goes up. **That delivery is the proof for the bounty**: take the screenshot now.
5. Leave it on for the pitch.

## Straight after

- `npm run quicknode -- pitch-off`, then confirm the status says paused. Nothing is billed while it is paused.
- Credits used: the dashboard shows the remaining balance. Roughly 7.5k credits a minute while active.

## If something is not working on the day

| Problem | What to do |
|---|---|
| The sandbox has no bettable ladder (top of the hour) | Wait a few minutes, or present from a recorded session: `GIVEN_MODE=replay` plays back a real recorded bet with nothing behind it (`docs/DEPLOY.md`, "Replay"). Say it is a replay |
| Gemini sandbox is down or slow | The same replay, or `GIVEN_MODE=fake` (nothing on screen says it is a test, so say aloud that it is the local test exchange, not Gemini; set `FAKE_ROUND_MINUTES=5` so its ladder settles by itself) |
| The Stream shows paused or failing | Find the cause first in the dashboard delivery log (401: the tokens differ; 404, 502 or 530: the address or the server), then `npm run quicknode -- pitch-on --recreate`: on the free plan a paused Stream is almost never resumable. The leaderboard keeps filling from the minute-by-minute read, so nothing on screen breaks |
| The public address changed (quick tunnel restarted) | Update `GIVEN_PUBLIC_URL`, restart the server, then `npm run quicknode -- pitch-on --recreate` so the Stream points at the new address |
| The laptop sleeps | Keep it awake while presenting (`caffeinate -dimsu`), or use a host |

## What to say, and not say

- "Money back if…", never "risk-free" or "guaranteed". Show the cost: the app does.
- What these are: **defined-outcome bets**. Every result is on screen before you bet. Not "structured products" (that
  means something an issuer packages and stands behind; Given issues and holds nothing), and not "protected" or "buffer".
- Range is "it stays put", Breakout is "a big move, either way". Say that, not "volatility". We found no venue listing
  "finishes outside these two levels" as one contract; say "we found none", never "first".
- The ladder as a histogram is not new (Kalshi shows one on some range markets). What is ours is setting a person's view
  against it and listing the bets that pay for the difference.
- The leaderboard: revealing is your choice, making the call is not hidden. It shows calls sealed beside calls revealed.
- "Uses Gemini's API; not affiliated with Gemini." Say it is the **sandbox**, and say when a screen is a replay or the local test exchange.
- The QuickNode Stream: network Solana devnet, dataset Programs + Logs, a filter that keeps successful transactions that logged
  a Given memo, delivered to a webhook that re-reads every transaction from Solana and verifies it, so a forged delivery cannot
  add a row. The RPC read is the safety net under it.
