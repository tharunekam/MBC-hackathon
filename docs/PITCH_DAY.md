# Pitch day: turning everything on, and off again

The QuickNode Stream is kept **paused** until it is needed, because it bills for every block it reads, matched or not (about
270,000 credits an hour on devnet; the free plan holds 10 million). The leaderboard works without it: the chain service reads
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
- Credits used: the dashboard shows the remaining balance. Roughly 4.5k credits a minute while active.

## If something is not working on the day

| Problem | What to do |
|---|---|
| The sandbox has no bettable ladder (top of the hour) | Wait a few minutes, or present from a recorded session: `GIVEN_MODE=replay` plays back a real recorded bet with nothing behind it (`docs/DEPLOY.md`, "Replay"). Say it is a replay |
| Gemini sandbox is down or slow | The same replay, or `GIVEN_MODE=fake` (labelled "Local test exchange"; present it as exactly that) |
| The Stream shows paused or failing | `npm run quicknode -- pitch-on` again. The leaderboard keeps filling from the minute-by-minute read, so nothing on screen breaks |
| The public address changed (quick tunnel restarted) | Update `GIVEN_PUBLIC_URL`, restart the server, then `npm run quicknode -- pitch-on --recreate` so the Stream points at the new address |
| The laptop sleeps | Keep it awake while presenting (`caffeinate -dimsu`), or use a host |

## What to say, and not say

- "Money back if…", never "risk-free" or "guaranteed". Show the cost: the app does.
- "Uses Gemini's API; not affiliated with Gemini." Say it is the **sandbox**, and say when a screen is a replay or the local test exchange.
- The QuickNode Stream: network Solana devnet, dataset Programs + Logs, a filter that keeps successful transactions that logged
  a Given memo, delivered to a webhook that re-reads every transaction from Solana and verifies it, so a forged delivery cannot
  add a row. The RPC read is the safety net under it.
