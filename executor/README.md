# Given executor

Places "given X, will Y?" bets on Gemini prediction markets as real orders in
the user's own Gemini account, keeps its own ledger of what it did, and serves
an HTTP API for the frontend. Uses Gemini's API; not affiliated with Gemini.

A conditional bet is built from two linked contracts in one event. Example on an
ETH price ladder: buy YES on "$1,820 or above" and a sized NO on "$1,800 or
above". If the condition ($1,800) fails, the NO leg pays the stake back. If both
hit, the bet pays $1 per contract. If the condition holds and the outcome
misses, the stake is lost.

## Read this first: the sandbox and the offer rule

The offer rule (below) refuses bets that cost too much over their fair price.
Gemini's **sandbox** books are run by bots and are usually about 19 cents wide,
so on the sandbox the rule refuses almost everything: on 2026-11-17 it refused
all 105 pairs that had a two-sided book. (Seen once, not yet confirmed as a
pattern: about eight minutes before the 00:00 UTC hourly expiry the books
tightened to about 3 cents and 5 pairs passed.)

To demo on the sandbox, start the server with `npm run start:demo`, which sets
`GIVEN_SANDBOX_WAIVE_MARKUP=1`. That switch:

- lets through pairs refused **only** for markup; a closed market, a one-sided
  book, an out-of-order ladder and a price of 0.95 or more are still refused;
- is ignored outside the sandbox, whatever it is set to;
- never changes the verdict shown: such a pair still says `"verdict": "refuse"`,
  with `"overridden": true`, and the bet record keeps both.

Without the switch (`npm start`) the rule is fully enforced.

## Setup

Needs Node 23.6 or newer (it runs TypeScript directly; there is no build step).

```bash
cd executor && npm install
```

Credentials are read from `.env` in the repo root (git-ignored):

```
GEMINI_API_KEY=...
GEMINI_API_SECRET=...
GEMINI_BASE_URL=https://api.sandbox.gemini.com
```

More accounts: `GEMINI_USER_<NAME>_KEY` / `GEMINI_USER_<NAME>_SECRET`, then pass
`--user <name>` (CLI) or `"user": "<name>"` (API). The key needs the Trading role
and **time-based nonce** enabled. The service refuses to start against
production unless `GIVEN_ALLOW_PRODUCTION=1`.

| Setting | Default | What it does |
|---|---|---|
| `GIVEN_PORT` | `8787` | Port of the HTTP API (always on 127.0.0.1) |
| `GIVEN_TAKER_FEE_COEF` | `0` sandbox, `0.07` production | Fee rate the venue really charges; drives sizing and the ledger |
| `GIVEN_SANDBOX_WAIVE_MARKUP` | off | Sandbox demo switch described above |
| `GIVEN_CORS_ORIGINS` | none | Extra browser origins allowed to call the API, comma-separated. Localhost is always allowed |
| `GIVEN_DATA_DIR` | `executor/data` | Where `ledger.json` lives |
| `GIVEN_SECOND_LEG_WAIT_MS` | `0` (off) | How long a bet's second order may wait for a post-only contract to open before the bet is sold back; at most `15000`. **Not yet run on the real sandbox**: see "Waiting for the second order" |

## Commands

```bash
npm start                             # HTTP API, offer rule fully enforced
npm run start:demo                    # HTTP API with the sandbox demo switch on
node src/cli.ts pairs                 # conditional bets on offer right now
node src/cli.ts pairs ETH2611180000 --all   # one event, including refused pairs and why
node src/cli.ts bet <event> <conditionSymbol> <targetSymbol> <stake> [--max 0.60] [--slip 2] [--leave]
node src/cli.ts cashout <bet>         # what selling an open bet back would bring in now (sends nothing)
node src/cli.ts cashout <bet> --sell [--min 3.10]   # sell it back: one sell order per leg
node src/cli.ts bets                  # the ledger
node src/cli.ts settle                # record results once Gemini resolves
node src/cli.ts reconcile             # check the ledger against Gemini (orders and cash)
node src/cli.ts recover               # repair a bet interrupted mid-flight
node src/cli.ts flow                  # what Given's bets have sent to Gemini's book
npm test                              # unit and API tests (no network)
npm run typecheck
```

Do not run `bet`, `cashout --sell`, `settle` or `recover` from the CLI while the server is
running: both keep the ledger in memory, and the last one to save wins.
`pairs`, `bets`, `flow` and `reconcile` are safe.

## The offer rule (`src/offer.ts`)

Every pair gets a quote with these numbers, all per $1 of payout unless noted:

| Field | Meaning |
|---|---|
| `chanceBothHappen` | Middle of the outcome's book (the outcome can only happen if the condition does) |
| `chanceCondition` | Middle of the condition's book |
| `fairPrice` | `chanceBothHappen / chanceCondition`: the price with no spread and no fees |
| `pricePaid` | What this venue actually charges: `ask(B) / bid(A)` plus its real fees (none on the sandbox) |
| `allInPrice` | The same price at Gemini's **production** fee rate (0.07), whatever the venue charges. The rule is applied to this number |
| `markup`, `markupPct` | `allInPrice - fairPrice`, in dollars and as a share of fair |
| `cashOutPer100` | What selling both legs straight back at the bids would return on a $100 bet |
| `cashOutPer100AtProductionFees` | The same with production fees on the sale |

