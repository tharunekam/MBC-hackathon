# Given — concept, decisions and open questions

*Last updated 2026-11-17. This is the current best version and the evidence
behind it. It is meant to be changed: see "How to change this document" at the
end.*

## The idea in one paragraph

Given lets someone bet "given X, will Y?" and get their money back if X doesn't
happen. On a Gemini price ladder (a set of contracts on one number at rising
thresholds), that bet can be built from two ordinary orders in the user's own
Gemini account: buy YES on the higher threshold, and buy a sized NO on the lower
one. If the lower threshold fails, the NO pays the stake back. If both hit, the
bet pays $1 per contract. If only the lower one hits, the stake is lost.

Example: "Given BTC closes at or above $63,000, will it reach $64,500?" At
production prices on 2026-11-17 that cost about 72¢ per $1 of payout, against a
fair price of about 67¢.

## Why this shape

- **It's a real gap.** Our prior-art search found no venue selling a
  refund-if-the-condition-fails bet. Kalshi, Polymarket and Gemini sell combos
  (parlays), which lose everything when the first leg fails. Gemini's combo
  documentation says conditional logic is "not available at launch and will be
  evaluated after launch".
- **It is not our invention.** Building a conditional bet from linked contracts
  is published (Robin Hanson, 2003). Sportsbooks sell the same payoff, priced by
  the house, as "draw no bet" and "betting without the favourite". Our claim is
  the product: one tap, on a regulated exchange, from contracts that already
  exist. Say "we found no one-tap retail version", never "first ever".
- **Value flows to Gemini.** Every bet is two orders on Gemini's own order book,
  in the user's own account. Nothing is held off the exchange.
- **It already works.** The executor in `executor/` has placed real, hedged bets
  in Gemini's sandbox, and its ledger ties out to the account's cash balance.

## What the user sees

Lead with the sportsbook phrase people know: **"money back if…"**. Suggested
headline: *"Bet on the second half of your hunch. Money back if the first half
doesn't happen."*

Every quote shows four numbers, in plain words:

1. Chance both happen, per today's market.
2. Fair price per $1.
3. What you pay per $1, including the spread and Gemini's fees.
4. What you'd get back if you sold immediately.

The app refuses pairs that are poor value (see "The cost problem").

## The products

All three are plain orders on contracts that already exist, so nothing here needs anything from Gemini that the first bet
did not.

- **Return Parlay.** The bet above. It goes either way: a rising parlay bets that a price reaches a higher level given that
  it first holds a lower one; a falling parlay bets that it falls to a lower level given that it first stays under a higher
  one. A falling parlay is the rising bet on the mirror image of the ladder, so it shares every check and every line of
  sizing code with it.
- **Range.** Win if the price finishes between two levels. YES on the lower level and NO on the higher, the same number of
  contracts of each. One of the two always pays $1, so the bet is the second dollar for landing inside, and its price is what
  the pair costs above that dollar. At least one dollar per contract comes back whatever happens.
- **Basket.** Two to six of the above, on any ladders, placed in one request. A basket adds two things: every leg is checked
  against the live market before the first is placed, and the placed bets are shown together. It is not atomic: nothing on
  the exchange links the legs.

## How value reaches Gemini

- **Order flow.** Two real orders per bet. On a $100 bet that is roughly 240
  contracts and, at production rates, about $3 in taker fees.
- **Where Gemini needs it.** Research (DeFi Rate figures; re-verify before
  quoting) put Gemini at under 1% of US prediction-market volume, about $43M in
  30 days, with crypto about 21% of that and falling. Crypto ladders are where
  Given works best.
- **Evidence for their roadmap.** It demonstrates demand for the conditional
  logic Gemini has said it will evaluate.
- **Measurable.** Every order carries a tag (`gv-…`), so the flow can be
  counted. Gemini has no builder code or revenue share that we could find;
  proposing one is a fair ask.
