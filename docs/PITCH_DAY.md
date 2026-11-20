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
   post-only at first) and confirm the button reads **Place bet**. If the ticket shows "This market has only just opened",
   pick another: on 2026-11-20 a bet on such a ladder had its second order refused and was sold back for half its stake.
   For a basket, put each leg on a different market and stay out of a ladder's last half hour: three sandbox baskets on
   one thin ladder stopped after the first leg (`docs/PLAN.md`).
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
| Gemini sandbox is down or slow | The same replay, or `GIVEN_MODE=fake` (nothing on screen says it is a test, so say aloud that it is the local test exchange, not Gemini; set `FAKE_ROUND_MINUTES=5` so its ladder settles by itself) |
| The Stream shows paused or failing | `npm run quicknode -- pitch-on` again. The leaderboard keeps filling from the minute-by-minute read, so nothing on screen breaks |
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
- The Outlook (Markets page) is "the market's forecast, read from its own prices for each closing time". Say "how far
  the market expects it to move by then", not "implied volatility", and "nothing is modelled". On the test exchange there
  is one closing time, so it is one fan from now to the close; the sandbox and the demo data show several.
- "Were the market's odds right?" counts revealed calls only, and with a handful of calls it says so. Do not present a
  short table as proof of anything.
- "Uses Gemini's API; not affiliated with Gemini." Say it is the **sandbox**, and say when a screen is a replay or the local test exchange.
- The QuickNode Stream: network Solana devnet, dataset Programs + Logs, a filter that keeps successful transactions that logged
  a Given memo, delivered to a webhook that re-reads every transaction from Solana and verifies it, so a forged delivery cannot
  add a row. The RPC read is the safety net under it.
