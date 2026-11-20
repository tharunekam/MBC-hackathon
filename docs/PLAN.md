# Given — plan to submission

*Last updated 2026-11-17, Tuesday evening (v2: scoped against the official
rules and Gemini / QuickNode / Solana docs). A plan, not a contract: move
things, swap lanes and re-cut as needed, and update this file when you do.*

## The thesis

Win the **Gemini Prediction Markets bounty** first. Everything else follows from
a product that is real, honest and polished:

- The bounty's 1st place is **one of the 13 finalist slots** (see "How finals
  are picked"). It is our most direct route to Austin.
- Judges are Gemini's own people. What they can see in two minutes: real orders
  on their API, real order flow (the "Flow to Gemini" panel), a concept they have
  said they will "evaluate after launch" (conditional logic), and a cost that is
  shown, not hidden.
- Then stack: **Consumer Apps** track, **Best use of Solana**, **QuickNode
  Streams**, and the automatic **Official Winner** consideration. Maximum if
  everything lands: $2,500 + $2,000 + $1,500 + $500 + $2,500 = **$9,000**.

Last year's rubric rewarded "Focused Execution": a polished working prototype
beats an ambitious one. This plan is built around that. When in doubt, cut a
feature and polish the golden path.

## Build status (end of Tuesday 2026-11-17)

**Added that night, for the day the keys arrive:**
`npm run dev:quotes` (real Gemini sandbox prices and order books with no keys; running it on real data found and fixed three
web bugs the fake exchange hid), `npm run rehearse` (the golden path through the real executor and chain code with Gemini and
Solana stood in on the wire: 16 checks, fails when sabotaged), `npm run preflight` (what is ready and the fix for what is not),
`.env.example`, polled Solana confirmation with typed errors, and the Solana and Gemini wire stand-ins with their tests
(186 tests). Real devnet and real sandbox runs are still the only proof of the parts the stand-ins cannot cover. Our chain lane
overlaps Victor's deployed Anchor program: see `docs/CHAIN_RECONCILE.md`. Name candidates: `docs/NAMES.md`.

**First run on the real Gemini sandbox and real Solana devnet together (Victor's laptop, 2026-11-18 just before
midnight CST; branch `run/live-sandbox-devnet`).** This is the machine that holds the Gemini sandbox key.

- `npm run preflight`: every Gemini check passes (keys accepted, terms accepted, signed order session opens).
- `npm run dev:live` with `GIVEN_PROGRAM_ID` set: three real bets placed, each two filled Gemini orders, each call
  committed on devnet through `given_receipts` by the chain service. This closes open item 1 in
  `docs/CHAIN_RECONCILE.md` (a call driven by a real executor bet).
- **Found and fixed:** Gemini nets YES against NO on one contract and pays $1 a pair early, so two bets sharing a
  strike left the reconcile off by exactly $1.00. Fixed in the executor with tests; the Proof page is back to $0.00 on
  the live account. Details in `docs/GEMINI_API_NOTES.md`.