A pair is **refused** when any of these hold:

| Code | Rule |
|---|---|
| `price_too_high` | `allInPrice` is 0.95 or more (`MAX_ALL_IN_PRICE`) |
| `markup_too_high` | markup is more than 8 cents (`REFUSE_MARKUP_DOLLARS`) or more than 20% (`REFUSE_MARKUP_FRACTION`) |
| `one_sided_book` | either contract has no bid or no ask |
| `ladder_out_of_order` | anywhere in the event, a higher strike has a higher bid or ask than a lower one |
| `no_price` | the outcome costs as much as the condition |
| `market_closed` | either contract is not `active` with market state `open` |

A pair gets a **warn** verdict when it is not refused and the markup is at least
5 cents (`WARN_MARKUP_DOLLARS`) or at least 15% (`WARN_MARKUP_FRACTION`).
Otherwise the verdict is **ok**. The refuse limits were loosened from 5 cents /
15% so that enough production pairs pass; all four numbers are named constants.

`ladder_out_of_order` looks at the whole event, not just the two contracts in
the bet. That was reviewed on 2026-11-17 and kept, on these measurements:

- On the saved production snapshot (18 "or above" ladders, 557 pairs) it cost
  nothing: 91 pairs pass with the check, and the same 91 pass without it. The
  three ladders that were out of order had no acceptable pair anyway.
- On the sandbox, over two minutes of reading four live ladders every 8
  seconds, a ladder was out of order in 3 of 56 reads, by one cent each time.
  The check removed 38 of 711 otherwise-tradable pair-reads (about 5%). At one
  earlier moment two of four ladders were out at once, so it varies.
- Checking only the two contracts in the bet would do nothing: if the outcome
  is priced above the condition, `no_price` already refuses the pair. The only
  real alternative (refuse a pair only when one of its own contracts is out of
  order against some other strike) would have won back 14 of those 38.

So while a ladder is out of order, every pair in that event is refused, usually
for a few seconds; the other events stay available. A frontend should treat it
like any other 422: try again.

Worked example (also the first test in `test/offer.test.ts`): condition 0.80 /
0.84, outcome 0.40 / 0.42. Fair is 0.41 / 0.82 = 0.50. Price paid with no fees
is 0.42 / 0.80 = 0.525. With production fees it is 0.437052 / 0.7888 = 0.554, a
markup of 5.4 cents (10.8%), so the verdict is "warn". Cash-out per $100 is
$92.19 with no fees and $84.22 with production fees.

## How a bet executes (`src/bets.ts`)

1. Read the event and confirm the two contracts are a linked pair.
2. **Immediately before trading**, in parallel: read the resting size at the
   best price on both contracts, and re-read the event. Refuse if either
   contract is not open, or if the offer rule refuses the pair.
3. **Depth guard.** An immediate-or-cancel order only fills what rests at the
   best price, so the bet is shrunk until both orders fit: the outcome order
   into the size offered on B, the hedge into the size bid on A. The bet record
   carries `stakeReduced` with the requested and reduced amounts and the reason.
   If nothing fits, or the depth cannot be read, no order is sent.
4. Buy YES on B, immediate-or-cancel. Only what actually fills is hedged.
5. Buy NO on A, sized from B's real cost and rounded up, so the refund covers
   the stake even at the worst allowed fill. Retried up to three times.
   **The quote counts this order the way it is sent.** It is sized for its limit
   (two cents past the best price by default) and usually fills at the best
   price, so a few more NO contracts are bought than the best price alone would
   need. `planForQuantity` and `contractsForStake` (`src/offer.ts`) take that
   slip, so the plan on a quote is the bet that is placed and, at the quoted
   prices, a bet never costs more than the stake asked for (a first order that
   fills worse than quoted can take it over: `docs/PLAN.md`, known limit 3); the refund is then the stake and a few cents
   more, never less. (Before 2026-11-19 the quote counted the refund order at the
   best price and a "$10.00" bet came to $10.04.)
6. If the hedge can't be completed within the price limit, the position is sold
   back (default) or left flagged `unhedged` (`--leave`).

Every order carries a tag (`gv-<betId>-...`) and is written to
`data/ledger.json` before it is sent, so an interrupted bet can be repaired by
looking the tag up on Gemini instead of resending.

A bet refused before trading throws `BetRefused` with a `code`:
`offer_refused`, `market_closed`, `no_depth`, `insufficient_depth`,
`price_above_limit` or `stake_too_small`. Nothing is written to the ledger.

## Waiting for the second order (`src/second-leg-wait.ts`): off by default

**`GIVEN_SECOND_LEG_WAIT_MS` has NOT been run on the real Gemini sandbox, only against the in-memory test exchange.
Before it is switched on for a demo, place bets with it on the sandbox and run `node src/cli.ts reconcile` afterwards.**

