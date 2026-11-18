# Name candidates

*2026-11-17. "Given" is the working name. This lists alternatives and what a collision check found. It is a check of
public traces, not legal advice: domains were tested for a nameserver record only (no record is a hint it is free, not
proof), trademarks were not searched in the USPTO database, and search coverage of Solana tokens and app stores is thin.
Re-check anything we pick before buying or printing it.*

## Recommendation

**Stakeback.** It is the plain words for the product ("your stake back if the first half fails"), the interface
already says "Stake back" on the middle outcome, and it was the only candidate with all four main domains
(.com .app .xyz .io), the GitHub name and the npm name all showing free. Nearest thing found: a planned browser extension
for checkout savings (getstakeback.com, launching 2027), which is a different market. The word "stake" may recall
Stake.com in a listener's mind; say it aloud once before committing.

**Runner-up: Barring** ("barring X, you get your money back"). Nothing in this space turned up and npm is free, but
barring.com is taken and the GitHub name is held by an unrelated account.

## Checked

| Name | Domains (.com .app .xyz .io) | Closest product in the space | GitHub / npm | Verdict |
|---|---|---|---|---|
| **Stakeback** | free? free? free? free? | none (a 2027 checkout-savings extension) | free / free | clear |
| **Barring** | taken, free?, taken, free? | none found | taken / free | clear |
| Assuming | taken, free?, taken, free? | none found | taken / free | clear, but a long unusual word |
| Contingo | free?, taken, free?, free? | none (sounds like Contango, a DEX; Kontigo, a fintech) | taken / free | minor |
| Proviso | taken (an AI firm), free?, taken, taken | none found | taken / taken | minor; "proviso" means a condition, which fits |
| Caveat | all taken | none; "caveat enforcers" is MetaMask delegation jargon | taken / taken | minor |
| Provided | .com taken, others mostly free? | none found | free / taken | minor, very generic |
| **Given** | all taken | none found; getgiven.com is a giveaway tool | taken / taken | minor, but a common word that is hard to search for or own |
| Hunch | .com taken | **a swipe-based prediction-market app (playhunch.xyz)** | taken / taken | serious |
| Cushion | all taken | **a US consumer-finance app acquired by LendingClub in 2025** | taken / taken | serious |
| Backstop | all taken | **Backstop Solutions (investment software); B.Protocol "DeFi backstop"** | taken / taken | serious |
| Mulligan | all taken | a registered Class 36 (financial services) mark, Mulligan Funding | taken / taken | serious |

None of the twelve is confusingly close to the other projects we run (Senthos, Totalis, Longshot, Twoprint, Pelagos,
Cumulant, Houseless, Headroom, sORBIO, Parcel, Intercepta, Living Tokens, Wardline, Compute Basis). The faintest overlap
is Contingo and Cumulant, which is minor.

## What a rename would touch (and what it must not)

The name is a brand decision, not a code one. Internal identifiers should stay `given` so a rename never collides with
Victor's branch or invalidates anything already written:

- `given-executor` is checked by the chain service before it will run (`assertExecutor`), and `docs/CONTRACTS.md` names it.
- The commit preimage and memo tags start with `given1|` and `{g:1,...}`; changing them breaks every existing record and the
  browser verifier. Victor's program uses its own domain string (`given:call:v1`) and the crate name `given_receipts`.
- Env vars are `GIVEN_*`, the ports and `docs/` use the name throughout.

So: rename only what a person sees (app title and wordmark in `web/`, README title, Devpost, the video) and leave the
identifiers alone. That is a one-commit change confined to `web/src/components/Shell.tsx`, `web/index.html`, the landing
copy and the README.

## Not verified

- Domain ownership beyond a nameserver check; parked or for-sale domains look "taken".
- Several sites sat behind Cloudflare challenges and could not be read.
- USPTO and other trademark registers; app stores; CoinGecko and Solscan.
- Whether the taken GitHub and npm names are active projects.
