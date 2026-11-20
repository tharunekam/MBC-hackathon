# Interfaces between the web app, the executor and the chain service

*Last updated 2026-11-19 (night). The TypeScript source of truth is `web/src/api/types.ts`. The in-browser mock
(`web/src/api/mock.ts`) implements the same shapes. An integration test (`chain/test/e2e.test.ts`) drives the real
executor handler and the real chain service over HTTP, and caught two mismatches between these types and the executor
(`settlement.pnl`, not `profit`; the per-bet flow field names), so the types below are checked against the real thing.*

```
web (Vite/React, :5273) ──/api──►   executor      (:8741)  places the two Gemini orders, owns the ledger
                        └─/chain─►  chain service (:8742)  commits / reveals calls on Solana, serves the leaderboard
QuickNode Stream ──► chain service  POST /hooks/quicknode        (a hint: every signature is re-read from Solana)
```

Ports are fixed on purpose (`scripts/dev.mjs`); the dev server and the chain service refuse to start if a port is held
or if the executor URL answers as something other than the Given executor. Another project on this machine listens on
8787, the executor's historic default, which is why dev uses 8741.

`?live` in the address bar (or `VITE_API_MODE=live`, which `npm run dev` sets) switches the web app from the mock to
the real services. The nav always says what the app is talking to (`web/src/lib/venue.ts`): "Test exchange", "Sandbox ·
practice money", "Demo data", "Replay", "Quotes only" or "Seeded prices". Pages use the same note's `place` phrase when they
say where orders ran.

**Links into the builders.** `/parlay?market=TICKER[&direction=down][&condition=SYMBOL&target=SYMBOL]` and
`/range?market=TICKER[&low=SYMBOL&high=SYMBOL]` open a builder on a ladder with a bet already chosen (the Markets and Hunch
pages link this way); `/hunch?market=TICKER` opens Hunch on a ladder. Symbols the ladder no longer lists fall back to the
builder's default. These are addresses in the web app only: nothing is sent to either service until the person asks for a
quote.

## Executor (built; behaviour in `executor/README.md`)

| Endpoint | Used by | Notes |
|---|---|---|
| `GET /health` | venue label | `service: "given-executor"`; the chain service checks this at startup. `readOnly: true` when started with `GIVEN_READONLY=1` (real prices, no account): `POST /bets`, `POST /settle` and `GET /reconcile` then answer 403 `read_only` |
| `GET /markets` | ladder chart, Markets | Polled every 4 s. Rungs carry `bid`/`ask`; pairs carry the offer quote. `down` lists the same for a parlay that a price falls: its condition is the higher strike and its target the lower, rungs are the real ones |
| `GET /quote?event&condition&target&stake[&direction=down]` | Return Parlay | Authoritative. The UI shows its own estimate (`web/src/lib/pricing.ts`, pinned to the README example by a test) until this answers |
| `GET /quote?product=range&event&low&high&stake` | Range | The chance of finishing inside, the price of the second dollar, the offer verdict, and for a stake: contracts, cost, what always comes back, and what each result nets |
| `GET /quote?product=breakout&event&low&high&stake` | Range, "Breaks out" | **New 11-19.** The range's opposite: the chance of finishing outside the two levels (`chanceOutside`), the price of $1 of that, the offer verdict, and for a stake: contracts, cost, `ifOutside` (the win) and `ifInRange` (the loss) |
| `POST /bets` | place bet | ~4 s on the sandbox. A refusal is HTTP 422 with `code` and `quote`. `{ ..., direction: "down" }` places a falling parlay; `{ product: "range", user, event, low, high, stake }` places a range, and `product: "breakout"` with the same fields a breakout (YES on `high`, NO on `low`, equal size; id `bo-…`) |
| `POST /baskets` | Basket | `{ user, name?, legs: [...] }`, 2 to 6 legs, each a parlay (`condition`, `target`, `direction?`), a range (`product: "range"`, `low`, `high`) or a breakout (`product: "breakout"`, `low`, `high`) with its own `stake`. Every leg is checked first: a leg that is not on offer refuses the whole basket (422, `leg` is its index, nothing bought). Otherwise 201 `{ basket: { id, name, size, failed }, bets }`; `failed` is null or the leg that could not be completed, and the legs before it stay placed |
| `GET /cashout?bet=ID` | My bets, "Cash out" | **New 11-19.** What selling an open bet back would bring in now: `{ available, code, reason, stake, proceeds, pnl, proceedsAtProductionFees, legs: [{ role, symbol, outcome, quantity, price, available }] }`. Reads two live books and sends nothing. `available: false` carries a `code` (`not_open`, `market_closed`, `no_bid`, `insufficient_depth`, `position_netted`) and a sentence |
| `POST /cashout` | My bets, "Sell for $X" | **New 11-19.** `{ bet, minProceeds?, slippageTicks? }`. Sells the outcome order, then the hedge, each as one IOC sell (tags `gv-<bet>-cb<n>`, `-ca<n>`). 200 `{ bet, cashOut: { at, stake, proceeds, pnl, complete } }`; the bet's status becomes `cashed_out`. A refusal is 422 with `code` and the `quote` it was refused on (409 for `not_open`); `below_minimum` means the price fell under `minProceeds` (with a floor, each order is limited at the quoted price and never sells below it), and `nothing_sold` that the first sell missed and the bet is unchanged. If only part sells, `complete` is false, the bet stays live on what it still holds and can be cashed out again |
| `GET /bets` | My bets, chain service | Newest first. The chain service reads bets from here and never from the browser. A bet can carry `cashOut` (above), and a leg's `role` can be `cashout` |
| `POST /settle` | "Check results" | A settled bet's `settlement` also carries `finishedAt`, the price the ladder finished at, when Gemini reported its reference price on the settled contract. It is for display; the payout comes from each contract's own yes or no |
| `GET /flow` | Proof page | |
| `GET /reconcile` | Proof page | **New.** Ledger vs Gemini: orders found, cash tied out. `betsNeedingReview` are bets Gemini settled without a plain yes or no; `betsResolvedByHand` are those whose payout a person has entered |
| `POST /review` | operator only | `{ betId, payout, note }` with `X-Admin-Token`: records what Gemini paid for a `needs_review` bet so the cash ties out. 404 unless `GIVEN_ADMIN_TOKEN` is set; never forwarded by the hosted server. The bet gains `review.resolved` and is still never scored |