**Why it exists.** Every bet is two orders sent one after the other. On the sandbox on 2026-11-20 a breakout's first
order filled, the second contract was then found post-only (its ladder had been listed about 14 minutes and was flipping
between `open` and `post_only`), so the second order was never sent and the position was sold straight back on a wide
book: $1.55 lost of a $3 bet.

**What it does.** `GIVEN_SECOND_LEG_WAIT_MS` is how many milliseconds a bet's second order may wait for that to pass.
The default is `0`: no wait, and the order path is the one verified on the sandbox, with the same orders, the same tags
and the same ledger records. Any value is capped at `15000`. Above 0, a second leg that finds its contract `active`,
`post_only` and without a result re-reads the event every 500 ms until the contract is open or the wait is used up, then
carries on as before: a fresh book, the same price limit, the same size and the same three attempts (waiting uses none of
them up). If the contract does not open in time the bet ends as it does today: sold back, or left `unhedged` with
`--leave`. The same code serves all four bets (`waitForSecondLeg`, called from `bets.ts`, `range-bet.ts` and
`breakout-bet.ts`).

- Not waited on: a contract that is settled, closed, expired, resolved or missing, or in any market state other than
  `post_only` (`isTemporarilyClosed` is the one place that decides).
- The wait is one allowance per bet, shared by its three attempts, and the time the re-reads take counts against it. A
  re-read that fails counts as "not open yet".
- While a bet waits it holds its first leg only, the answer to `POST /bets` takes that much longer, and that account's
  next bet queues behind it.
- A bet that waited carries `secondLegWait: { waitedMs, reads, opened }` in the ledger and in the API's answer, and
  `node src/cli.ts bets` prints it. A bet that did not wait has no such field.

What the tests cannot show, and the sandbox run must: that Gemini's single-event read reports the contract `open` as soon
as it takes orders again, and that an order sent in that moment is accepted (`test/second-leg-wait.test.ts` covers the
rest on the test exchange).

## The other bets (`src/mirror.ts`, `src/range.ts`, `src/range-bet.ts`, `src/breakout.ts`, `src/breakout-bet.ts`, `src/basket.ts`)

