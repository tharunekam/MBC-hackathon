# Stakeback

**Bet on the second half of your hunch. If the first half doesn't happen, you get your money back.**

> **Naming.** The product is called Stakeback (renamed from Given on 2026-11-20). The repository, the `GIVEN_*` settings, the deployed `given_receipts` Solana program, the `given-*` package names and the sealed-call format still say Given; they are internal and unchanged.

Stakeback builds bets on [Gemini](https://www.gemini.com) prediction markets from ordinary orders in the user's own Gemini
account, then records each call on Solana so it can be proven later without trusting us. Every outcome is known before
you bet. The products: a **Stake Back** (a bet on a second price level that pays your stake back if the first level fails, going up or going
down; called Return Parlay until 2026-11-19, and still `parlay` in the code and the API), a **Range** (win if a price finishes between two levels), its opposite the **Breakout** (win if it finishes outside
them, whichever way) and a **Basket** (several of these bets, on different assets, placed together).

> Stakeback uses Gemini's prediction market API and is **not affiliated with Gemini**. Everything runs on Gemini's sandbox
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

That is the arithmetic at the best prices. The app sends the refund order with room to fill two cents worse and sizes it
to cover the stake even then, so on these prices a $100 stake really buys 189.5 and 102.04 contracts: **+$89.50** if the
target is reached, and the stake and about $2 more back if the condition fails. The quote shows those figures, and a bet
never costs more than the stake asked for.

The fair price (no spread, no fees) is 50¢ per $1 and you pay 52.5¢, or 55.4¢ with Gemini's production fees. Every quote
shows four numbers: the chance of winning, the fair price, what you pay, and what you would get selling right now. The
app **refuses** pairs that cost too much over fair (all-in 95¢ or more, or more than 8¢ and 20% over). See
`executor/README.md` for the rule and the sizing maths.

### Going down, and the other two products

- **Stake Back, falling.** Bet that a price stays under a higher level, then falls below a lower one. It is the same bet
  on the mirror image of the ladder (strikes negated, every book flipped), so the offer rule, the depth guard and the sizing
  are the ones the rising bet uses; only the order sides change: a NO on the lower level is the bet and a YES on the higher
  level is the refund.
- **Range.** Buy YES on a lower level and NO on a higher level, the same number of contracts of each. One of the two always
  pays $1, so what you really buy is the second dollar for finishing between the levels, and what you risk is what the pair
  costs above that dollar. With the lower level at 0.80 / 0.82 and the higher at 0.40 / 0.42, $14.20 buys 10 contracts of
  each (YES at 82¢, NO at 60¢): **+$5.80** if the price finishes inside, **−$4.20** outside, and $10 comes back either way.
  It is priced and refused by the same rule as a parlay, with the chance of landing inside as the fair price.
- **Breakout.** The range turned inside out: buy YES on the higher level and NO on the lower, the same number of contracts
  of each. One of them pays $1 if the price finishes outside the two levels, whichever way, and neither pays in between, so
  what the pair costs is the price of that dollar. With the same two levels, $10 buys 16.12 contracts of each (NO on the
  lower at 20¢, YES on the higher at 42¢): **+$6.13** if the price finishes below the lower level or at or above the higher,
  **−$9.99** in between. A range is a bet that a price stays put; a breakout is a bet that it moves, with no view needed on
  which way. Between them a person can take a view on how far a price will travel, not only on its direction. The same
  rule prices and refuses it, with the chance of finishing outside as the fair price.
- **Basket.** Two to six of these bets in one request, each on its own ladder with its own two orders and its own result.
  Every leg is checked against the live market before the first is placed, the placed bets share a basket id, and a leg that
  cannot be completed stops the rest and is reported. Nothing links the legs on the exchange, so a basket is **not**
  all-or-nothing, and the app says so.

- **Cash out.** An open bet can be sold back before its market settles: both orders are sold at the live bids as two more
  plain orders, at the price the page showed or not at all. The call the bet stood for is not lost with it: once the
  market settles, how the call turned out is recorded and it can be revealed and scored like any other, because selling
  early does not change whether the call was right.

**Why these and not others.** A ladder has a contract at every level, which is what an options chain is, so the price of
each contract is the market's chance of finishing at or above that level and any payoff that changes only at those levels
can be built exactly from plain orders. Two orders on two levels can make four shapes. NO on the lower with YES on the
higher is the Stake Back when one order is sized to refund the other, and the Breakout when they are the same size. YES
on the lower with NO on the higher is the Range. The other two (YES on both, or NO on both: a bet that pays more the
further the price goes) are not built. Nothing is packaged, pooled, held or issued by us: each bet is two orders in the
user's own account, and the page shows every result before they are sent.

Every bet id carries its product (`dn-` falling, `rg-` range, `bo-` breakout). The id is committed on Solana with the call and revealed
with it, so the proof page and the leaderboard can say what a call was without a change to the hash or to the deployed
program, and nobody can relabel a call after seeing how it went.

### Reading the ladder: the market's view, and yours

- **The market's view.** Each rung is a contract on "finishes at or above this price", so its mid price is the market's
  chance of that, and the difference between two neighbouring rungs is its chance of finishing between them. Both builders
  show the ladder that way: one bar per gap between prices, each coloured by what the bet you are building does if the
  price lands there (win, stake back, lose). Nothing is modelled; the bars are the exchange's prices read another way. A
  ladder whose prices are momentarily out of order is evened out first, and the card says so.
- **Hunch.** Say where you think the price finishes and how sure you are, and the page lists the bets on offer that pay
  best if you are right. Your view is the market's own curve, moved to a new centre and squeezed or widened, so a view that
  has not been moved is the market's exactly and the page lists nothing: every bet costs a little over what the market
  thinks it is worth. Each listed bet shows what $1 of its payout is worth under your odds, what you pay for it (spread and
  fees included, the same number the builder shows), and opens in its builder with one tap. The figures use the odds you
  entered and never a forecast of ours, and the page says the market may be right.
- **Expected move.** The same ladder says how far the market expects the price to travel: the Range page and the market
  index show the band the market gives an even chance of finishing inside ("between $62,660 and $63,740", or "±0.9%").
  Narrower than that is a bet that it stays put, wider a bet on a big move, which is the choice the Range and Breakout
  switch offers.
- **What a basket pays.** For the legs on one ladder, the Basket adds their results up bar by bar and draws what the whole
  position nets at each finishing price, with the market's chance of ending ahead and what the bets cost over fair value.
- **How a basket's legs move together.** Legs on the same ladder are decided by one finishing price, so the chance that
  every leg wins is exact: add up the bars where all of them win. The Basket shows it, and names two legs that can never
  both win (a rising and a falling bet whose winning prices do not overlap). Legs on different ladders are another matter:
  the exchange's prices do not say how two markets move together, so the page shows the range that holds whatever the
  relationship is, with the figure for unrelated markets as a reference point, never as the answer.

### Fees and disclosures

- Gemini's published taker fee is `0.07 × contracts × price × (1 − price)`, rounded up to the cent. The sandbox charges
  none, so every quote is also shown **at production fee rates**. We have not run anything on production.
- We never say "risk-free" or "guaranteed". The cost over fair price is shown on every quote.
- Money and positions stay in the user's Gemini account. Nothing is held by Stakeback, nothing is tokenised, and users are
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
| `executor/` | Quotes, the two-leg bets (parlay either way, range, breakout) with depth guard and sizing, cash-out, a ledger written before every order, settlement, and **reconcile to the cent against Gemini** (it counts Gemini's YES/NO netting). A sandbox liquidity seeder, disclosed (below). 403 tests. |
| `chain/` | Commit and reveal on Solana, the QuickNode webhook, the leaderboard, a public proof endpoint. 152 tests. |
| `receipts-program/` | `given_receipts`, our Solana program (Anchor): checks each reveal against its commit on chain, refuses a repeat, keeps each handle's score. Deployed on devnet, interface published on chain. 8 tests against the built program. |
| `web/` | The app: a tab for each product (Stake Back; Range with its Breakout switch, both over a probability ladder with draggable markers; Basket as a list of legs, with what they pay together at each finishing price), the quote, the market's view of where the price finishes as a histogram and as an expected move, Hunch (your view against the market's, and the bets that fit it), a market index, My bets with cash-out, a leaderboard that counts calls sealed beside calls revealed and can be re-read from the program, and a proof page. Pages update on their own over server-sent events. 798 tests. |
| `scripts/` | The dev stack, the hosted-demo server (`serve.mjs`: the built app plus an allowlist of API paths on one port), the deploy checker, the browser end-to-end test, and the rehearsals. A recorder and replayer for the stage (`docs/DEPLOY.md`). 52 tests. |
| `docs/` | `PLAN.md`, `GIVEN.md` (decision log), `CONTRACTS.md` (interfaces), `GEMINI_API_NOTES.md`, `SUBMISSION.md`. |

### Gemini endpoints used

Market data (REST, no key): `GET /v1/prediction-markets/events` and `/events/{ticker}`. Order entry (WebSocket):
`order.place`, with the `orders@account` stream for fills. Depth: `{symbol}@depth5` and `@bookTicker` streams. Account reads
(REST): `/v1/prediction-markets/positions`, `/orders/active`, `/orders/history`, and `/v1/balances`. Details and every
sandbox quirk we found are in `docs/GEMINI_API_NOTES.md`. Each fact there is marked verified, read in the docs, or unknown.

## How Solana is used

Every call is recorded on Solana in two steps, so a player can prove they made it **before** the result:

1. **Commit**, when the bet is placed: a salted SHA-256 of the call, written through the **Memo program**
   (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`). It shows nothing about the bet. It does carry the player's handle
   (an anonymous name, never an account), which is what lets anyone count how many calls a handle has sealed.
2. **Reveal**, after settlement and only if the player chooses: the plaintext fields and the salt. Anyone can recompute the
   hash and compare it to the commit.

The app is the fee payer, so users never see a wallet, gas or a seed phrase. Records are signed by one authority key:
`2QfQ15Ha5VxvvwWqdsDdCyf6n8uxKfVDHh9GHZdFHeHz` (devnet). Only memos signed by that key count; a reveal counts only if it
reproduces its commit and is the first for it. The **proof page** (`/verify/:signature`) checks all of this in the browser by
reading the records straight from a Solana node and recomputing the hash with WebCrypto, without asking our server.
What it proves: the seal and the reveal are on Solana, the reveal reproduces the seal, and the seal landed before the reveal
(and, where the market's code carries its close time, before the market closed). The chain service refuses to seal a call once
its market has closed (HTTP 409 `too_late`), so a seal cannot follow a result that is already known. What it does not: the result itself (won or lost) is
attested by our key, with Gemini's order IDs as the evidence. Calls whose first half failed are refunded, void, and never
scored.

**Our own Solana program checks each record on chain.** `given_receipts` (`receipts-program/`, id
[`8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK`](https://explorer.solana.com/address/8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK?cluster=devnet), deployed on devnet) rides in the same transaction as each Memo when
the chain service has `GIVEN_PROGRAM_ID` set. It recomputes the hash on chain and rejects a reveal that does not
reproduce its commit or repeats one, scores the call, and keeps each handle's running total in an account. A first call
recorded this way: [commit](https://explorer.solana.com/tx/2DFD8UjXaPofQh82UXFpwsUm47ArcVkteQAxFSeyjp76CRFtr8tNK7JvZD8Th8NepmctkYqnDypHdKRavEJxQnQL?cluster=devnet), [reveal](https://explorer.solana.com/tx/45iRt5TRfiiyBTY8PDJNp4gbscBsTSfmsW4sZkqPSbKLPgAiGcFTLTKX9hvEgA8hYCP6oFx1iGsBL6LoBJ3DT9xU?cluster=devnet). Without `GIVEN_PROGRAM_ID` the service writes Memo records
alone (`docs/GIVEN.md`, decision 9; details in `chain/README.md`).

The leaderboard ranks **edge**, not profit or volume: for each revealed call, outcome (1 if the target hit, else 0) minus
the fair price at entry, summed. Luck on a few calls washes out. Revealing is the player's choice, so each row also says
how many calls that player has **sealed**: a commit carries the handle, so the count is public on chain, and a record
built by revealing only the calls that came off shows as a gap between the two numbers.

**The leaderboard can be read from the program with no server of ours involved.** Under the table, "Read from the
program" has your browser ask a Solana node for the program's own score accounts (one `getProgramAccounts` request per
trusted key, filtered to that kind of account), decode them, and line them up against the table our server built. It
holds totals only (calls, hits, summed edge) and only for reveals that went through the program; Memo-only reveals are
on the server's board and not in those accounts. A second read counts each handle's call accounts, which the program
holds from the moment a call is sealed, so the sealed-beside-revealed count does not depend on our server either: on
devnet one handle shows 5 sealed and 4 revealed (the fifth was refunded, so it can never be revealed). Read from devnet in a browser on 2026-11-19, for the two keys named in
this README and `docs/PLAN.md`, it returned two handles, one of them 4 calls, 2 hits and an edge of 0.78: the figures the
server's board showed after the 2026-11-18 run.

## QuickNode Streams

- **Network:** Solana devnet. **Dataset:** Programs + Logs.
- **Filter:** `chain/quicknode/filter.js` keeps only successful transactions that logged a Stakeback memo and delivers
  `{ sig, slot }`.
- **Destination:** webhook to `POST /hooks/quicknode` on the chain service, authenticated by a shared-token header (or
  QuickNode's HMAC headers).
- **Why:** it is the live feed behind the leaderboard. The webhook is only a hint: the service re-reads every signature from
  Solana and verifies it, so a forged delivery cannot add a row. Solana Streams cannot backfill and pause after repeated
  failed deliveries, so an RPC backfill runs every minute as a safety net.

Status: the receiver is built and tested (authentication, replay window, deduplication, gzipped deliveries), and
`npm run quicknode` tests the filter on QuickNode, creates and manages the Stream, and sends signed test deliveries. **The
Stream exists (`given-calls`, Solana devnet) and is kept paused**, because it bills for every block it reads; `npm run
quicknode -- pitch-on` starts it for a recording or the pitch (`docs/PITCH_DAY.md`). That it exists is as reported by the
teammate whose QuickNode account holds it: the machines this README was checked on have no QuickNode key. It has not
delivered a real record yet, so the filter has not run on a live Stream. Its field names and the signature check
were confirmed against QuickNode's documentation on 2026-11-18, and the filter is tested on the log lines of real devnet
records. A running devnet Stream uses about 10.8M credits a day, so it runs only for tests and demos. The receiver has been
exercised with real devnet signatures. A real commit and reveal with our own key has run on devnet, both as Memo records and through the Anchor program
(`chain/README.md` lists what is verified and what is not).

## Run it

Node 23.6 or newer.

```bash
npm run install:all
npm run dev         # whole stack with no keys and no SOL: local test exchange + in-memory chain + web. The practice
                    # ladder closes, settles and reopens by itself every 5 minutes (FAKE_ROUND_MINUTES), so a bet reaches a
                    # result, a reveal and the leaderboard; curl -X POST '127.0.0.1:8741/dev/resolve?spot=63600' ends a round now
npm run dev:quotes  # REAL Gemini sandbox prices and order books with no keys; every order is refused (read-only)
node scripts/seed-history.mjs all   # optional: a win, a loss and a refund, committed and revealed
npm run stop        # stop this project's servers
npm test            # 1,406 tests: executor 403, chain service 152, web 798, hosted-demo server and scripts 53
npm run e2e         # the production build in real Chrome (25 checks: every product, cash-out, the histogram and Hunch; e2e:sabotage must fail)
npm run e2e:replay  # records a bet through the real app, then replays it with nothing running behind it (7 checks)
npm run rehearse    # (also rehearse:chaos) the whole golden path through the real clients, Gemini and Solana stood in on the wire
npm run preflight   # what is ready for the real thing and what is missing, with the fix for each
npm run build && npm start   # the hosted-demo server on one port (see docs/DEPLOY.md); npm run check:deploy -- <url> checks a deployment
```

No backend at all: `npm --prefix web run dev` and open http://127.0.0.1:5273/?mock, which runs every page on in-browser
demo data (three assets, every product, labelled "Demo data"). CI (`.github/workflows/tests.yml`) runs the typecheck, every
test, a production build and the rehearsal on each push.

Open http://127.0.0.1:5273. The nav carries a label only where what is behind the page changes what you should expect: "Demo data", "Replay", "Quotes only" or "Seeded prices". Gemini's sandbox and the local test exchange (`npm run dev`) carry none, so a bet reads the same on either.

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

The falling parlay, the range, the basket and the breakout were added after this run. They have been placed, settled,
committed, revealed and verified end to end through the real executor and chain code against a local Gemini stand-in and a
local Solana stand-in (`npm run rehearse`, also with injected failures), and through the real Gemini client on the wire
stand-in. On 2026-11-20 (UTC) a rising parlay, a falling parlay, a range and a basket leg were each placed on the **real
sandbox** and sold back with cash-out, the reconcile tying out after every step (the table is in `executor/README.md`);
none of those three newer kinds has been held to settlement there. The **breakout has not been placed on the real sandbox**.

On 2026-11-18 the whole stack ran on the **real Gemini sandbox and real Solana devnet** together: three bets (all rising
parlays) placed from the web app as two filled orders each, each call committed on devnet through our program, then settled at expiry: one won, one
lost and one refunded (its reveal correctly refused as void). The two scored calls were revealed, re-verified from chain, and
reached the leaderboard, and the reconcile tied to $0.00 before and after. That run found one real bug: Gemini nets a YES
against a NO on the same contract and pays $1 a pair early, which the reconcile now counts. Details: `docs/PLAN.md` and
`docs/GEMINI_API_NOTES.md`.

## What is not built

- **A deployed demo.** Everything needed is built and tested (`docs/DEPLOY.md`, a `Dockerfile`, `scripts/serve.mjs`, a
  deployment checker); it needs a host and the live settings.
- Gemini OAuth sign-in. Bets use demo accounts. Production needs Gemini's review.
- A real delivery from the QuickNode Stream (above): it exists and is paused, and has not been run against a hosted
  receiver. While it is off the leaderboard fills from an RPC backfill, about three minutes behind.
- Production has never been run. Gemini's sandbox is not production: its books are far thinner and wider.
- Maker-first pricing and sports ladders. See `docs/PLAN.md`.
- Hunch, the histogram, the basket's joint chances and the leaderboard read from the program have run on the local test
  exchange and in the browser checks; Hunch and the histogram have also been looked at on the real sandbox's prices
  (read-only), where on 2026-11-19 no ladder had a bet on offer and Hunch said so. The program read was run against
  real devnet. None of them places an order.
- Built but never run against the real sandbox: the liquidity seeder (it needs a second sandbox account) and a replay
  of a real session (the recorder and replayer work on the local test exchange; a real session has not been recorded).

The earlier "Living Tokens" draft is preserved at the git tag `living-tokens-draft`.