### Live updates and caching (both services)

Every GET answer carries an `ETag` and `Cache-Control: no-cache`: a client that sends `If-None-Match` gets a 304 with no body
when nothing changed (`asOf`, `time` and `checkedAt` are ignored when deciding). Bodies over 1 KB are gzipped for clients that
accept it. Errors are never given validators.

`GET /stream?topics=markets,bets` (executor) and `GET /events?topics=calls,leaderboard` (chain service) are
server-sent events. A message only says that a topic changed (`event: markets`, `data: {"v":12}`); the page refetches the
normal GET. `event: hello` opens every stream. A client that was disconnected must refetch everything on reconnect (the web
app does). Limits: 8 streams per client address, 200 in total (the hub answers 429 and 503), slow readers are dropped, and a
heartbeat comment goes out every 15 s.

- `markets`: the market list changed. Re-read in the background every 3 s (`refreshMs`), only while someone watches it.
- `bets`: a bet was placed, or a bet settled (by `POST /settle` or by auto-settle, below).
- `calls`: a call was committed, revealed, voided, or recovered from the chain. `leaderboard`: a verified reveal was recorded.

The market list is served stale-while-revalidate: an answer up to 60 s old is returned at once while a fresh one loads, so
nobody waits for the 2 s read. Identical quote requests share one pair of book reads (`quoteCacheMs`, 1.5 s on the real
server); a quote whose book read failed is never reused. `GIVEN_AUTO_SETTLE_MS` (default 20000, 0 turns it off) settles
finished bets by itself; it reads Gemini and writes the ledger and places no order.

### Cashing out and the Solana call