**Falling parlay.** "Given it stays below H, will it fall below L?" is the rising parlay on the *mirror* of the ladder: every
strike negated, every YES book flipped into the NO book (`bid' = 1 - ask`, `ask' = 1 - bid`), every result swapped. On the
mirror H is the lower strike (the condition) and L the higher (the target), so `findPair`, the offer rule, the depth
guard, `planForQuantity`, the hedge sizing, the unwind and the settlement run unchanged. Only the real orders differ: the
outcome leg is a NO on L (priced `1 - bid(L)`, the mirror's ask) and the hedge leg a YES on H (priced at its ask). The
reads go through `mirrorExchange`; orders pass straight through with the real side. Pass `direction: "down"`.

**Range.** Buy YES on a lower strike L and NO on a higher strike H, the same number of contracts of each:

| Price finishes | Pays |
|---|---|
| below L | the NO on H: $1 per contract |
| between L and H | both: $2 per contract |
| at or above H | the YES on L: $1 per contract |

One order always pays a dollar, so the bet is the second dollar and its price per $1 is `askL - bidH` plus fees. The fair
price is the chance of finishing inside, `mid(L) - mid(H)`, and `assessRange` applies the same refusal and warning limits
as a pair. A stake buys `stake / (askL + (1 - bidH) + fees)` contracts of each leg, capped by the smaller of the offers on L
and the YES bids on H. Orders: YES on L, then NO on H for the contracts that filled, retried up to three times; if the legs
cannot be matched within the price cap the position is sold back. `payoffs` carries `ifInRange` and `ifOutside` (and the
same numbers as `ifBothHit` and `ifConditionOnly`; there is no refund line). Settlement: `conditionResolved` is always
`yes` (a range is never refunded) and `targetResolved` is `yes` when L resolved yes and H no.

**Breakout.** The range's opposite: buy YES on the higher strike H and NO on the lower strike L, the same number of
contracts of each:

| Price finishes | Pays |
|---|---|
| below L | the NO on L: $1 per contract |
| between L and H | nothing |
| at or above H | the YES on H: $1 per contract |

Exactly one order can pay, so the pair costs less than a dollar and that cost is the price per $1 of finishing outside:
`(1 - bidL) + askH` plus fees. The fair price is the chance of finishing outside, `1 - (mid(L) - mid(H))`, and
`assessBreakout` applies the same refusal and warning limits; two strikes the market prices the same leave nothing to bet
against and are refused as `no_price`. A stake buys `stake / ((1 - bidL) + askH + fees)` contracts of each leg, capped by
the smaller of the offers on H and the YES bids on L. Orders: YES on H, then NO on L for the contracts that filled, retried
up to three times; if the legs cannot be matched within the price cap the position is sold back. Its two orders are the
ones a rising parlay sends (YES on its "target", NO on its "condition") at equal size instead of refund size, so cash-out,
the unwind, recovery after a crash and the reconcile read it through the same leg map with no case of their own.
`payoffs` carries `ifOutside` (the win) and `ifInRange` (the loss: everything spent), and the same numbers as `ifBothHit`
and `ifConditionOnly`. Settlement: `conditionResolved` is always `yes` (never refunded) and `targetResolved` is `yes` when
L resolved no or H resolved yes. Worked example, L at 0.80 / 0.82 and H at 0.40 / 0.42: 62 cents per $1 against a fair 60;
at production fees 64.8 cents, 4.8 over, so it is offered; $10 buys 16.12 contracts of each for $9.99, +$6.13 outside.

**Basket.** `placeBasket` takes 2 to 6 legs. Every leg goes through its `plan…` step first (the same reads and checks as
placing, no order sent), so one that is not on offer refuses the whole basket before anything is bought. Then the legs are
placed in order with a shared `basket` tag on each bet; a leg that cannot be completed stops the rest and is returned as
`failed`, with the earlier legs left in place. It is not atomic: nothing on the exchange links the legs.

**Ids.** A bet's id carries its product: `dn-` falling parlay, `rg-` range, `bo-` breakout, nothing for a rising parlay. The id is committed
on Solana with the call (see `docs/CONTRACTS.md`).

## Cashing out (`src/cashout.ts`)

Every quote says what a bet would fetch if it were sold straight back. Cash-out is the order path behind that number:
an open bet is two ordinary positions, so leaving it early is two ordinary sells on the same contracts.

1. **Price it.** Both books are read live. The outcome leg sells at its best bid and the hedge leg at its own best bid
   (for a NO, 1 minus the YES ask), less the taker fee on each. `quoteCashOut` returns the proceeds, what that makes or
   loses against what the bet cost, and the size wanted at each price. It sends nothing.
2. **Refuse before any order** when the sale could not be done whole:

   | Code | Why |
   |---|---|
   | `not_open` | The bet is settled, failed, already cashed out, or holds nothing |
   | `market_closed` | One of its contracts is not taking orders (closed, finished, or post-only) |
   | `no_bid` | Nobody is bidding for a leg, or the book could not be read |
   | `insufficient_depth` | Less rests at the best price than the bet holds |
   | `position_netted` | Another open bet holds the other side of one of these contracts. Gemini keeps one position per contract and has already paid $1 a pair for the overlap, so this bet's contracts are no longer there to sell on their own |
   | `below_minimum` | The proceeds are under the `minProceeds` the caller set (the web app sets the price it showed, less 2 cents) |

3. **Sell the outcome leg, then the hedge**, each as one immediate-or-cancel order. With a `minProceeds` floor each
   order is limited at the price just quoted, so the sale cannot come in under the figure the floor was checked
   against; without one it may reach one cent past the best price (`slippageTicks` sets either). If the first sell fills nothing the bet is exactly as it was (`nothing_sold`). If the first
   sells and the second does not, what is left is the leg that pays the stake back when the condition fails, which is
   the safer half to be left holding; the bet stays live, `cashOut.complete` is false, and it can be cashed out again
   or left to settle on what it still holds.

A bet sold in full becomes `cashed_out` with `cashOut: { at, stake, proceeds, pnl, complete: true }`. `stake` is what
the bet had cost before the first sale; the bet's running `cost` nets the sale off, as it does for an unwind. Nothing
else changes: the sells are ordinary legs (role `cashout`), so `reconcile` and the Flow totals count them without
knowing what a cash-out is, and a cashed-out bet holds nothing, so it nets against nothing.

**Run on the real Gemini sandbox, 2026-11-20 02:20 to 02:30 UTC**, one of each product, `reconcile` tied out after
every step:

| Bet | Product | Cost | Quoted | Sold for |
|---|---|---|---|---|
| `4f449ee5` | rising parlay, SOL $71 then $72 | $0.58 | $0.19 | $0.19 (3 YES at 3¢, 0.6 NO at 16¢) |
| `dn-9adccf38` | falling parlay, SOL under $75 then under $71 | $1.00 | $0.55 | $0.55 |
| `rg-9f1b661e` | range, SOL $70 to $74 | $2.99 | (sold without a separate quote) | $2.68 |
| `702269af` | first leg of a basket, over HTTP (`GET` then `POST /cashout`) | $0.25 | $0.07 | $0.07 |

Those prices are the sandbox's: its books are about 20 cents wide, so leaving a bet at once costs most of a small
stake there. On a production-width book the same sale costs a few cents per dollar (`cashOutPer100` on every quote).

**If the sale is interrupted.** What the bet cost is written to the ledger before the first sell leaves. A sell whose
answer never arrives is looked up by its tag before it is treated as unsold, and after a crash `recover` fills in any
sell left as "sent" and brings the bet's status and proceeds in line with what really sold. No sell is ever sent twice:
each attempt numbers its tags from every cash-out order the bet has had.

**The call outlives the sale.** A bet sold in full holds nothing, so `settle` never pays it and it stays `cashed_out`.
But once its market has a clean result, `settle` records how the call turned out in `called` (the same two fields as
`settlement`, plus `finishedAt` when Gemini reports it) and the bet becomes `scorable`, so the chain service can reveal
and score the call. Selling early does not change whether the call was right.

Not handled: selling a bet whose position Gemini has netted against another bet (it is refused), and selling part of
a bet on purpose.

## Settlement

`settle` (CLI) or `POST /settle` reads each open bet's event:

- both contracts resolved `yes` or `no`: the bet becomes `settled`, with payout
  and profit;
- Gemini settled the event but **not** as a clean yes/no (a void or a
  fractional settlement): the bet becomes `needs_review`. "Settled" here means
  the event is marked settled, or both contracts are. What Gemini reported
  for each contract is saved in `review`; no payout is guessed; the bet is not
  scorable (`scorable: false` in the API). It can never sit `open` forever;
- not settled yet: left alone.

An unclear result is only flagged once the event is at least a minute past
expiry, because the yes/no can trail the "settled" flag by a few seconds. A
`needs_review` bet is re-checked on every pass and becomes `settled` if Gemini
later reports a clean result. `reconcile` lists `betsNeedingReview`; any cash
such a bet paid shows up as a cash difference until someone records it by hand.

### Recording what such a bet paid

This service cannot work out the payout of a void or fractional settlement, so
a person reads it off the Gemini account and records it:

```bash
node src/cli.ts review                       # the bets waiting, what each cost and the most it could have paid
node src/cli.ts resolve <betId> 3.24 --note "Gemini account history 2026-11-19: both contracts paid 0.50"
node src/cli.ts reconcile                    # the cash check ties out again
```

While an executor is running it holds the ledger in memory, so add
`--server http://127.0.0.1:8741` and the change goes through it
(`POST /review`, which needs `GIVEN_ADMIN_TOKEN` set on the executor and in
your shell). That route answers 404 without the token and is not forwarded by
the hosted server, so it can only be reached from inside the host.

The amount is refused if it is negative or more than every contract the bet
holds at a dollar each, and a note saying where it came from is required. The
bet stays `needs_review` and is still never scored: a payout says what was
paid, not whether the call was right. `reconcile` then counts it and lists the
bet under `betsResolvedByHand`, and the Proof page says a hand-entered amount is
part of the total. If Gemini later reports a clean result, the computed payout
replaces the recorded one; the two are never counted together.

## Fees

Gemini's published taker fee is `0.07 x contracts x price x (1 - price)`, rounded
up to the cent. The sandbox charged nothing. Hedge sizing and the ledger use the
fee the venue really charges, through one setting, `GIVEN_TAKER_FEE_COEF`
(default `0` on the sandbox and `0.07` on production). `reconcile` fails if the
setting is wrong, because the cash balance will not tie out. The offer rule and
the "Flow to Gemini" totals always use the production rate, so the sandbox never
makes a bet look cheaper, or the flow smaller, than it would be for real.

## HTTP API (`src/server.ts`, `src/api.ts`)

`npm start` listens on `http://127.0.0.1:8787` (this process holds trading keys,
so it never listens on the network). JSON in and out. It keeps one long-lived
Gemini session per configured user and reuses it for every request; bets for the
same user run one at a time. Browser calls are accepted from localhost origins
(and `GIVEN_CORS_ORIGINS`); a request carrying any other `Origin` gets 403.

Errors are always `{"error": "<plain sentence>", "code": "<word>"}` with a
matching status: 400 bad request, 403 origin not allowed, 404 unknown event,
user or path, 405 wrong method, 422 bet refused, 502 Gemini or network trouble.

### `GET /health`

Venue, sandbox flag, connected users (names only), the fee rate charged and the
offer rule's limits, including `markupWaivedForSandboxDemo`.

### `GET /markets`

Every active event that has a price ladder, each re-read from Gemini's
single-event endpoint (answers are reused for 5 seconds).

- `?event=TICKER` for one event.
- `?include=refused` to list refused pairs too, each with its reasons.

```json
{
  "venue": "Gemini sandbox",
  "totals": { "events": 40, "eventsWithOffers": 4, "offerable": 64, "refused": 695 },
  "events": [{
    "ticker": "ETH2611180000", "title": "ETH price today at 7pm EST", "expiry": "2026-11-18T00:00:00.000Z",
    "rungs": [{ "symbol": "GEMI-ETH2611180000-HI1800", "label": "$1,800 or above", "strike": 1800, "bid": 0.94, "ask": 0.97, "open": true, "state": "active/open" }],
    "ladderOutOfOrder": false,
    "pairs": [{
      "condition": { "symbol": "GEMI-ETH2611180000-HI1720", "label": "$1,720 or above", "strike": 1720, "bid": 0.94, "ask": 0.97 },
      "target": { "symbol": "GEMI-ETH2611180000-HI1820", "label": "$1,820 or above", "strike": 1820, "bid": 0.84, "ask": 0.87 },
      "quote": { "verdict": "warn", "reasons": [], "warnings": ["Costs 7.9 cents (9.2%) more than the fair price with fees."],
                 "offerable": true, "overridden": false, "chanceBothHappen": 0.855, "fairPrice": 0.8586, "pricePaid": 0.9255,
                 "allInPrice": 0.9379, "markup": 0.0793, "markupPct": 0.0923, "cashOutPer100": 93.76 }
    }],
    "offerableCount": 17, "refusedCount": 11, "refusedByReason": { "no_price": 11 }
  }]
}
```

### `GET /quote?event=&condition=&target=&stake=`

One pair's quote (same shape as above). With `stake`, also what that stake buys
and how much fits in the book right now:

```json
{
  "quote": { "...": "as above" },
  "stake": { "requested": 2, "reduced": true, "outcomeContracts": 1, "hedgeContracts": 0.59, "cost": 0.58,
             "ifBothHit": 0.4156, "ifConditionFails": 0.0056, "ifConditionOnly": -0.5844,
             "feesAtProductionRates": 0.03, "cashOutNow": 0.35 },
  "depth": { "outcomeAvailable": 1, "conditionAvailable": 11, "maxStake": 0.58 }
}
```

`depth` is read through a user's Gemini session (`&user=`, default the first
configured user). If it cannot be read, `depth` is `{"unavailable": "..."}` and
the quote still answers.

