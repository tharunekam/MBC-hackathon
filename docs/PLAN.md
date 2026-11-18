# Given — plan to submission

*Last updated 2026-11-17. A plan, not a contract: move things, swap lanes and
re-cut as needed, and update this file when you do.*

## Dates that don't move

| When (CST) | What |
|---|---|
| Thu Nov 19, 15:00 | Feature freeze (our own rule) |
| **Fri Nov 20, 12:00 PM** | **Submission deadline on Devpost.** Aim to submit by 09:00; editing stays open until noon |
| Fri Nov 20, 11:59 PM | Finalists notified |
| Sat Nov 21 | Finals and closing ceremony in Austin. Pitches are 5 minutes plus 2 of Q&A. *Research says you must attend in person to win any prize; confirm on the official FAQ.* |

Sponsor office hours, 6–7 PM CST, drop-in:

| Sponsor | Days |
|---|---|
| Gemini | Tue Nov 17, Thu Nov 19 |
| QuickNode | Wed Nov 18 |
| Solana | Wed Nov 18, Thu Nov 19 |

## What we're entering

- Main track: **Consumer Apps** (needs a working user-facing frontend, some
  blockchain interaction, and crypto kept invisible to the user).
- Chain award: **Best use of Solana** (core onchain functionality, program IDs,
  a README section on how Solana is used; devnet is fine).
- Bounties: **Gemini Prediction Markets** (built on Gemini's prediction market
  APIs) and **QuickNode Streams** (at least one Stream with a filter and a
  destination, documented in the README).

Judging uses five unweighted criteria: technical execution, product and UX,
innovation, impact, demo.

## State of the build

| Piece | State |
|---|---|
| Gemini executor: quotes, two-leg bets, fees, ledger, settle, reconcile | **Built and proven in the sandbox** (`executor/`) |
| Executor guards: refuse poor-value pairs, depth check, void/fractional settlement | In progress |
| HTTP API for the frontend | In progress |
| Frontend: bet builder, quote, confirm, my bets, Flow to Gemini | Not started |
| Solana record of each call | Not started |
| QuickNode Stream → webhook → leaderboard | Not started |
| "Connect Gemini" (OAuth) | Not started; untested |
| Video, README, Devpost | Not started |

## Suggested split

Two lanes that meet at one interface: the executor emits "bet filled" and "bet
settled"; the ledger service records them on Solana. Swap lanes freely.

- **Lane A:** Gemini executor, HTTP API, frontend, demo, video, Devpost.
- **Lane B:** Solana program, QuickNode Stream, webhook, leaderboard.

Both teammates need to be able to explain every component live.

## Gates

| When (CST) | Gate | If it fails |
|---|---|---|
| Wed 11:00 | An OAuth token places a WebSocket order in the sandbox | Use pre-connected demo accounts (the executor supports several: `GEMINI_USER_<NAME>_KEY`) |
| Wed 14:00 | The Solana program is deployed on devnet with one recorded call | Ship structured records on Solana's built-in Memo program instead |
| Thu 12:00 | Core path is green end to end | No stretch goals; fix and polish only |
| Thu 15:00 | Feature freeze | — |

Do the Memo fallback first as a 45-minute smoke test: it proves the QuickNode
trial can stream devnet before any program exists.

## The demo's golden path

1. The user builds a bet and sees the four-number quote.
2. They confirm; two Gemini order IDs appear.
3. The call is recorded on Solana; an explorer link appears.
4. The Stream delivers it; a leaderboard row appears.
5. A bet placed earlier is shown settled: one that paid, one that refunded.
6. The Flow to Gemini panel shows what all of it sent to Gemini's book.

Seed bets need to be placed the evening before on ladders that settle the next
day: one whose condition is near-certain, and one whose lower strike will
probably fail, so a refund is on screen.

## Cut list, in order

Already out: the Living Tokens vault, trigger orders across markets, combos,
"given the favourite doesn't win". See `docs/GIVEN.md` for why and for what
would reopen each.

If behind, cut in this order:

1. Production and sports quote browser
2. Verify-from-chain page
3. Maker-first pricing
4. OAuth "Connect Gemini" (use demo accounts)
5. On-chain hash check (verify off-chain)
6. The custom Solana program (use Memo records)

Never cut: the frontend golden path, real sandbox orders, the fair-versus-paid
quote, the Flow to Gemini panel, a Solana record, the Stream-fed leaderboard,
explorer links, the README sections and the video.

## Submission checklist

- [ ] **Repo is public.** It is private today; the owner has to switch it.
- [ ] Root `README.md` describes Given, not Living Tokens, with: what it is; an
      architecture overview; how a bet works with a worked example; fees and
      disclosures; "not affiliated with Gemini"; which Gemini endpoints are
      used; Solana program ID(s) and how Solana is used; QuickNode network,
      dataset, filter, destination and why; setup; sandbox versus production;
      what is not built.
- [ ] Secret scan before going public. `.env` and `executor/data/` are
      git-ignored.
- [ ] 2–3 minute video on YouTube (unlisted) or Drive ("anyone with the link"),
      checked while logged out.
- [ ] Devpost: track, chain award, both bounties **and the matching prize
      opt-ins ticked**; program ID; all team members; the five set questions.
- [ ] Both teammates registered and eligible (the Devpost overview says students
      and invite only; its Rules tab is broader — confirm).
- [ ] Decide whether the Living Tokens folders stay in the submitted branch.
      Devpost says work must be built during the hackathon week; the history
      starts Nov 16, inside the window.

## Known hazards

- **QuickNode credits.** The free trial is billed per block whether or not the
  filter matches, and may last only a couple of days on devnet. Claim the
  hackathon plan, read the real multiplier in the dashboard, and pause the
  Stream outside dev and demo windows.
- **Solana toolchain.** Anchor 0.30.1 with Solana 1.18.26 reportedly fails to
  build a fresh project; Anchor 1.2.2 with Solana 4.1.2 is the current pair
  (not tested by us). Upgrading replaces the system-wide Solana install, which
  other projects on the same machine may depend on; Solana Playground avoids
  that.
- **Streams can't backfill on Solana**, and a Stream pauses after three failed
  deliveries. Host the webhook somewhere always-on, make writes safe to repeat,
  and fill gaps from RPC.
- **Sandbox quirks.** See `docs/GEMINI_API_NOTES.md`.