- **All three outcomes on the real stack (07:00 UTC ladders).** Won (`196968b1`, +$1.31), lost (`3e179ffd`, −$3.16) and
  **refunded** (`dc55923f`: SOL ended below $75, payout $3.24 on a $3.18 cost). The refunded call's reveal was refused
  with `409 void_call` and its state became `void`; the other two revealed and verified from chain. `reconcile` tied to
  $0.00 again, My bets showed "Money back", and the leaderboard showed 4 calls, 50% hit rate, edge +0.78. The first
  settle attempt failed with `gemini_error: fetch failed` because the laptop had slept; the retry worked. **A demo
  machine must not sleep** (the app's keep-awake lapses when the session goes idle).
- **Found, not fixed (Product lane):** on a refused pair the button always says "Pick a closer target", even when the
  reason is a post-only market or an out-of-order ladder, where moving the target does not help; the default pair on
  a ladder can be two near-certain rungs showing "Fair price per $1: 101¢"; the Proof page does not yet show the
  reconcile's new `nettedCash` line; when depth at the best price is momentarily zero the builder shows "The market can
  only fill about $0.00", payoffs of $0.00 and a live "Place bet · $0.00" button; on a pair refused because the outcome
  costs as much as the condition the hint says "try moving the target closer" when it needs to move further; after a
  bet is placed the "How this bet pays" panel keeps the full-stake figures while the receipt shows the reduced ones.
- **Settled, revealed and scored for real.** After the 06:00 UTC expiry: one bet won (+$0.41), one lost (−$3.45; the
  condition held and the target missed), `reconcile` tied to $0.00 before and after, both calls were revealed through
  the program and `GET /calls/:id/verify` recomputed both hashes from chain, and the leaderboard showed the handle with
  2 calls and edge 0.3934 once the RPC backfill ran (about 3 minutes; there is no Stream yet, and one backfill attempt
  failed on the public devnet RPC before the next succeeded). A refunded call followed an hour later (next bullet but one).
- **A bet placed by clicking in the web app, on the real stack (06:16 UTC).** Dragged both markers on the ETH ladder,
  clicked Place bet, and the receipt showed both Gemini orders filled and the Solana record with its explorer link
  (bet `196968b1`). Two more bets sharing its strike then netted 3 contracts and the reconcile still tied to $0.00.
  **Two earlier clicks on an enabled button did nothing** (no bet reached the executor, no message on screen); one was
  while the button read "Place bet · $0.00". Product lane: see the list below.
- **Sandbox behaviour to plan the demo around:** newly listed hourly ladders were `active/post_only` (no taker orders)
  from 06:03 to at least 06:06 UTC and open by 06:15 (ETH and SOL; BTC and XRP were still post-only then), and some go
  post-only briefly later too, a bet of ours can itself push a thin ladder out of order and get the next bet
  refused, and depth at the best price is often 1 to 8 contracts, so a $5 stake is cut to about $0.60 to $3.50.
- This laptop's chain authority is `9GVno5tV2moikfXqZyZAuxw2pmqGZ4nmU9DKXhiDhM4X` (1 devnet SOL). **The ledger, the
  salts in `chain/data/` and that key are one unit with the Gemini account:** history seeded here shows up in the hosted
  demo only if that state moves to the host, and a second executor on the same Gemini key with a fresh ledger breaks the
  reconcile. Decide the host before seeding the demo history (T-V5).

**Second machine, Wednesday 2026-11-18 afternoon (the one with the Solana toolchain; PR #4).**

- **A fresh clone works.** `npm run install:all`, `npm test` (448), `npm run typecheck`, `npm run rehearse` (19 checks),
  `npm run e2e` (18 checks) and `npm start` + `npm run check:deploy` (11 checks, real sandbox ladders) all pass there.
  CI now runs the tests, a production build and the rehearsal on every push.
- **The sandbox's listing changed and broke the builder.** Gemini listed 34 ladders (oil, metals and gas were added),
  four with prices. On a phone the page was about 6,000px wide, the page could open on a ladder with nothing to quote,
  and XRP's ladder (two-cent steps) was drawn squashed into the left edge of its chart. Fixed, with a browser check
  that feeds the page 30 unpriced ladders. **Look at `npm run dev:quotes` before recording**: it shows what a judge
  will see that day, which the local test exchange cannot.
- **QuickNode:** the filter and the signature check match QuickNode's current docs. A running devnet Stream costs about
  10.8M credits a day against a 10M free trial, so it runs only for tests and demos. `npm run quicknode`.
- **Program:** the deployed bytes are a clean `anchor build` of the committed source; its interface is published on
  chain. It is still upgradeable by the deploy key.
- **Secret scan:** gitleaks and a pattern search over every branch's history found no key, token or keypair. Commit
  metadata carries Victor's personal email address and a machine-local address for Tharun; decide whether that is
  wanted before the repository goes public.

**Three products, Thursday 2026-11-19.** The app has a tab for each product. **Return Parlay** goes either way: a falling
bet is the same engine on the mirror image of the ladder. **Range** wins if a price finishes between two levels. **Basket**
places two to six of these bets in one request. All of them are placed, settled, committed on Solana, revealed and verified
through the same code. `npm run rehearse` (33 checks, 34 with injected failures) does it through the real executor and chain
code, and `npm run e2e` (21 checks in Chrome) places a basket of all three kinds from the page and finds it grouped on My bets.
The new bets are also tested over the real Gemini client against the wire stand-in, order by order. **Not yet run on the
real Gemini sandbox:** the three products have only run against the local test exchange and the stand-ins, so the first run
with sandbox keys must place one of each and then `node src/cli.ts reconcile`. (That run happened later the same night:
see "Cash-out, and the three products on the real sandbox" below.) Cut: the "chain" bet (given A, then B, will C)
because it is the same bet as "given B, will C"; "across markets" and "without the favourite" stay out because the exchange
has no contract that links them (`docs/GIVEN.md`: decisions 5 and 7 and the list of other ideas; the three products are decisions 20 to 23).

**Cash-out, and the three products on the real sandbox, Thursday night (branch `feat/cash-out`, Victor's laptop).**

- **Cash-out is built.** An open bet can be sold back from My bets: `GET /cashout` prices both orders at the live bids
  and sends nothing, `POST /cashout` sells them as two immediate-or-cancel orders, held to the price shown less two
  cents. Refused before any order when a market is not taking orders, a leg has no bid, less rests at the best price
  than the bet holds, or another open bet holds the other side of a contract. Decisions 25 and 26 in `docs/GIVEN.md`;
  how it works in `executor/README.md`, "Cashing out".
- **Run on the real Gemini sandbox, 02:22 to 02:29 UTC on 11-20.** A rising parlay, a falling parlay and a range were
  each placed and cashed out, a fourth over HTTP, and `reconcile` tied out after every step (to $0.000085: one fill
  reported a rounded average price). **This was also the first time a falling parlay and a range were placed on the
  sandbox at all**; both went in as designed (a NO on the lower strike and a YES on the higher; a YES on the lower and
  a NO on the higher, equal size).
- **A falling parlay, a range and a basket leg settled on the sandbox (03:00 UTC).** The three bets left open were
  settled by `settle` 75 seconds after expiry with clean results: the range finished outside and paid $1.78 on 1.78
  contracts (the dollar that always comes back), the falling parlay and the basket's parlay leg lost, and `reconcile`
  tied out again. None of the three happened to win or be refunded, so those two results are still only seen for a
  rising parlay.
- **A basket was placed whole on the sandbox at 03:14 UTC, after three that stopped part-way.** `bk-a1e4e8d3`: a parlay on the BTC
  ladder and one on the XRP ladder, four filled orders, `reconcile` tied out (46 of 46 orders matched). The three
  before it, all on one SOL ladder in its last 40 minutes, each stopped after the first leg: twice because the ladder
  had gone out of order by the time the second leg was checked, once because the first leg's hedge could not be filled
  and it was sold back. Those legs are in the ledger and reconciled, so the "not all-or-nothing" behaviour is seen for
  real too. **For the demo, put a basket's legs on different ladders, and not in a ladder's last half hour.**
- **The cash check drifts by a hundredth of a cent per odd fill.** When a fill spans two price levels Gemini reports
  a rounded average, and each one has moved the cash difference by about $0.000085 (two so far: $0.00017). The check
  passes within half a cent, so it would take dozens of such fills to fail it. Worth knowing before seeding a long
  history on the demo account; reading each fill's own price from the trade history would remove it.
- **Found and fixed on that run:** a basket whose first leg was refused before any order answered 201 with no bets in
  it; it is now a 422 like any refused basket. `npm run install:all` skipped the root package, so `npm run e2e` failed
  on this machine until the root was installed; it now installs it.
- **What the sandbox's books mean for the demo.** With the offer rule on, **0 of 590 pairs were on offer** at 02:21
  UTC; every bet above needed `GIVEN_SANDBOX_WAIVE_MARKUP=1`. The books are about 20 cents wide, so a parlay cashed out
  at once returned a third to a half of its stake ($0.58 sold for $0.19; $1.00 for $0.55), and the range $2.68 of
  $2.99. Recording the video on these books shows cash-out working and losing most of the stake. The seeder (T-V4,
  needs a second sandbox account) is what makes the numbers look like production.
- **Not proven on the sandbox:** a sale that stops part-way (only the fake exchange has exercised it), and cashing out
  a bet Gemini has netted against another (it is refused).
- Tests: 229 executor, 121 chain, 227 web, 51 scripts; `npm run rehearse` 33 checks; `npm run e2e` 22 checks, the new
  one selling a bet from My bets through the production build; `npm run e2e:replay` 7 checks.

**Verified by running** (599 tests across the four packages; the golden path and the three products were also driven in a
real browser against the real executor handler and chain service): bet builder on the probability ladder, quote, place,
receipt, My bets, settle, reveal, leaderboard, Proof (reconcile to the cent). Details of what is and is not verified:
`chain/README.md`.

| Task | State |
|---|---|
| T-P1 to T-P5 shell, ladder, quote, place flow, My bets, Proof, Flow | **Done** on mock and live (local test exchange) |
| T-P6 leaderboard, call page, share card, explorer links | **Done**: the leaderboard, a call page (`/verify/:signature`, a shareable card with a copy-link button), explorer links, and **Save image** on the call page (a 1200×630 picture of the call, sized for link previews; checked in a real browser by the e2e run) |
| T-P7, T-P8 landing copy, polish, design review | **Review pass done 2026-11-18** at 1280 and 390 wide, both themes: no sideways scroll anywhere; fixed the phone order (quote right after the chart), refusal wording, chart labels, and the default pair on a closed ladder. `npm run e2e` guards it. A second look by someone who did not build it is still worth an hour |
| T-P9 README, Devpost, video, pitch | README current; Devpost answers and shot list drafted in `docs/SUBMISSION.md`; **video not recorded** (needs a live ladder on the hosted demo) |
| T-V1 OAuth test | Not started. The sandbox key is on Victor's laptop; registering a sandbox OAuth app needs the account owner |
| T-V2 host the executor | **Built, not yet deployed.** `scripts/serve.mjs` serves the built app and a fixed allowlist of API paths from one public port with the backends on loopback; `Dockerfile`; `npm run check:deploy` checks a deployed URL from outside; the guide is `docs/DEPLOY.md`. The image builds and runs here (non-root, real sandbox prices). **Needs a host, then the live settings** |
| T-V3 `GET /reconcile` | **Done**. Event feed not needed: the chain service reads bets from the executor |
| T-V4 sandbox liquidity seeder | **Built and tested, not run on the sandbox** (`executor/src/seeder.ts`, `npm run seed`). It needs a **second sandbox account**. A dry run on the live sandbox's public prices: 0 of 112 pairs pass the offer rule as the books stand, 7 would with 4-cent quotes resting, 22 with 2-cent quotes. The app labels itself "Seeded prices" when `GIVEN_SEEDED=1`. First-run steps in `executor/README.md` |
| T-V5 history script | `scripts/seed-history.mjs` places and finishes a win, a refund and a loss |
| T-V7 replay mode | **Built and tested.** `GIVEN_RECORD=<file>` records what the app is shown during a real session; `GIVEN_MODE=replay GIVEN_REPLAY=<file>` plays it back with no executor, no chain service, no keys and no network, under a "Replay" label. `npm run e2e:replay` records a bet through the real app in Chrome and replays it. **Still to do: record a real sandbox session on the machine with the keys** (steps in `docs/DEPLOY.md`) |
| T-V6, T-V8 maker-first, production quotes | Not started |
| T-C0 Memo smoke test | **Done 2026-11-18**: commit and reveal with our own key on real devnet, Memo only and through Victor's program (`npm run smoke`); the proof page verified real devnet records in a browser |
| T-C1 Anchor program | **Done; the Wednesday gate is met.** `given_receipts` is deployed on devnet (`8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK`) and recorded a commit and a reveal there on 11-17 through the chain service's smoke test (links in `chain/README.md`). It checks each record in the same transaction as its Memo when `GIVEN_PROGRAM_ID` is set. **Still to do:** set `GIVEN_PROGRAM_ID` where the demo's chain service runs, once its authority key is funded. Memo records stay the fallback |
| T-C2 chain service | **Done** (commit, reveal, verify, void handling) |
| T-C3 Stream, filter, webhook | Webhook receiver done and tested, gzip included. Filter and signature check **confirmed against QuickNode's docs** (2026-11-18) and tested on real devnet log lines. `npm run quicknode` (keys, plan, test-filter, test-delivery, create, activate, pause) is written from the docs and OpenAPI spec and **has not been run with a key**. **Stream not created** (needs `QUICKNODE_API_KEY` and a public URL). **Credits: about 10.8M a day running (devnet makes a block every 240 ms, measured), against a 10M free trial**: run it only for tests and demos |
| T-C4 leaderboard, backfill | **Done** |
| T-C5 verify-from-chain page | **Done** (`web/src/pages/Verify.tsx`, `web/src/lib/verify.ts`); verified in a browser against real devnet records |

**Blocked on the owners (nothing here can be done by us alone):**

1. ~~Fund the Solana authority key~~ **Done** (3 devnet SOL; a smoke run costs about 0.003).
2. ~~Put Gemini sandbox keys in `.env`, then `npm run dev:live`~~ **Done on Victor's laptop 2026-11-18** (see above). Other
   machines still need their own key, or use `npm run dev:quotes`. The OAuth test needs a sandbox OAuth app registered
   by the account owner.
3. Create the QuickNode Stream: put an API key (Streams enabled) in `.env`, then `npm run quicknode -- test-filter` and
   `create` (steps in `chain/README.md`). It is created paused; `activate` for a test or a demo, `pause` after. **A
   running Stream uses the whole free trial in under a day.**
4. Pick and open a host for the executor, chain service and web app (the hosted demo link).
5. If the demo should run with the markup waiver off and at full stake: create a **second Gemini sandbox account** and
   key for the liquidity seeder, then follow "First run" in `executor/README.md`. Say on screen and in the pitch that
   the prices are seeded.
6. After the freeze, make the Solana program final (one command on the machine that holds the deploy key; it cannot
   be undone). See `receipts-program/README.md`, "Who can change it".
7. Merge to `main`, re-run the secret scan, decide about the email addresses in commit metadata, then make the
   repository public.

## Hard facts from the official rules (checked 2026-11-17)

Sources: the Devpost overview and Rules tab (`ubc-hackathon-2026.devpost.com`)
and the organizers' attendee guide. Re-read the Rules tab once more before
submitting; these pages can change.

| Fact | What it means for us |
|---|---|
| **In person at the Nov 21 finals is required for any prize**, bounties included. "Participants must be present in person during final presentations to qualify for prizes." No remote option found. Travel grants closed Nov 13. | **Decide travel today** (D4). If nobody can be in Austin on Saturday, every prize is off the table and the plan should change. |
| "All projects must be fully built during the hackathon week. Work created before Nov 13 is not allowed." The repo must be created during the hackathon. | Our first commit is Nov 16: fine. **Never copy code in from older projects.** Write it here, in this repo. |
| Eligibility contradicts itself: the Overview says "Students only" and "invite only"; the Rules tab says "students, independent builders, and community members". Teams of 1–4. | **Email the organizers now** (`uniblockchainconferences@gmail.com`) and keep the reply. |
| Submission closes **Fri Nov 20, 12:00 PM CST**. Needs: a **public repo** with setup instructions, a **working demo or deployed app**, a **2–3 minute video** (YouTube or Drive, viewable by judges), a README with technical documentation and an architecture overview, and the five written answers (what you built, what problem it solves, how it works, what makes it unique, what you'd build next). | We need a **hosted demo link** (T-V2). A localhost-only app fails "working demo or deployed app". |
| Five judging criteria, no stated weights: Technical Execution, Product & UX, Innovation, Impact & Potential, Demo. | The scorecard in "How we are judged" below. |
| Opt-ins are manual. Only Official Winner is automatic. | Tick the track, chain award, each bounty and the matching prize boxes on Devpost. |
| Chain award: pick **one**, Solana or Arc, never both. You compete only against same-chain projects in your track. Needs program IDs and a README section on how the chain is used. | Solana (decided; see D2). |
| QuickNode bounty: Streams as "a core data source", at least one Stream with a **filter and a destination**; README must say **network, dataset, filter logic and destination**. | The README section is the scoring evidence. Write it as we build. |
| Consumer track: "interact with the blockchain in some way", a **working user-facing frontend**, crypto "invisible" (no bridging, gas, seed phrases), "something people would want to use every day". | Matches Given. The app, not the user, signs and pays for the Solana record. |
| AI tools are allowed, "but builders must remain the primary creators". | Both teammates must be able to explain every component live (already in the plan). |

### How finals are picked

Up to 13 teams pitch (5 minutes plus 2 of Q&A): for each of the 3 tracks, the
top Track Winner, Solana and Arc contender (9), the top 3 Official Winner
contenders, and **the Gemini bounty's 1st-place team**.

Our realistic routes to the stage: Gemini bounty 1st, Solana contender in the
Consumer track (few Solana projects compete there), Track Winner, Official top 3.

### Dates that don't move

| When (CST) | What |
|---|---|
| Wed Nov 18, 11:00 | Gate: OAuth test (T-V1) |
| Wed Nov 18, 14:00 | Gate: Solana program recorded one call on devnet, or fall back to Memo (T-C1) |
| Thu Nov 19, 12:00 | Gate: golden path green end to end; no new features after |
| Thu Nov 19, 15:00 | **Feature freeze** (our own rule) |
| Thu Nov 19, 22:00 | Video recorded; README complete |
| **Fri Nov 20, 12:00 PM** | **Submission deadline.** Submit by 09:00; edits stay open until noon |
| Fri Nov 20, 11:59 PM | Finalists notified |
| Sat Nov 21 | Finals and closing ceremony, UT Austin |

Office hours (6–7 PM CST, drop-in): Gemini Tue 17 and **Thu 19**; QuickNode
**Wed 18**; Solana **Wed 18 and Thu 19**. The question lists are in "Office hours".

## What we're entering

- Main track: **Consumer Apps**.
- Chain award: **Best use of Solana**.
- Bounties: **Gemini Prediction Markets** and **QuickNode Streams**.
- Not entering: ElevenLabs (see P2 below, decided on Wednesday night), Grok Bot.

## How we are judged

| Criterion | What the judge should see |
|---|---|
| Technical execution | Two real orders on Gemini's API over WebSocket, depth guard, hedge sizing, a ledger that **reconciles to Gemini's cash balance to the cent** (a live proof page), 63 tests. Solana program + Stream-fed leaderboard with a verify-from-chain page. |
| Product & UX | Drag two handles on a live probability ladder; four plain-language numbers; the stake-back story in one glance. No wallet, no gas, no seed phrase. |
| Innovation | A refund-if-the-condition-fails bet we found no one-tap retail version of (say it that way, never "first ever"). Commit-reveal calls: prove you called it before it happened, privately until you choose to reveal. |
| Impact & potential | "Flow to Gemini": every bet is two orders on Gemini's book, counted by tag. Evidence of demand for conditional logic. Honest cost, and a plan for maker-first pricing. |
| Demo | A hosted link that works for a judge with no setup, plus a tight 2–3 minute video and a 5-minute stage pitch with a rehearsed fallback. |

## Scope

### P0 — must ship (the golden path)

1. **Bet builder on a probability ladder.** A chart of "chance of finishing at or
   above each strike" with two draggable handles snapped to real rungs: the
   *condition* (lower strike) and the *target* (higher strike). Live quote from
   the executor.
2. **The four numbers, plus three outcomes.** Chance both happen · fair price ·
   what you pay (with spread and Gemini's fees) · what you'd get selling now. And
   a plain strip: *if both hit → you win $X · if the condition fails → stake
   back · if only the condition hits → you lose the stake*.
3. **Place the bet** as two real sandbox orders, with a progress state (order
   1 filled → hedge filled → recorded on Solana) and clear refusal and
   partial-fill messages.
4. **My bets**: open, settled (won), **refunded**, lost, and needs-review, each
   with Gemini order IDs.
5. **Flow to Gemini** panel (orders, contracts, premium, fees at production rates).
6. **Solana record of each call** with an explorer link; **commit at bet time,
   reveal after settlement (opt-in)** — see "Architecture".
7. **QuickNode Stream → webhook → leaderboard**, with a call page per record.
8. **Hosted demo, public README, video, Devpost.**

### P1 — strong value, cheap; do when P0 lanes are green

- **Connect Gemini (OAuth, sandbox).** Real consumer-app sign-in instead of
  our pre-connected demo accounts. Gemini's docs say a bearer token can
  authenticate the WebSocket and sandbox apps register immediately; whether the
  token can place orders is still to be proven (gate Wed 11:00). Production needs
  Gemini's review, so the demo stays sandbox either way.
- **Sandbox liquidity seeder.** The sandbox books are ~20¢ wide (production is
  ~4¢), so the offer rule refuses almost everything and depth cuts bets to ~$1.
  A second sandbox account resting tight quotes on the ladders we demo makes the
  app look like production. **Disclose it in the README and the pitch.**
- **Proof page.** One button runs `reconcile`: ledger versus Gemini orders and
  cash. This is the "technical execution" slide.
- **Share card.** Each revealed call gets a page and an image: the call, the
  fair price at entry, the result, the explorer link. This is the consumer loop.
- **Verify-from-chain page.** Rebuild the leaderboard from Solana alone.
- **Replay mode.** Record real sandbox responses; if the sandbox or venue Wi-Fi
  fails during the pitch, the app replays a real session, clearly labelled.
- **Maker-first pricing** (Decision 13). Halves the markup and adds resting
  liquidity to Gemini's book. Maker fees are waived through 2026-12-31 per
  Gemini's docs.
- **Production read-only quote view.** What this bet would cost on production
  today. Blocked on the market-data licence answer (see "Risks").

### P2 — only if Thursday 12:00 is green

- **Voice bet entry (ElevenLabs).** The bounty needs voice to be "a core
  feature" and the video must show audio. Prize is 3 months of ElevenLabs Scale
  per member, not cash, so only do it if the frontend is ahead. Decide Wed night.
- ~~Range bets ("between A and B") and "given below X"~~ **Done 2026-11-19**: the Range and the falling Return Parlay.
- Read-only sports ladder browser.

### Cut

Already out: the Living Tokens vault, trigger orders across markets, combos,
"given the favourite doesn't win" (see `docs/GIVEN.md`). Also out: Grok Bot,
Arc, DeFi track.

If behind, cut in this order: production quote view → P2 → verify-from-chain →
replay mode → maker-first → OAuth (use demo accounts) → custom Solana program
(Memo records instead).

**Never cut:** the golden path, real sandbox orders, the fair-versus-paid quote,
Flow to Gemini, a Solana record, the Stream-fed leaderboard, explorer links, the
hosted demo, README sections and the video.

## Architecture and the interfaces between lanes

```
 browser (web/)  ──►  executor (hosted)  ──►  Gemini REST + WebSocket (sandbox)
      │                    │  bet filled / settled
      │                    ▼
      │              chain service ──► Solana devnet: given_registry program
      │                                      │  program logs
      │                                      ▼
      └──── leaderboard ◄── webhook ◄── QuickNode Stream (filter on program ID)
```

**Commit-reveal.** At fill time the chain service writes a **hash** of the call
(bet ID, symbols, entry price, timestamp, salt): it identifies nothing and
reveals nothing. After settlement the user may **reveal**: the program checks the
hash, stores the result and an "edge" score. Only revealed calls reach the public
leaderboard. This keeps us inside the guardrail "nothing that identifies a user's
trades on a public chain" and gives the Solana program real work (state, checks,
per-user records), not just a log line.

**Who signs.** The app is the fee payer and authority, so users never see a
wallet. The user is a pseudonymous ID (a salted hash of the Gemini account), not
a public key. Say plainly in the README that the result attestation trusts our
authority key, and that the Gemini order IDs are the evidence.

**Leaderboard score.** For a revealed call: outcome 1 if both hit, 0 if the
condition held and the target missed, *void* if the condition failed (money back,
no score). Edge = Σ (outcome − fair price at entry). Rank by edge, show the
number of calls, and require at least 3 resolved calls to appear. No volume, no
profit.

**Interfaces to agree first** (so the frontend can run on mocks from hour one):

| Interface | Shape |
|---|---|
| Executor (exists) | `GET /markets`, `GET /quote`, `POST /bets`, `GET /bets`, `POST /settle`, `GET /flow`, `GET /health`. Needs: auth/session, `GET /reconcile`, a bet-filled / bet-settled event the chain service can consume |
| Chain service (new) | `POST /calls` (commit; returns tx signature), `POST /calls/:id/reveal`, `GET /calls/:id`, `GET /leaderboard` |
| QuickNode webhook (new) | `POST /hooks/quicknode`: verify HMAC, return 2xx immediately, dedupe by transaction signature, then process |

Put these types in `docs/CONTRACTS.md` today and generate mock data from them.

## Lanes and task board

Three lanes, two people. Owners are a proposal: swap freely, but each lane
needs one name. Hour figures are rough estimates assuming a Claude session
doing most of the typing; they are for ordering work, not promises.

- **Product lane** (proposed owner: whoever leans frontend). The most visible
  and most underestimated lane. It also owns the pitch, video and Devpost.
- **Venue lane** (proposed owner: whoever built the executor).
- **Chain lane**. The biggest unknown. After T-V1 to T-V3 the Venue owner takes
  it; if one person is clearly ahead, they take it.

| ID | Task | Est. | Done when |
|---|---|---|---|
| **Product** | | | |
| T-P1 | `web/` shell, design tokens, light + dark, typed API client, **mock mode** from `docs/CONTRACTS.md` | 3h | App runs with no backend; swapping mock for the live executor is one flag |
| T-P2 | Probability ladder + pair picker + live quote + three-outcome strip | 6h | Dragging a handle updates all four numbers within ~1 s; refused pairs say why in plain words |
| T-P3 | Confirm and place-bet flow with progress, refusals, partial fills | 4h | A sandbox bet from the UI shows two Gemini order IDs |
| T-P4 | My bets + proof page (`reconcile`) | 3h | One refunded and one won bet visible with order IDs; proof page ties to the cent |
| T-P5 | Flow to Gemini panel | 2h | Matches `GET /flow` totals |
| T-P6 | Leaderboard, call page, share card, explorer links | 4h | Rows come from the Stream, not the executor |
| T-P7 | Landing page, onboarding (Connect Gemini / demo account), copy per the wording guardrails | 3h | No "risk-free", no partnership claim, "not affiliated with Gemini" visible |
| T-P8 | Polish: both themes, 390 px, loading / empty / error states, a design review pass | 3h | Checked on rendered pixels, not just code |
| T-P9 | README, Devpost answers, video, 5-minute pitch, Q&A bank (`docs/SUBMISSION.md`) | 8h | Logged-out check of repo, demo link and video |
| **Venue** | | | |
| T-V1 | **OAuth test:** sandbox app, token, WebSocket `order.place` | 2h | Gate Wed 11:00. Fail → demo accounts (`GEMINI_USER_<NAME>_KEY`) |
| T-V2 | **Host the executor:** Dockerfile (Node 24), always-on host, HTTPS; per-visitor session, stake cap (e.g. $5), rate limit, CORS to the web origin, kill switch, sandbox-only lock. Today it binds to 127.0.0.1 and trusts the `user` field | 4h | A stranger's browser can place a capped sandbox bet; abuse is bounded |
| T-V3 | Bet-filled / bet-settled event for the chain service; `GET /reconcile` | 2h | Chain service receives both events for a real bet |
| T-V4 | Sandbox liquidity seeder (second account, tight quotes on demo ladders) | 3h | Median spread on seeded ladders under ~6¢; offer rule passes without the waive switch |
| T-V5 | Demo history script: places a mix of won, **refunded** and **lost** bets on hourly ladders, which settle within the hour | 2h | History includes at least one of each; a loss is kept on purpose |
| T-V6 | Maker-first pricing | 6h | Sandbox run shows fill time, leg risk and lower markup |
| T-V7 | Replay mode | 3h | App runs a recorded real session with a visible "replay" label |
| T-V8 | Production read-only quote endpoint | 2h | Only after the licence answer |
| **Chain** | | | |
| T-C0 | **Memo smoke test:** one devnet memo tx → Stream → webhook delivery | 45m | Proves the QuickNode plan streams devnet before any program exists |
| T-C1 | `given_registry` program: `commit_call`, `reveal_call`, deployed to devnet; Solana Playground if the local toolchain fights back (time-box 2 h to first deploy) | 8h | Gate Wed 14:00. Fail → Memo records (JSON, signed by us) |
| T-C2 | Chain service: fee payer / authority, commit, reveal, hash verification | 4h | Executor event → on-chain commit in one call |
| T-C3 | Stream + filter + webhook: HMAC check, 2xx fast, dedupe by signature, idempotent writes, hosted always-on | 4h | Stream shows delivered, leaderboard row appears |
| T-C4 | Leaderboard scoring + RPC gap-fill (Solana streams can't backfill) | 3h | Rebuild from RPC matches the Stream-fed table |
| T-C5 | Verify-from-chain page | 2h | Leaderboard reproduced with no backend |

## Schedule

All times CST. Evenings are for sponsor office hours and for review, not
for building a new feature.

| Slot | Product | Venue | Chain |
|---|---|---|---|
| **Tue eve** | Agree D1–D7; write `docs/CONTRACTS.md`; email organizers | Join Gemini office hours if still open; start T-V1 | T-C0 (Memo smoke test); claim the QuickNode plan |
| **Wed am** | T-P1, start T-P2 on mocks | **T-V1 (gate 11:00)**, then T-V2 | T-C1 (program or Playground) |
| **Wed pm** | T-P2, T-P3 against the live executor | T-V2 done, T-V3; ask QuickNode and Solana at office hours | **T-C1 gate 14:00**; T-C2 |
| **Wed eve** | T-P4, T-P5 | T-V4 seeder running; T-V5 history | T-C3 stream live; **decide ElevenLabs (D6)** |
| **Thu am** | T-P6, T-P7 | T-V6 / T-V7 if green | T-C4, T-C5 |
| **Thu 12:00** | **Gate: golden path green.** No new features after this | | |
| **Thu pm** | T-P8 polish; **freeze 15:00**; demo at Gemini office hours (6 PM) | Bug fixes only; final seeded history | Bug fixes only; pause the Stream outside demo windows |
| **Thu night** | Video, README, Devpost draft; secret scan; repo public; logged-out checks | | |
| **Fri am** | **Submit by 09:00**, re-check every link logged out; rehearse pitch | | |

Rehearse the pitch at least three times out loud before Saturday, once with
the sandbox deliberately switched off to practise the replay fallback.

## Demo golden path

1. Open the hosted app. Drag the two handles on a live BTC ladder; the four
   numbers move. (Under 20 seconds.)
2. Confirm. Two Gemini order IDs appear.
3. The call is committed on Solana; an explorer link appears.
4. The Stream delivers it; the activity row appears.
5. Open earlier bets: one **won**, one **refunded**, one **lost**. Reveal one;
   the leaderboard updates from the Stream.
6. Proof page: ledger versus Gemini orders and cash, tied to the cent.
7. Flow to Gemini: what all of it sent to the order book.

Hourly sandbox ladders settle within the hour, so seed history on Wednesday and
Thursday rather than the night before (T-V5). Keep a deliberate loss in the
history; judges trust a product that shows one.

### Five-minute pitch (finals)

| Time | Beat |
|---|---|
| 0:00–0:30 | The hunch: "BTC holds 63k — will it reach 64.5k?" Everyone has half a hunch; every bet punishes the half you're unsure of |
| 0:30–1:00 | The gap: parlays lose everything when the first leg fails; we found no one-tap refund-if-fails bet on a regulated exchange |
| 1:00–2:30 | Live demo (golden path, trimmed) |
| 2:30–3:15 | Under the hood: two Gemini orders, Solana commit-reveal, QuickNode Stream, reconcile to the cent |
| 3:15–4:00 | Honesty: the cost (about 5¢ over fair per $1 on a good pair), refused pairs, maker-first |
| 4:00–4:30 | What it gives Gemini: order flow, and demand evidence for conditional contracts |
| 4:30–5:00 | Close and ask |

Q&A bank to prepare (`docs/SUBMISSION.md`): why pay more than fair? · what is the
fee? · what if the market is thin or a leg fails to fill? · is this legal / does
Gemini allow it? · who can see my trades? · what happens in production? · why
Solana? · how is this different from a parlay or "draw no bet"? · what if the
condition and target settle differently? · why is the leaderboard trustworthy?

## Office hours: what to ask

**Gemini (Tue tonight if still open; Thu for sure — Gemini's people are our
bounty judges, so Thursday is also a demo slot):**

1. Is a free consumer app that places each user's own orders acceptable, and what
   does production review involve and how long does it take? *(tests the concept)*
2. Can an OAuth bearer token place orders over the WebSocket, and with which scope?
3. **May we display Gemini prices publicly?** The API agreement calls market data
   proprietary and says redistribution needs a separate agreement.
4. Do third-party-routed orders count for the taker rewards programme? Any
   builder code or attribution planned?
5. Can the sandbox list a sports ladder, and are its books ever tightened?
6. Fees: rounded per order or per fill? How do void or fractional settlements appear?
7. Is the combo request-for-quote beta open to sandbox keys? (Docs conflict: the
   overview says beta in production; the spec says creation is not enabled.)
8. What would a Gemini judge most want to see in a bounty submission?

**QuickNode (Wed):** Is Streams usable on the free trial? What is the Solana
devnet credit multiplier? Is there a UBC plan or code? Can a stream resume from a
given slot after a pause? **Solana (Wed/Thu):** Anchor 1.2.2 / Solana 4.1.2 — any
build problems? Is Playground's Anchor version current?

## Risks and hazards

| Risk | Mitigation |
|---|---|
| **Nobody can be in Austin Saturday**: all prizes void | D4 today; if not possible, re-plan around the online deliverables only |
| Eligibility mismatch (students only vs open) | Email organizers; keep the reply |
| Sandbox flakiness at finals (WebSocket drops, REST orders return 500, wide spreads, venue Wi-Fi) | Seeder (T-V4), replay mode (T-V7), recorded video as the last fallback; test on a phone hotspot |
| QuickNode credits: billed per block whether or not the filter matches. **Measured 2026-11-18: 30 credits a block, about 360k blocks a day (a 240 ms slot), so about 10.8M credits a day. The free trial is 10M in total (under a day)** and RPC shares it | Create the Stream paused; `npm run quicknode -- activate` before a test or demo and `pause` after (failed deliveries aren't billed, filtered-out blocks are). A paid plan is about $6.50 a day if it must run through judging |
| A Stream **pauses after 3 failed deliveries** (default) | Always-on webhook, 2xx before doing work, idempotent writes, resume via API; check the Stream before every demo |
| **No backfill on Solana**: anything before the Stream starts is missed | Start the Stream early Wednesday; RPC gap-fill (T-C4); verify page reads chain directly |
| Streams may re-deliver blocks (reorgs) | Dedupe by transaction signature |
| Solana toolchain: Anchor 1.2.2 + Solana 4.1.2 untested by us; upgrading replaces the system Solana install | Playground or a container; 2 h time-box; Memo fallback |
| Devnet faucet: 2 requests per 8 hours; the faucet says AI agents shouldn't use it | A human requests SOL, or use QuickNode's devnet faucet; fund the fee payer on Tuesday |
| Gemini market-data licence: public display of prices may need a separate agreement | Ask (Gemini Q3); attribute the source; keep raw feeds off-chain; hold the production quote view until answered |
| A public hosted executor holding trading keys | Sandbox-only lock, stake cap, rate limit, per-visitor session, kill switch; never expose arbitrary `user` names |
| Production fees untested | Say it: "sandbox charges no fees; shown at production rates". Never claim a measured production fee |
| Wording / rulebook risk | Guardrails in `CLAUDE.md`. The October rulebook amendments are unread: read the rulebook's position-transfer clause before the pitch |
| Public leaderboard privacy | Commit is a hash; reveal is opt-in; no Gemini account IDs on chain |
| Scope creep | Thursday 12:00 gate; the cut order above |
| Secrets in a public repo | `.env` and `executor/data/` are git-ignored; run a secret scan over **history** before flipping the repo public |
| Pre-hackathon code | Nothing imported from other projects; check dependencies are libraries, not our old code |

## Decisions we need from the two of you

| # | Decision | Recommendation |
|---|---|---|
| D1 | Main track: Consumer or DeFi | **Consumer.** Money stays on Gemini, so DeFi's "economic design on chain" bar would be a stretch; Given's whole point is invisible crypto |
| D2 | Chain award: Solana or Arc | **Solana** ($1,500 vs $1,000; QuickNode Streams supports Solana devnet, which we verified in the docs) |
| D3 | Lane owners | Frontend-leaning teammate: Product. Executor author: Venue, then Chain |
| D4 | Both travel to Austin for Sat Nov 21? | Yes: required for any prize. Decide today; flights get dearer |
| D5 | Living Tokens folders | **Done 2026-11-17** on this branch: tagged `living-tokens-draft` (pushed), removed `programs/`, `hedge-engine/`, `relay/` and the three old docs. The root README now describes Given. Revert by restoring from the tag if the two of you disagree |
| D6 | ElevenLabs voice entry | No by default; revisit Wednesday night only if the frontend is ahead |
| D7 | Production read-only quote view | Wait for Gemini's answer on price display |

## Submission checklist

- [ ] Organizer email answered (eligibility).
- [ ] Both teammates registered on Devpost and listed on the project.
- [ ] **Repo is public** (it is private today; the owner switches it), created
      during the hackathon: first commit Nov 16.
- [ ] Secret scan over full history, then public. (Clean on 2026-11-18 across all branches; run it again on the final history: `gitleaks git --log-opts="--all" --redact .`)
- [ ] Root `README.md` describes Given, not Living Tokens, with: what it is; an
      architecture diagram; how a bet works with a worked example; fees and
      disclosures; "not affiliated with Gemini"; which Gemini endpoints we use
      (REST market data, WebSocket order placement and depth streams, account
      reads, OAuth if shipped); **Solana program ID(s) and how Solana is used**;
      **QuickNode network, dataset, filter logic and destination, and why**;
      setup; sandbox versus production; the liquidity seeder, disclosed; what is
      not built.
- [ ] Hosted demo link, checked logged out and on a phone.
- [ ] 2–3 minute video on YouTube (unlisted) or Drive ("anyone with the link"),
      checked logged out.
- [ ] Devpost: track, chain award, **both bounties and each matching prize
      opt-in ticked**, program ID, all members, the five written answers.
- [ ] Stream status checked (not paused) on Fri morning and before the finals.
- [ ] Travel booked; slides and the replay fallback on a laptop, offline.