### `GET /quote?product=range&event=&low=&high=&stake=`

A range's quote: `quote` (the offer rule's verdict and numbers: `chanceInRange`, `fairPrice`, `pricePaid`,
`allInPrice`, `markup`, `cashOutPer100`), and with `stake` the plan (`contracts`, `cost`, `backAlways`, `ifInRange`,
`ifOutside`) and `depth`. `GET /quote` for a parlay takes `&direction=down` for a falling one, and `GET /markets` lists the
falling pairs under each event's `down`.

### `GET /quote?product=breakout&event=&low=&high=&stake=`

A breakout's quote, in the range's shape: `quote` (`chanceOutside`, `fairPrice`, `pricePaid`, `allInPrice`, `markup`,
`cashOutPer100`), and with `stake` the plan (`contracts`, `cost`, `ifOutside`, `ifInRange`, `feesAtProductionRates`,
`cashOutNow`) and `depth` (`outcomeAvailable` on H's offers, `conditionAvailable` on L's YES bids). `POST /bets` takes
`{ "product": "breakout", user, event, low, high, stake }`, and a basket leg the same without `user`.

### `POST /baskets`

```json
{ "user": "primary", "name": "Majors", "legs": [
  { "event": "BTC2611200100", "condition": "GEMI-BTC2611200100-HI62500", "target": "GEMI-BTC2611200100-HI64000", "stake": 10 },
  { "event": "ETH2611200100", "condition": "GEMI-ETH2611200100-HI1860", "target": "GEMI-ETH2611200100-HI1820", "direction": "down", "stake": 10 },
  { "product": "range", "event": "SOL2611200100", "low": "GEMI-SOL2611200100-HI138", "high": "GEMI-SOL2611200100-HI146", "stake": 10 } ] }
```

