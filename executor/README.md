# Given executor

Places "given X, will Y?" bets on Gemini prediction markets as real orders, and
keeps its own ledger of what it did.

A conditional bet is built from two linked contracts in one event. Example on an
ETH price ladder: buy YES on "$1,820 or above" and a sized NO on "$1,800 or
above". If the condition ($1,800) fails, the NO leg pays the stake back. If both
hit, the bet pays $1 per contract.

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
`--user <name>`. The key needs the Trading role and **time-based nonce** enabled.
The service refuses to start against production unless `GIVEN_ALLOW_PRODUCTION=1`.

## Commands

```bash
node src/cli.ts pairs                 # conditional bets tradable right now
node src/cli.ts pairs ETH2611180000   # ...for one event
node src/cli.ts bet <event> <conditionSymbol> <targetSymbol> <stake> [--max 0.60] [--slip 2] [--leave]
node src/cli.ts bets                  # the ledger
node src/cli.ts settle                # record results once Gemini resolves
node src/cli.ts reconcile             # check the ledger against Gemini (orders and cash)
node src/cli.ts recover               # repair a bet interrupted mid-flight
npm test                              # unit tests (no network)
npm run typecheck
```

## How a bet executes

1. Read the live book for both contracts and quote `ask(B) / bid(A)` per $1.
2. Buy YES on B, immediate-or-cancel. Only what actually fills is hedged.
3. Buy NO on A, sized from B's real cost and rounded up, so the refund covers
   the stake even at the worst allowed fill. Retried up to three times.
4. If the hedge can't be completed within the price limit, the position is sold
   back (default) or left flagged `unhedged` (`--leave`).

Every order carries a tag (`gv-<betId>-...`) and is written to
`data/ledger.json` before it is sent, so an interrupted bet can be repaired by
looking the tag up on Gemini instead of resending.

## Fees

Gemini's published taker fee is `0.07 x contracts x price x (1 - price)`, rounded
up to the cent. The sandbox charged nothing. Quotes, hedge sizing and the ledger
all include the fee through one setting, `GIVEN_TAKER_FEE_COEF` (default `0` on
the sandbox and `0.07` on production). `reconcile` fails if the setting is wrong,
because the cash balance will not tie out.

## What was learned from Gemini's sandbox (2026-11-17)

- Order entry works only over the WebSocket (`order.place`); the REST order
  endpoint returns HTTP 500 for every valid order. Reads over REST are fine.
- Subscribe to `orders@account` and wait for the ack before sending an order, or
  its fill events are not delivered. REST order history is the record of a fill.
- An immediate-or-cancel order fills only the size at the best price.
- The event list endpoint can lag the single-event endpoint by about a minute
  after a market opens; quotes always use the single-event endpoint.
- Outcomes appear on the event (`resolutionSide`) about 5 seconds after expiry.
- Combos (parlays) cannot be created through the API, so bets across unrelated
  markets are not possible as a locked price; only linked contracts are.

## Not built yet

- Conditional orders across markets (trigger watcher).
- HTTP API for the frontend.
- "Given the favourite doesn't win" bets on winner lists.
