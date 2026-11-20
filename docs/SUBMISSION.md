# Submission kit

*Draft, 2026-11-17. Everything here must be re-checked against the running product before it goes in Devpost, the video or
the pitch. Items marked **FILL** need something that does not exist yet.*

## Devpost form

| Field | Value |
|---|---|
| Main track | Consumer Apps |
| Chain award | Best use of Solana (opt in) |
| Bounties (tick each, and the matching prize opt-in) | Gemini Prediction Markets · QuickNode Streams |
| Not entering | Arc, ElevenLabs, Grok Bot |
| Program ID(s) | `8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK` (our program, `given_receipts`, devnet: checks each reveal against its commit) and `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` (the Memo program the readable record is written through). Authority key `2QfQ15Ha5VxvvwWqdsDdCyf6n8uxKfVDHh9GHZdFHeHz`. **Only claim the program for the demo if the hosted chain service runs with `GIVEN_PROGRAM_ID` set.** |
| Repo | public GitHub URL **FILL** (the repo is private until the owner switches it) |
| Demo | hosted URL **FILL** |
| Video | YouTube unlisted or Drive "anyone with the link", checked logged out **FILL** |
| Technologies | React, Vite, TypeScript, Node, Gemini Prediction Markets API (REST + WebSocket), Solana (our Anchor program + the Memo program), QuickNode Streams, WebCrypto |

## The five written answers (draft)

**What did you build?**
Given is a consumer app for defined-outcome bets on Gemini prediction markets: every result is on screen before you bet.
A **Stake Back**: you pick a condition and a target on a live price ladder; if the target is reached you win, if the
condition fails you get your stake back, if it holds but the target is missed you lose the stake (and it works going down
as well as up). A **Range**: win if a price finishes between two levels. A **Breakout**, its opposite: win if it finishes
outside them, whichever way. A **Basket**: several of these bets on different assets, placed together. Each bet is two
real orders in the user's own Gemini account, and an open bet can be sold back before the market settles. **Hunch** turns it round: say where you think a price finishes and how
sure you are, and the app lists the bets on offer that pay best if you are right, each one a tap from its builder. Every
call is recorded on Solana, committed before the result and revealed after, so a player can prove they made it before the result was known. A
leaderboard ranks skill against the market's own odds.

**What problem does it solve?**
Prediction markets punish you for the half of a hunch you are unsure of. A parlay loses everything when its first leg
fails. Sportsbooks sell "draw no bet" to fix that, but we found no one-tap version on a regulated exchange. Given builds it
from contracts that already exist, shows exactly what it costs, and keeps all money and positions on Gemini.

**How does it work?**
On a ladder of contracts at rising thresholds, buying YES on the higher threshold plus a sized NO on the lower one pays the
stake back if the lower threshold fails; a falling bet is the same thing on the mirror image of the ladder. A range buys YES
on a lower threshold and NO on a higher one, the same size, so one order always pays a dollar and the bet is the second
dollar for finishing between them. The executor sizes the hedge so the refund covers the stake and fees, checks the
book depth, places both orders over Gemini's WebSocket, and keeps a ledger that reconciles to Gemini's balance to the cent.
A chain service writes a salted hash of each call to Solana and later reveals it; our Solana program, in the same
transaction, rejects a reveal that does not reproduce its commit. A QuickNode Stream (Solana devnet, Programs + Logs, filtered
to our memo transactions) delivers those transactions to a webhook that re-reads each one from Solana before it adds a
leaderboard row, so a forged delivery cannot add anything; a minute-by-minute read of the chain is the safety net under it.
A proof page re-checks every call from Solana in the browser, and the leaderboard can be read by the browser from the
program's own score accounts, with our server not asked. The same ladder prices are also read as a histogram (the chance of
finishing between each pair of prices), which is what Hunch sets a person's own view against and what gives a basket's legs
on one ladder an exact joint chance.

**What makes it unique?**
A refund-if-the-condition-fails bet as a one-tap product on a regulated exchange, an honest cost (four numbers on every
quote, and pairs that cost too much are refused), and a track record that cannot be faked after the fact: commit-reveal
on Solana, checked in your own browser. Hunch starts from what the person thinks rather than from a contract list, and
lists nothing until their view differs from the market's by more than the bets cost. Crypto is invisible: no wallet, no
gas, no seed phrase.