2 to 6 legs. A leg that is not on offer, or is not a real pair or range, refuses the whole basket: HTTP 422, `leg` is its
index, nothing is bought. Otherwise 201 with `{ "basket": { "id", "name", "size", "failed" }, "bets": [...] }`; `failed` is
`null`, or `{ index, code, message }` for a leg that could not be completed, in which case the legs before it are placed, the
failed leg is recorded, and the legs after it were not attempted.

### Safe to repeat, and a lost answer

`POST /bets` and `POST /baskets` take an optional `requestId` (8 to 64 characters of `A-Za-z0-9_-`). The executor stores it on the bet (`clientRequestId`, and on a basket record) in the ledger and looks for it inside the per-user queue before anything is sent: the same id from the same user answers with the bet or basket it placed the first time, HTTP 200 and `"repeated": true`, and places nothing. A client that times out, a proxy that replays a POST and a double click therefore cannot place a second real bet. Requests without an id behave as before; a refusal records nothing, so its id can be sent again.

An order whose answer is lost (a timeout, a socket that closed mid-request) may still have reached the exchange and filled. `sendLeg` therefore looks it up by its tag (after 0, 0.5, 2 and 5 seconds) and records what the exchange says. An explicit refusal (`OrderNotSent`) is an error at once. When the exchange cannot say, the leg is `unknown`, the bet is held as `unhedged` with a plain note, and nothing more is sent for it: no second hedge, no unwind. `recoverBets` (at startup) and `/reconcile` resolve such legs by tag. Only an answer the exchange gave as a client error (a status from 400 to 499 on the order socket, or a socket that was not open) counts as a refusal that is known not to have placed the order; a 5xx or any other status is a lost answer and goes through the same look-up. A bet held as unhedged for an unknown order is looked up again by tag on the auto-settle timer (once it is 60 seconds old, at most every 5 minutes, reading only the named orders), and at start. A sale that cannot be confirmed answers 409 `sale_unconfirmed` (422 `nothing_sold` is a definite no-sale). A `requestId` reused with a different request answers 409 `request_id_reused`. Every 500 answers with a fixed body and logs the real error. A basket leg may carry its own `maxPrice`. Not covered: a recovery that finishes or unwinds a half-placed bet on its own; an unknown order that stays unknown waits for a person.