A bet that was cashed out never settles and is never paid, but its call was still right or wrong. When its market gives a
clean result the executor writes `called: { conditionResolved, targetResolved, at, finishedAt? }` on the bet (the result in
the bet's own terms, as `settlement` reads them), `scorable` becomes true and `POST /settle` lists it under `called`. From
then the chain service reveals and scores the call like any other, against the fair price it was made at. Before that the
reveal answers `409 cashed_out` and the call stays a sealed hash; a market that settles without a clean result leaves it
unscored for good (`docs/GIVEN.md`, decision 26).

On the hosted demo every visitor shares one pinned sandbox account, so a visitor can cash out a bet another visitor
placed. It is the same exposure as placing a bet: rate-limited, stopped by the `PAUSED` file, and sandbox money.

### Hosted-demo protections (new, all opt-in; see `executor/src/server.ts`)

`GIVEN_HOST` (default `127.0.0.1`), `GIVEN_PINNED_USER`, `GIVEN_MAX_STAKE`, `GIVEN_RATE_LIMIT_PER_MIN`,
`GIVEN_TRUST_PROXY`, and a kill switch: create `executor/data/PAUSED` to stop new bets at once, delete it to resume.
**The server refuses to listen beyond loopback unless it is on the Gemini sandbox and the pinned user, stake cap and rate
limit are all set.**

### Still owed by the executor lane

| What | Why |
|---|---|
| Deploy it (Dockerfile, always-on host, HTTPS) and set the protections above | The hosted demo link. Nothing in the repo deploys it yet |
| Gemini OAuth sign-in, and the sandbox test that a bearer token can place a WebSocket order | Plan gate T-V1; nothing built |
| Sandbox liquidity seeder, demo-history script, replay mode, maker-first pricing | Plan tasks T-V4 to T-V7 |

## Chain service (built; see `chain/README.md`)

| Endpoint | Body / result | Behaviour |
|---|---|---|
| `POST /calls` | `{ betId }` → `CallRecord` (state `committed`) | Reads the bet from the executor (must be an open or settled, fully hedged bet of this user), hashes `(betId, symbols, entry price, fair price, time, salt)`, writes the hash to Solana, returns the signature. The app is fee payer; the user never sees a wallet. Repeating it returns the same record and writes nothing |
| `POST /calls/:id/reveal` | → `CallRecord` (state `revealed`) | Only after the bet settled with the condition held. `409 not_settled` before; `409 void_call` if the condition failed (the call is void and never scored) |
| `GET /calls` | → `{ calls }` | This user's calls, newest first |
| `GET /calls/:id/verify` | → `{ commit, reveal, recomputedHash, matches }` | Re-reads both records from Solana and recomputes the hash |
| `GET /leaderboard` | → `LeaderboardResponse` | Only verified reveals. Ranked by total edge, then calls. `source` is `quicknode-stream` if the Stream delivered any row, else `rpc`; `network` says `devnet` or `fake`. Each row carries `calls` (revealed and scored), `sealed` (every call that handle has committed on chain, revealed or not: the handle is in the commit, so anyone can count them) and `refunded` (sealed calls this service knows were void). `program` is the `given_receipts` program id (or `null` when records are Memos only) and `authorities` lists every public key whose records the rows count: with those two the page reads each player's totals from the program's own accounts on Solana, without this service (`web/src/lib/programBoard.ts`). `odds` groups every verified call, whoever made it, into four bands of the fair price the market gave it (`from` up to `to`, the last including 1), each with `calls`, `cameIn` and `expected` (the sum of the fair prices): the page's "Were the market's odds right?" card. Optional for the page: an older service or a recorded session without it shows no card |
| `POST /hooks/quicknode` | Stream payload | `Authorization: Bearer <GIVEN_HOOK_TOKEN>` (or QuickNode's HMAC headers). Answers `202` at once, then indexes each signature **from Solana, not from the payload** |
| `POST /admin/backfill` | `X-Admin-Token` | Re-scans the authority's recent transactions. Solana Streams cannot backfill, so this and the automatic backfill are the safety net |
| `GET /health` | | `service: "given-chain"`, network, authority public key, counts, balance |

**On chain, there are two memo shapes** (`chain/src/memo.ts`). Commit: `{g:1, t:"c", h:<sha256>, u:<handle>, at}`.
Reveal: every input of the hash plus the salt and the outcome. The hash preimage is
`given1|betId|event|condition|target|entryPrice(6dp)|fairPrice(6dp)|unixSeconds|salt`, pinned by a test so a verifier
written elsewhere can reproduce it. No Gemini account id and no price feed goes on chain; handles are a keyed hash of the
user name.

The `betId` in the preimage says what kind of bet it was (`executor/src/bet-id.ts`: `dn-` falling parlay, `rg-` range,
`bo-` breakout, no marker for a rising parlay). It is committed and revealed with the call, so the public reveal and each leaderboard call
carry it. A range's "condition" is its lower strike and its "target" its higher one, and a breakout's the same.

**Edge** for a revealed call = `outcome − fairPriceAtEntry`: outcome is 1 if the target hit (for a range, if the price
finished inside), 0 if the condition held and the target missed (a range has no condition that can fail, so is never void; a breakout likewise, and its hit is finishing outside). A refunded call (condition failed) is `void` and not scored. Rank by the sum and show the number of
calls. No volume, no profit.

**Trust model.** Only memos signed by our authority key count. A reveal counts only if it reproduces its commit, names
that commit, and is the first for it. The outcome is attested by our authority (it is unknown at commit time, so no hash
can cover it); the Gemini order IDs on the owner's bet are the evidence.

**Privacy.** The commit is a salted hash and shows nothing about the bet. Only a user-chosen reveal publishes the call,
under a pseudonymous handle. See the guardrails in `CLAUDE.md`.
