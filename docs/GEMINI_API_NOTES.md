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
  Gemini's review. **[unknown]** whether a bearer token can place WebSocket
  orders, and which scope allows it.

## Market data (no key needed)

- **[verified]** `GET /v1/prediction-markets/events?status=active&limit=100&offset=N`
  and `GET /v1/prediction-markets/events/{ticker}`. Contracts carry
  `instrumentSymbol`, `strike {type, value}`, `marketState`, and
  `prices {bestBid, bestAsk, buy, sell, lastTradePrice}` in YES prices.
- **[verified]** The list endpoint can lag the single-event endpoint by about a
  minute after a market opens. **Quote from the single-event endpoint.**
- **[verified]** Valid `status` filters: `active`, `approved`, `under_review`,
  `settled`.
- **[verified]** Outcomes: about 5 seconds after expiry a contract shows
  `status: settled`, `resolutionSide: yes|no`, `resolvedAt`, `settlementValue`.
- **[verified]** Streams: `{symbol}@bookTicker` gives best bid/ask and sizes
  (`b`, `B`, `a`, `A`; the symbol comes back lower-case); `{symbol}@depth5`
  gives the top five levels.
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
  price. Check depth, or expect partial fills.
- **[verified]** Buying and selling both YES and NO works; a round trip returns
  the position to zero.
- **[verified]** `clientOrderId` is echoed in `orderUpdate` (`c`) and in REST
  order records. **[docs]** Length limit is 36 characters in one place and 100
  in another; stay under 36.
- **[verified]** Order IDs are 18-digit integers, larger than a JavaScript
  number can hold. Parse them as strings.
- **[docs]** Other methods: `order.cancel`, `order.cancel_all`,
  `order.cancel_session`. No amend, no batch over WebSocket. `timeInForce` also
  takes `FOK` and `MOC` (maker-or-cancel). Stop-limit is `LIMIT` plus
  `stopPrice`, on the same contract only.
- **[docs]** In `orderUpdate`, `Z` is the last fill on `FILLED` /
  `PARTIALLY_FILLED` but the cumulative fill on `CANCELED`, and a fully filled
  IOC ends as `CANCELED`. **Treat REST order history as the record of a fill.**
- **[docs]** The server drops a connection after 60 seconds without a pong.

## Account reads (REST, all POST)

- **[verified]** `/v1/prediction-markets/positions`, `/orders/active`,
  `/orders/history`; `/v1/balances` for cash. GET on these returns 405.
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
- **[unknown]** Reset schedule, rate limits, connection limits, and how voided
  or fractional settlements appear.
- **Nothing in this repo has been run against production.**