**What would you build next?**
Maker-first pricing, which roughly halves the cost and adds resting liquidity to Gemini's book; Gemini OAuth sign-in once
production review allows it; sports ladders; payoffs with more than two orders on one ladder (a bet that pays more the
further the price goes); and conditional contracts listed by Gemini directly, for which Given is the demand evidence.

## 2–3 minute video (shot list)

| Time | Shot | Say |
|---|---|---|
| 0:00 | Landing hero | "Bet on the second half of your hunch. If the first half doesn't happen, you get your money back." |
| 0:15 | Builder: drag the two markers; numbers move | "Pick the thing that has to hold, then the thing you're betting on. Four numbers, no jargon: the chance, the fair price, what you pay, what you'd get selling now." |
| 0:45 | "How this bet pays" card | "Win, stake back, or lose. The odds are the market's own." |
| 1:00 | Place bet; receipt with two Gemini order IDs | "That is two real orders in my Gemini account." |
| 1:20 | Solana step | "The call is fingerprinted on Solana before the result. The fingerprint shows nothing." |
| 1:25 | Range tab: flip "Stays inside" to "Breaks out"; then Basket | "Same idea, other shapes. Think it stays put? Win if it finishes between two levels. Think it moves but not which way? Flip it: win if it finishes outside them. Or put several bets on different assets in one step." |
| 1:30 | Hunch: drag the centre up; the list fills; tap Open | "Or start from your view. This is where the market thinks it finishes. I think higher. These are the bets that pay if I'm right, and what each costs." |
| 1:35 | My bets: a win, a refund, a loss; Cash out on an open one | "A win, a refund, and a loss. We keep the loss. And an open bet can be sold back: that is two more orders, at the price shown or not at all." |
| 1:55 | Reveal → proof page → Verify on Solana | "My browser reads both records from Solana and recomputes the fingerprint. Nothing here asks our server." |
| 2:20 | Proof page: reconcile to the cent; "Orders sent" | "Our books match the exchange's to the cent, and this is what this account's bets have sent to the order book." |
| 2:40 | Leaderboard, then "Read from Solana" under it | "Ranked by edge over the market, fed by a QuickNode Stream. And this copy my browser just read from the program's own accounts: same players, same scores, our server not asked." |

Record on real devnet and the Gemini sandbox, not the local test exchange. **FILL** (not recorded yet. The keys, the funded wallet and the
devnet path are in place; it needs the hosted demo up and a ladder that has been open at least a quarter of an hour).

## Five-minute pitch

| Time | Beat |
|---|---|
| 0:00 | The hunch: "BTC holds 63k, will it reach 64.5k?" Every bet punishes the half you're unsure of |
| 0:30 | The gap: a parlay loses everything when the first leg fails; we found no one-tap refund-if-fails bet on a regulated exchange |
| 1:00 | Live demo (the golden path, trimmed) |
| 2:30 | Under the hood: two Gemini orders, commit-reveal on Solana, the Stream, reconcile to the cent |
| 3:15 | Honesty: the cost, the refused pairs, what we have not run on production |
| 4:00 | What it gives Gemini: order flow, and demand evidence for conditional contracts |
| 4:30 | Close |

Both teammates must be able to explain every component. Rehearse three times aloud, once with the network off using the
recorded fallback.

## Questions to expect

- **Why would anyone pay more than fair?** The refund is the product, the way "draw no bet" costs more than a straight bet.
  We show the markup on every quote and refuse pairs where it is too large.
- **What does it cost?** About 5¢ over fair per $1 on a good pair at production fees (median across Gemini ladders on our
  2026-11-17 snapshot was about 6.8¢ at production fees, which is why the refusal rule exists). The sandbox charges none.
- **What if a leg does not fill?** The bet is sized to the book's depth, only what filled is hedged, and if the hedge
  cannot be completed the position is sold back. Every order is written to the ledger before it is sent.
- **Is this allowed?** Our reading of Gemini's rules is that a member may trade their own account through the API; we have
  not asked Gemini and production needs their review. We never imply a partnership. Say this plainly.