Numeric settings (`GIVEN_PORT`, `GIVEN_TAKER_FEE_COEF`, `GIVEN_MAX_STAKE`, `GIVEN_RATE_LIMIT_PER_MIN`, `GIVEN_AUTO_SETTLE_MS`) must be plain numbers in range or the server refuses to start: `$25` or `20/min` used to become `NaN` and quietly switch the safeguard off.

### `POST /bets`

```json
{ "user": "primary", "event": "ETH2611180000", "condition": "GEMI-ETH2611180000-HI1720",
  "target": "GEMI-ETH2611180000-HI1820", "stake": 1 }
```

Optional: `maxPrice` (highest acceptable price per $1; default the live quote
plus 5 cents), `slippageTicks` (default 2), `onHedgeFail` (`"unwind"` default, or
`"leave"`). Answers 201 with `{ "bet": {...}, "stakeReduced": {...} | null }`.
The bet carries its `legs` (each with Gemini's order id), `cost`, `payoffs`, the
`offer` quote at the moment of trading, `scorable`, and `flow` (orders,
contracts, premium and production-rate fees for this bet). A refusal answers 422
with the `code` values listed under "How a bet executes" and the `quote`.

### `GET /bets?user=`

The ledger's bets, newest first; all users when `user` is left out.

### `GET /cashout?bet=` and `POST /cashout`

See "Cashing out". The GET prices the sale and sends nothing:

```json
{ "venue": "Gemini sandbox", "betId": "4f449ee5", "asOf": "<when the books were read>", "available": true, "code": null, "reason": null,
  "stake": 0.582, "proceeds": 0.19, "pnl": -0.392, "proceedsAtProductionFees": 0.17,
  "legs": [ { "role": "outcome", "symbol": "GEMI-SOL2611200300-HI72", "outcome": "yes", "quantity": 3, "price": 0.03, "available": 76 },
            { "role": "hedge", "symbol": "GEMI-SOL2611200300-HI71", "outcome": "no", "quantity": 0.6, "price": 0.16, "available": 15 } ] }
```

The POST takes `{ "bet": "4f449ee5", "minProceeds": 0.17 }` and answers `{ "bet": {...}, "cashOut": { "at", "stake",
"proceeds", "pnl", "complete" } }`. A refusal is `422` (or `409` for `not_open`) with `code`, `error` and the `quote`
it was refused on. It is queued with that account's bets, so its sells never interleave with another order, and it
answers `503 paused` while the kill switch is on.

### `POST /settle`

Runs settlement. Answers `{ "settled": [...], "needsReview": [...], "stillOpen": n }`. A settled bet's `settlement` has
`finishedAt` when Gemini reported the ladder's reference price on the settled contract (`settlementValue`, for example
`63696.058`): where the price ended, for showing a person. The payout never depends on it.

### `GET /flow`

The "Flow to Gemini" totals from the ledger (`?user=` for one user):

```json
{ "venue": "Gemini sandbox", "bets": 3, "ordersSent": 6, "ordersFilled": 6, "contracts": 17.09,
  "premium": 6.5745, "feesAtProductionRates": 0.28, "feesCharged": 0, "productionFeeCoef": 0.07,
  "note": "These orders ran on the Gemini sandbox, which charges no fees. ..." }
```

`premium` is contracts times price over every fill. `feesAtProductionRates` is
Gemini's published taker fee on each fill, rounded up to the cent per order.
Gemini has no builder attribution scheme, so this ledger is the only measure.

## What was learned from Gemini's sandbox (2026-11-17)

- Order entry works only over the WebSocket (`order.place`); the REST order
  endpoint returns HTTP 500 for every valid order. Reads over REST are fine.
- Subscribe to `orders@account` and wait for the ack before sending an order, or
  its fill events are not delivered. REST order history is the record of a fill.
- An immediate-or-cancel order fills only the size at the best price. The top
  of book is often a single contract, so sandbox bets are usually cut to about
  a dollar by the depth guard.
- Depth comes from the WebSocket stream `{symbol}@depth5`: a snapshot of five
  levels per side arrives about 300ms after subscribing and then every second.
  `UNSUBSCRIBE` works. `{symbol}@bookTicker` sends an empty string, not a
  number, for a missing side.
- `orderId` arrives as a bare 18-digit number, too long for JavaScript: two
  different orders were read as the same id. The executor now reads it as text
  (`globalOrderId` carries the same value as a string).
- Order history returns 50 rows per call unless paged (`limit`, `offset`), and a
  full page takes 1 to 3 seconds; asking for the newest 10 takes about half a
  second. The executor pages for `reconcile` and asks for the newest few when
  confirming a fill, which cut a bet from about 8 seconds to about 4.
- The event list endpoint can lag the single-event endpoint by about a minute
  after a market opens; quotes always use the single-event endpoint.
- Outcomes appear on the event (`resolutionSide`) about 5 to 9 seconds after
  expiry. `settlementValue` is the reference price the market settled against
  (for example 63696.058 for BTC), not a payout.
- Only the hourly crypto ladders have two-sided books; daily crypto and all
  commodity ladders were one-sided.
- Combos (parlays) cannot be created through the API, so bets across unrelated
  markets are not possible as a locked price; only linked contracts are.

