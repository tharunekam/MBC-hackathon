# Given

**Bet on the second half of your hunch. If the first half doesn't happen, you get your money back.**

Given builds "money back if…" bets on [Gemini](https://www.gemini.com) prediction markets from two ordinary orders in the
user's own Gemini account, then records each call on Solana so it can be proven later without trusting us.

> Given uses Gemini's prediction market API and is **not affiliated with Gemini**. Everything runs on Gemini's sandbox
> with practice money. Prediction markets involve risk and can lose the amount you stake.

*Built for the UBC 2026 hackathon. Tracks: Consumer Apps. Awards: Best use of Solana. Bounties: Gemini Prediction Markets,
QuickNode Streams.*

## What it is

On a Gemini price ladder (contracts on one number at rising thresholds), pick a **condition** (BTC finishes the hour at or
above $62,500) and a **target** (at or above $63,500):

- if the target is reached, you win;
- if the condition fails, you get your stake back;
- if the condition holds but the target is missed, you lose the stake.

Nobody we found sells that refund as a one-tap retail bet. (The idea of building a conditional bet from linked contracts
is published; sportsbooks sell the same payoff as "draw no bet". Our claim is the product, not the maths.)

### How a bet works, with numbers

Condition A is priced 0.80 / 0.84 (bid / ask) and target B is 0.40 / 0.42. A $100 bet buys:

| Order | What | Result |
|---|---|---|
| 1 | YES on B: 190.5 contracts at 42¢ | pays $1 each if the target is reached |
| 2 | NO on A: 100 contracts at 20¢ | pays $1 each if the condition fails, returning the stake |

| Outcome | Result |
|---|---|
| Target reached | **+$90.48** |
| Condition fails | **stake back** (the NO pays $100) |
| Condition holds, target missed | **−$100** |

The fair price (no spread, no fees) is 50¢ per $1 and you pay 52.5¢, or 55.4¢ with Gemini's production fees. Every quote
shows four numbers: the chance both happen, the fair price, what you pay, and what you would get selling right now. The
app **refuses** pairs that cost too much over fair (all-in 95¢ or more, or more than 8¢ and 20% over). See
`executor/README.md` for the rule and the sizing maths.

### Fees and disclosures

- Gemini's published taker fee is `0.07 × contracts × price × (1 − price)`, rounded up to the cent. The sandbox charges
  none, so every quote is also shown **at production fee rates**. We have not run anything on production.
- We never say "risk-free" or "guaranteed". The cost over fair price is shown on every quote.
- Money and positions stay in the user's Gemini account. Nothing is held by Given, nothing is tokenised, and users are
  never matched against each other.

## Architecture

```
web (React/Vite)  ──►  executor (Node)  ──►  Gemini REST + WebSocket (sandbox)
      │                    │
      │                    ▼ bet details, read by the chain service
      └────────────►  chain service (Node)  ──►  Solana devnet (Memo + our program)
                           ▲                            │ program logs
                           │ POST /hooks/quicknode      ▼
                           └──────────────────  QuickNode Stream (filter + webhook)
```

| Package | Role |
|---|---|
| `executor/` | Quotes, the two-leg bet with depth guard and hedge sizing, a ledger written before every order, settlement, and **reconcile to the cent against Gemini** (it counts Gemini's YES/NO netting). A sandbox liquidity seeder, disclosed (below). 169 tests. |
| `chain/` | Commit and reveal on Solana, the QuickNode webhook, the leaderboard, a public proof endpoint. 115 tests. |
| `receipts-program/` | `given_receipts`, our Solana program (Anchor): checks each reveal against its commit on chain, refuses a repeat, keeps each handle's score. Deployed on devnet, interface published on chain. 8 tests against the built program. |
| `web/` | The app: a probability ladder with two draggable markers, the four-number quote, bets, leaderboard, proof page. Pages update on their own over server-sent events. 109 tests. |
| `scripts/` | The dev stack, the hosted-demo server (`serve.mjs`: the built app plus an allowlist of API paths on one port), the deploy checker, the browser end-to-end test, and the rehearsals. A recorder and replayer for the stage (`docs/DEPLOY.md`). 45 tests. |
| `docs/` | `PLAN.md`, `GIVEN.md` (decision log), `CONTRACTS.md` (interfaces), `GEMINI_API_NOTES.md`, `SUBMISSION.md`. |

### Gemini endpoints used

Market data (REST, no key): `GET /v1/prediction-markets/events` and `/events/{ticker}`. Order entry (WebSocket):
`order.place`, with the `orders@account` stream for fills. Depth: `{symbol}@depth5` and `@bookTicker` streams. Account reads
(REST): `/v1/prediction-markets/positions`, `/orders/active`, `/orders/history`, and `/v1/balances`. Details and every
sandbox quirk we found are in `docs/GEMINI_API_NOTES.md`. Each fact there is marked verified, read in the docs, or unknown.

## How Solana is used

Every call is recorded on Solana in two steps, so a player can prove they made it **before** the result:

1. **Commit**, when the bet is placed: a salted SHA-256 of the call, written through the **Memo program**
   (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`). It shows nothing about the bet or the player.
2. **Reveal**, after settlement and only if the player chooses: the plaintext fields and the salt. Anyone can recompute the
   hash and compare it to the commit.

The app is the fee payer, so users never see a wallet, gas or a seed phrase. Records are signed by one authority key:
`2QfQ15Ha5VxvvwWqdsDdCyf6n8uxKfVDHh9GHZdFHeHz` (devnet). Only memos signed by that key count; a reveal counts only if it
reproduces its commit and is the first for it. The **proof page** (`/verify/:signature`) checks all of this in the browser by
reading the records straight from a Solana node and recomputing the hash with WebCrypto, without asking our server.
What it proves: the call was fixed before the result. What it does not: the result itself (called it or missed) is
attested by our key, with Gemini's order IDs as the evidence. Calls whose first half failed are refunded, void, and never
scored.

**Our own Solana program checks each record on chain.** `given_receipts` (`receipts-program/`, id
[`8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK`](https://explorer.solana.com/address/8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK?cluster=devnet), deployed on devnet) rides in the same transaction as each Memo when
the chain service has `GIVEN_PROGRAM_ID` set. It recomputes the hash on chain and rejects a reveal that does not
reproduce its commit or repeats one, scores the call, and keeps each handle's running total in an account. A first call
recorded this way: [commit](https://explorer.solana.com/tx/2DFD8UjXaPofQh82UXFpwsUm47ArcVkteQAxFSeyjp76CRFtr8tNK7JvZD8Th8NepmctkYqnDypHdKRavEJxQnQL?cluster=devnet), [reveal](https://explorer.solana.com/tx/45iRt5TRfiiyBTY8PDJNp4gbscBsTSfmsW4sZkqPSbKLPgAiGcFTLTKX9hvEgA8hYCP6oFx1iGsBL6LoBJ3DT9xU?cluster=devnet). Without `GIVEN_PROGRAM_ID` the service writes Memo records
alone (`docs/GIVEN.md`, decision 9; details in `chain/README.md`).

The leaderboard ranks **edge**, not profit or volume: for each revealed call, outcome (1 if the target hit, else 0) minus
the fair price at entry, summed. Luck on a few calls washes out.

## QuickNode Streams

- **Network:** Solana devnet. **Dataset:** Programs + Logs.
- **Filter:** `chain/quicknode/filter.js` keeps only successful transactions that logged a Given memo and delivers
  `{ sig, slot }`.
- **Destination:** webhook to `POST /hooks/quicknode` on the chain service, authenticated by a shared-token header (or
  QuickNode's HMAC headers).
- **Why:** it is the live feed behind the leaderboard. The webhook is only a hint: the service re-reads every signature from
  Solana and verifies it, so a forged delivery cannot add a row. Solana Streams cannot backfill and pause after repeated
  failed deliveries, so an RPC backfill runs every minute as a safety net.

Status: the receiver is built and tested (authentication, replay window, deduplication, gzipped deliveries), and
`npm run quicknode` tests the filter on QuickNode, creates and manages the Stream, and sends signed test deliveries. **The
Stream itself is not created yet** and the filter has not run on a live Stream. Its field names and the signature check
were confirmed against QuickNode's documentation on 2026-11-18, and the filter is tested on the log lines of real devnet
records. A running devnet Stream uses about 10.8M credits a day, so it runs only for tests and demos. The receiver has been
exercised with real devnet signatures. A real commit and reveal with our own key has run on devnet, both as Memo records and through the Anchor program
(`chain/README.md` lists what is verified and what is not).

## Run it

Node 23.6 or newer.

```bash
npm run install:all
npm run dev         # whole stack with no keys and no SOL: local test exchange + in-memory chain + web
npm run dev:quotes  # REAL Gemini sandbox prices and order books with no keys; every order is refused (read-only)
node scripts/seed-history.mjs all   # optional: a win, a loss and a refund, committed and revealed
npm run stop        # stop this project's servers
npm test            # 438 tests: executor 169, chain service 115, web 109, hosted-demo server and scripts 45
npm run e2e         # the production build in real Chrome (17 checks; e2e:sabotage must fail)
npm run e2e:replay  # records a bet through the real app, then replays it with nothing running behind it (7 checks)
npm run rehearse    # (also rehearse:chaos) the whole golden path through the real clients, Gemini and Solana stood in on the wire
npm run preflight   # what is ready for the real thing and what is missing, with the fix for each
npm run build && npm start   # the hosted-demo server on one port (see docs/DEPLOY.md); npm run check:deploy -- <url> checks a deployment
```

Open http://127.0.0.1:5273. The nav shows what the app is talking to; with `npm run dev` it says "Local test exchange".

Real services (Gemini sandbox + Solana devnet): put sandbox keys in `.env` (see `executor/README.md`), create the authority
wallet with `cd chain && npm run keygen`, fund it on devnet, check it with `npm run status`, prove the real path with
`npm run smoke`, then `npm run dev:live`. `.env.example` lists every setting, and `npm run preflight` checks them against
the real services (keys accepted, terms accepted, order session opens, authority funded) without placing anything.

### Sandbox versus production

The executor refuses to run against production unless `GIVEN_ALLOW_PRODUCTION=1`, and refuses to listen on a network
address unless it is on the sandbox with a pinned account, a stake cap and a rate limit. The sandbox's books are about 20¢
wide (production's median is about 4¢), so on the sandbox the value rule would refuse almost everything; `npm run
start:demo` in `executor/` waives the markup check **on the sandbox only**, and the verdict shown is never softened.

**The liquidity seeder, disclosed.** `executor/src/seeder.ts` can rest tight two-sided quotes on the sandbox from a
second sandbox account of ours, so the same rules can run with the waiver off against a production-like book. Those
quotes are ours: a bet filled by them is two of our own test accounts trading with each other, and is not order flow.
Whenever it runs the app shows "Seeded prices" and says so in the footer. It is built and tested but **has not been run
on the sandbox yet** (it needs a second sandbox account), so nothing shown so far used it.

## What has been run for real

On 2026-11-18 the whole stack ran on the **real Gemini sandbox and real Solana devnet** together: three bets placed from the
web app as two filled orders each, each call committed on devnet through our program, then settled at expiry: one won, one
lost and one refunded (its reveal correctly refused as void). The two scored calls were revealed, re-verified from chain, and
reached the leaderboard, and the reconcile tied to $0.00 before and after. That run found one real bug: Gemini nets a YES
against a NO on the same contract and pays $1 a pair early, which the reconcile now counts. Details: `docs/PLAN.md` and
`docs/GEMINI_API_NOTES.md`.

## What is not built

- **A deployed demo.** Everything needed is built and tested (`docs/DEPLOY.md`, a `Dockerfile`, `scripts/serve.mjs`, a
  deployment checker); it needs a host and the live settings.
- Gemini OAuth sign-in. Bets use demo accounts. Production needs Gemini's review.
- The QuickNode Stream itself (above). Without it the leaderboard fills from an RPC backfill, about three minutes behind.
- Production has never been run. Gemini's sandbox is not production: its books are far thinner and wider.
- Maker-first pricing and sports ladders. See `docs/PLAN.md`.
- Built but never run against the real sandbox: the liquidity seeder (it needs a second sandbox account) and a replay
  of a real session (the recorder and replayer work on the local test exchange; a real session has not been recorded).

The earlier "Living Tokens" draft is preserved at the git tag `living-tokens-draft`.