- **Who can see my trades?** Nobody. The commit is a hash. A call becomes public only if the player reveals it, under an
  anonymous handle, never an account.
- **Can't a player just reveal their winners?** They can keep a call sealed, but not hide that they made it: every call is
  committed under their handle before the result, so the board shows calls sealed beside calls revealed, and anyone can
  count the commits on chain. Refunded calls are shown separately, because they can never be revealed.
- **Why should the leaderboard be trusted?** Every row is a verified commit-reveal pair, signed by our key, re-read from
  Solana. The one thing it takes on trust is the result, which our key attests with Gemini's order IDs as evidence.
- **Why Solana, and what does the program do?** Cheap, fast records the app can pay for so users never touch a wallet.
  The Memo is the readable record; our program, in the same transaction, recomputes the hash and refuses a reveal that
  does not match its commit or repeats one, and keeps each handle's score. It does not prove the result: our key attests
  that, with Gemini's order IDs as evidence.
- **How is this different from a parlay?** A parlay loses everything when its first leg fails. Given returns the stake.
- **Are these structured products?** No, and do not call them that. A structured product is something an issuer packages
  and stands behind. Given issues, pools and holds nothing: each bet is two plain orders in the user's own Gemini account.
  What it adds is the shape, shown in full before the orders are sent. The idea underneath is that a ladder has a contract
  at every level, like an options chain, so a payoff that changes only at those levels can be built exactly.
- **Is it a way to bet on volatility?** In plain terms, yes: Range is a bet that a price stays put and Breakout is a bet
  that it moves, with no view on direction. Say "stays put" and "big move", not "volatility". We found no venue listing
  "finishes outside these two levels" as one contract (searched 2026-11-19; do not say "first").
- **Doesn't Kalshi already show a distribution?** Yes, on some range markets, and we do not claim to be first. Ours is read
  from a ladder of "at or above" contracts, for the hour ahead, and it is the starting point for Hunch: your view set
  against the market's, and the bets that pay for the difference.
- **Could Gemini do this natively?** Its combo documentation describes a 2 to 6 leg AND contract, of which a range would be
  one (YES on the lower level AND NO on the higher) and a breakout its NO side. Combo creation was rejected in the sandbox
  when we tried (decision 6), so Given builds them from two orders. That is the demand evidence, not a workaround.
- **What happens in production?** Real fees, Gemini's OAuth review, and the value rule applies to real books (median spread
  about 4¢). None of that has been run.

## Before submitting

- [ ] Hosted demo link works logged out and on a phone.
- [ ] Repo public; secret scan over **history** (`.env`, `executor/data/`, `chain/data/` are ignored; run a scanner anyway).
- [ ] Video recorded on real devnet + Gemini sandbox; checked logged out.
- [ ] A real devnet commit and reveal exist, and `/verify/…` passes in the browser against them.
- [ ] The Stream exists (it does: `given-calls`, kept paused; reported by the teammate whose QuickNode account holds it,
      `npm run quicknode -- status` confirms it on a machine with the key) and, while it is running, a screenshot of its dashboard
      (network, dataset, filter, webhook, delivery count) is in the README. Not yet taken: it needs a real delivery.
- [ ] The Stream is **running only when needed**: `npm run quicknode -- pitch-on` before recording and before
      judging, `pitch-off` after (`docs/PITCH_DAY.md`). Running, it uses about 270k credits an hour (10.8M a day); the free
      trial holds 10M in total, shared with RPC calls.
- [ ] If the liquidity seeder is running while recording or presenting: `GIVEN_SEEDED=1` is set (the nav shows "Seeded
      prices"), the narration says the tight prices are our own test quotes, and nothing calls its fills order flow.
- [ ] `npm run dev:quotes` looked at on the day of recording: it shows the sandbox's real listing, which changes.
- [ ] README claims re-checked against what is actually running; every "not built" item either built or still listed.
- [ ] Devpost: track, chain award, both bounties, each prize opt-in ticked, all members, the five answers above.
- [ ] Travel to Austin for Saturday's finals (in person is required to win any prize).