- **Shown in the app.** A "Flow to Gemini" panel: orders, contracts, premium,
  and the fees each bet would pay at production rates (the sandbox charges none).

## The cost problem (the sharpest risk)

A Given bet crosses two spreads and pays two fees, so it costs more than fair
value. On the 2026-11-17 production snapshot:

- Before fees, the median markup on ladder pairs was about 3¢ per $1.
- With Gemini's taker fee (0.07 × contracts × price × (1 − price)), the median
  on crypto and commodity ladders was about 6.8¢, or 15.5%.
- Longshots conditioned on unlikely events are much worse.

What we do about it:

- **Show it.** Fair price, price paid, and instant cash-out value on every quote.
- **Refuse bad pairs.** Current rule: refuse when the all-in price is 0.95 or
  more, or the markup is over 8¢ or 20%; warn between 5–8¢ or 15–20%. Under this
  rule 91 of 223 crypto and commodity pairs passed. *This threshold is a
  judgment call:* a stricter 5¢ / 15% rule left only 15. Tune it with data.
- **Maker-first pricing (not built).** Resting the first order instead of taking
  it roughly halves the markup and adds resting liquidity to Gemini's book.
  Maker fees are waived until 2026-12-31.

## Decision log

Status: **Decided** = settled unless new evidence appears. **Provisional** =
our current pick, cheap to change. **Open** = not settled.