## Sandbox liquidity seeder (`src/seeder.ts`, `npm run seed`)

**Built and tested here; not yet run on the sandbox** (it needs a second sandbox account, and no keys were available
where it was written).

The sandbox's books are about 19 cents wide and often hold one contract at the best price, so the offer rule refuses
nearly everything and the depth guard cuts a $10 bet to about a dollar. The seeder is a small market maker for the
sandbox only: from a **second sandbox account** it rests two-sided quotes, 4 cents wide and 40 contracts a side by
default, on every rung of the ladders being demoed. The executor then runs against that book with its rules unchanged
and the waiver off.

**It is not real liquidity, and the demo must say so.** Every bet it fills is one of our accounts trading with another
on a test exchange with test money. Set `GIVEN_SEEDED=1` on the executor whenever the seeder is running: `/health` then
reports `seeded: true` and the app shows "Seeded prices" in the nav and says in the footer that some prices are our own
test quotes. Never present those fills as order flow.

```bash
npm run seed -- --dry-run                 # what it WOULD quote, from public prices. Places nothing, needs no keys
npm run seed -- --user seeder             # quote the ladders that have prices; Ctrl-C cancels everything
npm run seed -- --user seeder --cancel    # cancel every seeder order on that account
```

On the hosted server (`scripts/serve.mjs`), `GIVEN_SEEDER=1` runs it beside the executor and sets `GIVEN_SEEDED=1`
for you, so the label cannot be forgotten; it is restarted if it stops and never takes the server down.

Options: `--event TICKER` (repeatable; default: the open ladders with prices, soonest to close, moving on as each
closes), `--half-spread 0.02`, `--size 40`, `--max-dollars 400` (per ladder), `--interval 5`, `--ladders 4`. The
account is `GEMINI_USER_SEEDER_KEY` / `GEMINI_USER_SEEDER_SECRET` in `.env`: a time-based-nonce key with trading and
balance permissions, on an account that is **not** the one the demo bets from.

How it prices and what it guarantees (`planQuotes`, covered by 29 tests including 1,500 random ladders):

- Fair value is the middle of the *other* participants' book on each rung (its own orders are subtracted from the
  depth it reads), interpolated across rungs with no book, and forced to fall as the strike rises.
- A quote never reaches the other side of the existing book, so it rests instead of trading; bid is always below ask.
- Its quotes never put a ladder out of order, and where the bots' own books are out of order by a few cents it covers
  the step (all rungs or none). This matters: the executor refuses every pair on an out-of-order ladder.
- "Sell YES at 0.57" is placed as "buy NO at 0.43". When both of a rung's quotes fill, Gemini nets them and pays the
  dollar, so the position closes itself.
- It stops and cancels two minutes before a ladder closes, on Ctrl-C, when `executor/data/SEEDER_PAUSED` exists, and
  when the account's cash runs low. Every order is tagged `gvs-…`, and a start or `--cancel` sweeps any left behind.
- It refuses to run off the sandbox whatever `GIVEN_ALLOW_PRODUCTION` says, and refuses to run as the demo's account.

What the dry run showed on the live sandbox (2026-11-18, about 22:25 UTC, four hourly ladders): **0 of 112 pairs
passed the offer rule as the books stood; 7 would with 4-cent quotes resting, 22 with 2-cent quotes**, and the one
out-of-order ladder came back in order. The rule counts Gemini's production fee on top of the spread, which is why a
4-cent book still refuses most pairs; 2 cents is tighter than production and should be described that way if used.

First run, on the machine with the keys:

1. Create a second sandbox account and API key; add `GEMINI_USER_SEEDER_KEY` / `_SECRET` to `.env`.
2. `npm run seed -- --dry-run`, then `npm run seed -- --user seeder --event <one ladder> --size 5 --max-dollars 30`.
3. Check in the sandbox UI that the orders rest, then that `npm run cli -- pairs` shows offers with the waiver off.
4. Ctrl-C and confirm nothing is left resting (`--cancel` if anything is).

Not verified until that run: that a good-till-cancelled order rests as expected, that `order.cancel` works on it, the
depth stream's shape with our own orders in it, any minimum size, and rate limits (it sends at most 16 orders a pass).
Until then the wire-level test only shows the pieces fit Gemini's documented protocol.

## Not built

- Sports ladder types ("over", "spread"): only "or above" ladders are paired.
- Sign-in for end users (Gemini OAuth). The API trusts the `user` name it is
  given and is meant for a local frontend with pre-connected demo accounts.
- Cut from the project: conditional orders across markets, combos, and "given
  the favourite doesn't win" bets.
- Not seen on the real Gemini sandbox yet: a falling parlay or a range that wins, and a refunded falling parlay. All
  four products were placed there on 2026-11-20: a falling parlay, a range and a breakout were cashed out; a falling
  parlay, a range and a breakout were held to settlement (the breakout won); and a two-leg basket was placed whole
  (`bk-a1e4e8d3`). See "Cashing out" and `docs/PLAN.md`. The results not yet seen are covered by the unit tests on
  the in-memory exchange, by the real client against the wire stand-in, and by
  `npm run rehearse`.
