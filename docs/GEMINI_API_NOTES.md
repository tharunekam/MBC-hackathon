# Gemini prediction-market API — working notes

*Last updated 2026-11-17. Each fact is marked **[verified]** (we ran it against
the sandbox), **[docs]** (read in Gemini's documentation or SDK source, not run)
or **[unknown]**. If what you observe differs, trust what you observe and fix
this file.*

Hosts: sandbox REST `https://api.sandbox.gemini.com`, sandbox WebSocket
`wss://ws.sandbox.gemini.com`; production `https://api.gemini.com` and
`wss://ws.gemini.com`.

## Accounts and keys

- **[verified]** The sandbox is self-serve at `exchange.sandbox.gemini.com` and
  funds new accounts with $100,000 of test USD. Gemini's site shows a "get the
  app" wall below desktop width; widen the window.
- **[verified]** Create an API key under Settings → API on the *Primary* account
  with the **Trading** role, "require heartbeat" off, and **time-based nonce**
  on. Put it in `.env` at the repo root (see `executor/README.md`). Each
  teammate and each machine needs their own.
- **[verified]** Prediction-market terms were already accepted on a fresh
  sandbox account (`GET /v1/prediction-markets/terms/status`).

## Authentication

- **[verified]** REST: JSON payload `{request, nonce, ...}` → base64 in
  `X-GEMINI-PAYLOAD`; HMAC-SHA384 hex of that in `X-GEMINI-SIGNATURE`; key in
  `X-GEMINI-APIKEY`. With a time-based-nonce key the nonce is Unix **seconds**.
- **[verified]** WebSocket: headers on the upgrade request — `X-GEMINI-APIKEY`,
  `X-GEMINI-NONCE` (seconds), `X-GEMINI-PAYLOAD` = base64(nonce),
  `X-GEMINI-SIGNATURE`.
- **[docs]** OAuth: scopes `orders:create`, `orders:read`, `positions:read`;
  access tokens last 24 hours, refresh tokens are single-use; bearer tokens work
  on the WebSocket; sandbox apps register immediately, production apps need
  Gemini's review (duration not published; contact trading@gemini.com). The
  docs say `orders:create` covers prediction-market order placement and that a
  WebSocket can authenticate with the same access token (`Bearer <token>` on the
  upgrade request; `developer.gemini.com/authentication/oauth.md`). The
  positions stream needs `positions:read`. **[unknown]** whether a bearer token
  can actually `order.place` over the WebSocket: no page says it outright. Test
  it (plan gate Wed 11:00). Terms must be accepted on the account before ordering.

## Licence and rules to check before the pitch

- **[docs, 2026-11-17]** Gemini's API agreement calls Gemini Market Data
  "proprietary", governed by a separate Market Data Agreement, with a
  non-transferable, non-sublicensable licence; redistribution needs a separate
  agreement (marketdata@gemini.com). Whether showing prices in a public app
  counts is **[unknown]**: ask. Nothing found on leaderboards, public-chain
  records, or tokenised positions. The rulebook (v1.13, July 2026) was not read
  in full: search it for "transfer".
- **[docs]** No builder code, referral or revenue share found. Taker rewards
  run to 2026-12-31 ($1.5M pool, $250k per-participant cap); whether orders
  placed through a third-party app count is **[unknown]**.
- **[docs]** Combos: the overview says live, AND-only, 2–6 legs, request-for-quote
  in production beta; the spec page says creation is not enabled in production.
  We could not reconcile this; the sandbox rejects creation (verified).

## Market data (no key needed)

- **[verified]** `GET /v1/prediction-markets/events?status=active&limit=100&offset=N`
  and `GET /v1/prediction-markets/events/{ticker}`. Contracts carry
  `instrumentSymbol`, `strike {type, value}`, `marketState`, and
  `prices {bestBid, bestAsk, buy, sell, lastTradePrice}` in YES prices.
- **[verified]** The list endpoint can lag the single-event endpoint by about a
  minute after a market opens. **Quote from the single-event endpoint.**
- **[verified]** Valid `status` filters: `active`, `approved`, `under_review`,
  `settled`.
- **[verified]** `bestAsk` (or `bestBid`) can be absent on a contract while
  `prices.buy.yes` is still present. The executor treats a missing `bestBid` or
  `bestAsk` as a one-sided book and refuses the pair.
- **[verified]** Outcomes: about 5 to 9 seconds after expiry a contract shows
  `status: settled`, `marketState: closed`, `resolutionSide: yes|no`,
  `resolvedAt`, `settlementValue`. The event's own `status` becomes `settled`
  too. **`settlementValue` is the reference price the ladder settled against
  (for example `63696.058` on a BTC ladder), not a payout.**
- **[verified]** Streams: `{symbol}@bookTicker` gives best bid/ask and sizes
  (`b`, `B`, `a`, `A`; the symbol comes back lower-case). **A missing side
  arrives as an empty string (`"a":""`), not a number**: `Number("")` is 0, so
  check for it. The message also carries `c` / `C`; when `a` was empty, `c`
  matched the event's `prices.buy.yes`. **[unknown]** what `c` means exactly.
- **[verified]** `{symbol}@depth5` sends
  `{"lastUpdateId", "symbol" (lower-case), "bids": [["0.83","1.00"], ...], "asks": [...]}`,
  best level first, up to five per side. The first snapshot arrives about 300 ms
  after `SUBSCRIBE` and then one per second whether or not the book changed.
  `{"method":"UNSUBSCRIBE","params":[stream]}` stops it. The executor's depth
  guard takes one snapshot per leg and unsubscribes, so expired hourly symbols
  do not pile up.
- **[docs]** A public `contractStatus` stream reports lifecycle changes, and
  `{agency}:{index}@indexPrice` streams the reference price a ladder settles on.
- **[verified, production, 2026-11-17]** Strike types seen: `above`, `below`,
  `over` (totals), `spread`, `under_or_equal`, `reference` (up/down markets) and
  null (moneylines, weather buckets). Live categories were Sports, Weather,
  Crypto and Commodities.

## Placing orders

- **[verified]** **Orders work only over the WebSocket.** REST
  `POST /v1/prediction-markets/order` returns HTTP 500 for every valid order in
  the sandbox, with the fields in the signed payload, in a JSON body, or both.
  Field validation works (bad price → 400), so it fails at execution. Spot REST
  orders work on the same key.
- **[verified]** Message:
  `{"id":N,"method":"order.place","params":{"symbol","side":"BUY"|"SELL","type":"LIMIT","price":"0.64","quantity":"10","timeInForce":"IOC"|"GTC","eventOutcome":"YES"|"NO","clientOrderId":"..."}}`.
  Prices are in the outcome's own terms: a NO order at 0.29 pays 29¢ per NO.
- **[verified]** **Subscribe to `orders@account` and wait for the ack before
  sending an order.** Orders sent earlier fill, but their events never arrive.
- **[verified]** An immediate-or-cancel order fills only the size at the best
  price. Check depth, or expect partial fills. In the sandbox the best level is
  often a single contract.
- **[verified]** Buying and selling both YES and NO works; a round trip returns
  the position to zero.
- **[verified 2026-11-18]** **Gemini keeps one position per contract and nets
  YES against NO at once, paying $1 a pair straight away.** Holding 1 YES on
  `…-HI1800` (one bet's target) and then buying 3.52 NO on it (another bet's
  condition) left a position of 2.52 NO and $1.00 more cash than the two orders
  cost. Total money is unchanged (the $1 arrives early instead of at
  settlement), but anything that tracks bets separately has to know: the
  reconcile counts it (`nettedContracts`, `nettedCash`), and the test exchange
  nets the same way. **Not handled yet:** an unwind that tries to sell a leg
  Gemini has already netted away. It needs a second bet to share a strike
  inside the few seconds between a bet's two orders; untested. A cash-out
  (below) refuses such a bet up front with `position_netted`.
- **[verified 2026-11-20]** **A bet can be sold back whole.** Four bets were
  cashed out on the sandbox between 02:22 and 02:28 UTC, one of each product
  and one over HTTP: each was two immediate-or-cancel `SELL` orders (a YES
  sold at its bid, a NO sold at 1 minus the YES ask), every one filled at the
  price just read from `@depth5`, and `reconcile` tied out after each. So
  `SELL` with `eventOutcome: "NO"` closes a NO position, as the docs imply.
- **[verified 2026-11-20]** **A fill can report a fractional average price.**
  A 1.03-contract buy came back with `avgExecutionPrice` 0.1105 (it filled
  across two levels). The reported average is rounded, so cash differed from
  the ledger by $0.000085, far inside the half-cent tolerance of `reconcile`
  but not zero. Do not assert an exact $0.00 on the live account.
- **[verified 2026-11-20]** **The size at the best price flickers to zero.**
  In the last 40 minutes of the SOL hourly ladder, two depth reads a fraction
  of a second apart disagreed four times running (a basket's up-front check
  saw size, the leg's own check saw 0), and "no two-sided market" came and
  went on single rungs within seconds. The sandbox's quoting bot appears to
  pull and replace its orders. Any check made before an order has to be made
  again immediately before it, which the bet path does.
- **[seen 2026-11-20, cause not isolated]** **A thin ladder is often out of
  order, and a basket's second leg on the same ladder was refused for it
  twice.** Each time the first leg had just filled and the second was refused
  because one rung's ask sat above a lower strike's. Our own fill may have
  caused it (it was suspected on 11-18 too), but the same ladder also went out
  of order in that window with no order of ours, so the bot's requoting alone
  may explain it. Either way: in a demo, put a basket's legs on different
  ladders. A basket with one leg on BTC and one on XRP, 14 minutes after
  those ladders were listed, went in whole on its second try.
- **[verified 2026-11-20]** The 04:00 UTC ladders were taking orders by 03:14
  (BTC and XRP both had pairs on offer under the waiver).
- **[verified 2026-11-18]** A contract's state can be `active/post_only`: the
  book is visible but taker orders are not accepted, so the offer rule refuses
  the pair as `market_closed`. What we saw on the sandbox's hourly ladders:
  **every newly listed ladder was post-only when first seen** (all 45
  contracts of the 07:00 UTC ladders, from 06:03 to at least 06:06; ETH and SOL
  were open by 06:15, BTC and XRP still were not),
  and BTC and XRP also showed it for a few minutes around 25 to 30 minutes
  before expiry while ETH and SOL stayed `active/open`. We do not know the
  rule. **For a live demo bet, pick a ladder that has been open a while and
  check its state first; do not count on the top of the hour.**
- **[verified]** `clientOrderId` is echoed in `orderUpdate` (`c`) and in REST
  order records. **[docs]** Length limit is 36 characters in one place and 100
  in another; stay under 36.
- **[verified]** Order IDs are 18-digit integers, larger than a JavaScript
  number can hold. Parse them as strings. This applies to REST too: order rows
  carry `orderId` as a bare number, and a plain `JSON.parse` gave two different
  orders the same id. The same row has `globalOrderId` as a string; use that, or
  quote `orderId` before parsing (the executor does both).
- **[docs]** Other methods: `order.cancel`, `order.cancel_all`,
  `order.cancel_session`. No amend, no batch over WebSocket. `timeInForce` also
  takes `FOK` and `MOC` (maker-or-cancel). Stop-limit is `LIMIT` plus
  `stopPrice`, on the same contract only.
- **[docs]** In `orderUpdate`, `Z` is the last fill on `FILLED` /
  `PARTIALLY_FILLED` but the cumulative fill on `CANCELED`, and a fully filled
  IOC ends as `CANCELED`. **Treat REST order history as the record of a fill.**
- **[verified]** In REST order history a fully filled IOC order has
  `status: "cancelled"` with `filledQuantity` equal to `quantity` and
  `remainingQuantity: "0"`. Read the fill from `filledQuantity` and
  `avgExecutionPrice`, never from `status`.
- **[docs]** The server drops a connection after 60 seconds without a pong.

## Account reads (REST, all POST)

- **[verified]** `/v1/prediction-markets/positions`, `/orders/active`,
  `/orders/history`; `/v1/balances` for cash. GET on these returns 405.
- **[verified]** **`/orders/history` is paged: 50 rows by default, newest
  first.** It takes `limit`, `offset` and `symbol` in the signed payload and
  returns `pagination {limit, offset, count}`. One unpaged call silently drops
  older orders, so follow the pages when checking the books (the executor's
  `reconcile` does).
- **[verified]** `/orders/history` is slow: 1.3 to 3.4 seconds for a 14-row
  page, about 0.5 seconds with `limit: 5`. `/orders/active` and `/v1/balances`
  took about 60 ms. To confirm an order sent a moment ago, ask for the newest
  few rows; this cut a two-order bet from about 8 seconds to about 4.
- **[docs]** There is no fills endpoint; per-fill data comes only from the
  `orders@account` stream. A `positions@account` stream reports settlement as a
  final row with position 0 and a payout.
- **[docs]** Buying YES reduces a NO position on the same contract.

## Fees

- **[verified]** The sandbox charged nothing: cash tied out exactly to price ×
  quantity.
- **[docs]** Production: taker `0.07 × contracts × P × (1 − P)`, maker
  `0.0175 × contracts × P × (1 − P)`, each rounded up to the cent; no settlement
  fee. Maker fees are waived until 2026-12-31. **[unknown]** whether rounding is
  per order or per fill.
- The executor models this with `GIVEN_TAKER_FEE_COEF`; `reconcile` fails if the
  setting doesn't match what the account was actually charged.

## Combos (parlays)

- **[verified]** `POST /v1/prediction-markets/combos` takes a JSON body
  `{"legs":[{"contractId":"<numeric string>","requiredOutcome":"Yes"|"No"}]}`
  (the id is the part after the dash in an event's contract id). In the sandbox
  it rejects every current contract; the newest sandbox combo dates from
  September 2026.
- **[docs]** Creation is "not currently enabled in production"; the
  request-for-quote flow is maker-only, and requests can only be opened in
  Gemini's own app. Combos are AND-only: no conditional logic.
- **[verified]** Production combo *prices* are publicly readable through the
  combo's event ticker (`/events/CMB-…`).

## The sandbox is not production

- **[verified]** It lists only crypto and commodities: 5-minute and 15-minute
  up/down markets, hourly and daily price ladders. No sports.
- **[verified]** Bots quote the hourly ladders with wide spreads (often 20¢).
  Only the hourly crypto ladders had two-sided books; daily crypto and every
  commodity ladder were one-sided. With spreads that wide the executor's offer
  rule refused all 105 two-sided pairs, so a sandbox demo needs
  `npm run start:demo` (see `executor/README.md`).
- **[verified, seen once]** About eight minutes before the 00:00 UTC hourly
  expiry the ETH book tightened to about 3¢ and 5 pairs passed the offer rule.
- **[verified]** The far end of a ladder is sometimes out of order by a cent
  (a higher strike asking 0.21 against 0.20 below it).
- **[unknown]** Reset schedule, rate limits, connection limits, and how voided
  or fractional settlements appear.
- **Nothing in this repo has been run against production.**