| # | Decision | Status | Why | What would change this |
|---|---|---|---|---|
| 1 | Core product is the "money back if" bet on linked contracts | Decided | Novel on a regulated venue; works today from two plain orders; proven in sandbox | Gemini says a third-party app may not place a user's own orders |
| 2 | Lead with crypto ladders | Provisional | The only liquid ladders in the sandbox; 68% of crypto contracts have two-sided books vs 20% in sports | Gemini lists a sports ladder in the sandbox |
| 3 | Money and positions stay on Gemini; nothing tokenized | Decided | Our reading of Gemini's rulebook is that a member can't transfer a position's benefit off the exchange or trade for others (July 2026 version; October amendments unread) | Gemini says otherwise in writing |
| 4 | Living Tokens vault, tokens and hedge engine are cut | Provisional | Same rulebook reading as #3, plus days of work | Gemini confirms the vault model is acceptable |
| 5 | Cross-market trigger orders are cut | Provisional | Can't lock a price; needs standing authority over the user's account | Gemini confirms unattended OAuth orders, and we frame it as an order, not a price lock |
| 6 | Combos are not used | Decided | Creation is rejected in the sandbox and documented as not enabled in production; no taker API | Gemini enables combo creation or request-for-stream for a sandbox key |
| 7 | "Given the favourite doesn't win" is cut | Provisional | No such markets in the sandbox; if no winner is declared every outcome can lose | A market type with a guaranteed single winner, and a void rule we've read |
| 8 | A Solana record of every call is required | Decided | The Consumer track needs blockchain interaction and Gemini isn't a chain | The track rules change |
| 9 | Solana design: commit-reveal records through the **Memo program** (shipped 11-17), with our own Anchor program (`given_receipts`, deployed on devnet 11-17) checking each record in the same transaction | Decided for now | Memo records prove when a call was made and that it wasn't edited, and the whole path (commit, reveal, hash check, Stream-fed leaderboard) is built and tested. The program (built and tested 11-17 night, opt-in through `GIVEN_PROGRAM_ID`) adds on-chain validation and state without changing the Memo, so nothing that reads Memos had to change | The program misbehaving on devnet: unset `GIVEN_PROGRAM_ID` and Memo records carry on alone |
| 10 | Leaderboard ranks skill against the market price, not profit or volume | Provisional | Profit is mostly luck at small samples; ranking by volume conflicts with exchange rules on inflated volume | A better scoring rule, tested on data |
| 11 | Sign-in is OAuth; our own sandbox keys for the demo | Open | OAuth is Gemini's sanctioned route. 11-17: Gemini's docs say a bearer token can authenticate the WebSocket and `orders:create` covers prediction-market orders, but no page says outright that it can `order.place`; sandbox apps register immediately, production needs review | The OAuth test on Wednesday morning |
| 12 | Refusal threshold is 8¢ / 20% | Provisional | See "The cost problem" | Data from more snapshots; maker-first pricing changing the economics |
| 13 | Maker-first pricing is the first stretch goal | Provisional | Improves both the price and the value-to-Gemini case | Fill and legging risk proving worse than expected in the sandbox |
| 14 | Name: "Given" | Provisional | Short, says the mechanic | A better name |
| 15 | Solana record is **commit at bet time (hash), reveal after settlement (opt-in)**; the app is fee payer and authority, users never hold a wallet | Provisional | Keeps trades off a public chain by default (guardrail), gives the program real state to check, and keeps crypto invisible for the Consumer track | A rule that requires user-held keys; the program not working by the Wednesday gate (fall back to Memo records) |
| 16 | The demo is **hosted** (web + executor on an always-on host), sandbox-only, with a stake cap and per-visitor sessions | Decided | Devpost requires a working demo or deployed app; the QuickNode webhook needs an always-on host anyway | Gemini says no public sandbox demo |
| 17 | Both teammates attend the Nov 21 finals in person | Decided (needs D4 confirmation) | Rules: presence in person is required to qualify for any prize, bounties included | The organizers confirm a remote option in writing |
| 18 | We run a **sandbox liquidity seeder** and disclose it | Provisional | Sandbox books are ~20¢ wide, so quotes and depth look nothing like production without it | Gemini tightens the sandbox, or says seeding is not allowed |
| 19 | Priority order: Gemini bounty, then Consumer track, Solana, QuickNode, Official | Provisional | Gemini 1st is a finalist slot; Gemini's judges value real API use and order flow most | The Gemini office-hours answers change what they want to see |
| 20 | Three products: Return Parlay (rising or falling), Range, Basket | Decided | Each is two plain orders per bet on contracts that already exist, so each is as exchange-friendly as the first bet. Built and tested on the local test exchange and through the real client on the wire stand-in; not yet run on the real sandbox | Gemini says a third-party app may not place a user's own orders (the same as decision 1) |
| 21 | A falling parlay is the rising parlay on the mirror of the ladder | Decided | The pairing, offer rule, depth guard, sizing, unwind and settlement are the code the rising bet already has, run on a ladder whose strikes are negated and books flipped; only the order sides differ. One implementation means one set of tests | A ladder whose NO book is not the mirror of its YES book |
| 22 | A basket is not atomic | Decided | No exchange primitive links the legs. Every leg is checked first, a leg that fails stops the rest, and the app says plainly what was and was not placed | The exchange lists a basket or combined-order primitive |
| 23 | A bet id carries its product (`dn-` falling, `rg-` range) | Decided | The id is committed on Solana with the call and revealed with it, so the proof page and leaderboard can say what a call was without changing the hash format or the deployed program, and the label cannot be changed after the result | A program upgrade that commits a product field instead |
| 24 | The ladder is also shown as a histogram, and **Hunch** ranks the bets on offer against a view the person enters | Provisional | A ladder's neighbouring prices differ by the market's chance of finishing between them, so the histogram is exact and needs no model. A person's view is the market's own curve moved and squeezed, so an unmoved view is the market's and nothing is listed: no difference on screen is an artefact of fitting a shape. It adds no order type and touches no order path: every listed bet opens in the builder that already places it | People read "bets that fit your view" as advice from us. The page says the odds are theirs and the market may be right; if that is not enough, drop the ranking and keep the histogram |

## Open questions

For Gemini (office hours; see `docs/PLAN.md` for dates):

- Is a free consumer app that places each user's own orders acceptable, and what
  would production review need? *This tests the concept itself.*
- Can an OAuth token place orders over the WebSocket, and with which scope?
- May we display Gemini's prices, and record a user's entry price and result on
  a public chain with their opt-in?
- Is conditional logic on the roadmap, and would Gemini consider a builder code?
- Can the sandbox list a sports ladder?
- Are fees rounded per order or per fill? How do voided or fractional
  settlements appear in the API?

For us:

- Does maker-first pricing work in practice (how long does a resting order take
  to fill; how far does the other leg move meanwhile)?
- Do sports ladders nest cleanly? Spread and totals ladders look nested, but a
  spread event holds both teams' ladders, and spread vs moneyline lives in
  different events with settlement rules we haven't read.
- What does Gemini's own Predictions leaderboard rank? We couldn't see it.
- Has anything changed in the October 2026 rulebook amendments?

## Ideas worth exploring

None of these are commitments. Each is a direction someone could pick up.

- **Maker-first pricing.** Rest the outcome order (maker-or-cancel), hedge the
  moment it fills. Halves the cost; adds book depth for Gemini.
- **Sports ladders.** Production had about 6,900 tradable linked pairs across
  169 events on 2026-11-17, almost all sports totals and spreads (strike types
  `over` and `spread`). The executor only handles `above`. A read-only quote
  browser over production would show breadth without trading.
- **Other bets one ladder can express.** Range bets and the falling parlay are
  built (see "The products"). A three-strike chain adds nothing: "given A, then B,
  will C" is the same bet as "given B, will C", because a failure at B already
  refunds a failure at A.
- **Draw no bet / without the favourite.** The same idea on winner lists. Needs
  a market where exactly one outcome wins, and a clear void rule.
- **True cross-market bets.** If Gemini opens combo creation, "given X, will Y?"
  across unrelated markets becomes exact: buy the combo plus a sized NO on X.
- **Conditional contracts as a product ask.** If Gemini listed "given" contracts
  on each ladder directly, the second spread disappears. Given is the demand
  evidence.
- **What survives from Living Tokens.** The instinct that value must flow to
  Gemini drove this whole design. The "Underdog Stamp" could return as a
  non-monetary receipt for a call made at long odds.
- **Verify-from-chain page.** Rebuild the leaderboard from Solana alone, with no
  backend. **Built 2026-11-19** as "Read from the program" on the leaderboard page: the browser reads the program's score
  accounts and lines them up against the server's table. It holds totals only; rebuilding each call from Memos alone is
  still open.
- **Payoffs with more than two orders.** Any payoff that steps at rungs can be built exactly from one order per step (a bet
  that pays more the further the price goes is YES on several rising strikes). The ledger, the receipt and the Solana
  record all assume two named strikes, so it is a new product rather than a setting; the histogram already draws what it
  would pay.
- **A protection dial.** Sizing the refund order to return part of the stake, not all of it, trades the refund for a
  bigger win. It changes what a failed condition means for scoring (today it voids the call), so it needs a rule first.

## What is verified and what is not

Verified by us, by running it:

- Two-leg bets place, hedge, settle and reconcile in Gemini's sandbox.
- Buying and selling both YES and NO works; cash ties out to the cent.
- Order tags are echoed back by Gemini.
- Outcomes appear in the API about 5 seconds after expiry.

Not verified:

- **Nothing has run on production Gemini**: not fees, not sports ladders, not
  OAuth.
- Rule and management quotes came from documents read second-hand. Check each
  against the source before it goes in the pitch, README or Devpost.
- Whether another startup already ships conditional bets (one article said some
  are trying, and named none).

## How to change this document

Change it. If you've learned something that meets a decision's "what would
change this" bar, or you simply have a better idea and a reason, edit the
decision, set its status, and note what you observed in the commit message.
Add new ideas to "Ideas worth exploring" freely. If you cut something, say why,
so the next person knows when to reopen it.
