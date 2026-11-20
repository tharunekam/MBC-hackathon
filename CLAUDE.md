# Given — project context

This file is loaded automatically by Claude Code sessions in this repo. It is
also the fastest way for a person to get oriented.

## What this is

**Given** is our entry for the UBC 2026 hackathon (submission due
**Fri 2026-11-20, 12:00 PM CST**). It is a consumer app for "money back if…"
bets on Gemini prediction markets: you bet on the second half of a hunch and
get your stake back if the first half doesn't happen. Each bet is two real
orders in the user's own Gemini account.

The repo started as "Living Tokens" (a vault-and-token design). That draft was removed from the working tree on
2026-11-17 and is preserved at the git tag `living-tokens-draft`; the current direction is described in `docs/GIVEN.md`.
The root `README.md` is the public description of Given.

## Read these, in this order

1. `docs/GIVEN.md` — the concept, the decision log, open questions and ideas
   worth exploring.
2. `docs/PLAN.md` — the build plan to Friday, gates, cut list and submission
   checklist.
3. `docs/GEMINI_API_NOTES.md` — what Gemini's API actually does, verified
   against the sandbox. Read before touching anything that talks to Gemini.
4. `executor/README.md` — the working code: what it does and how to run it.

## Nothing here is locked

The docs record the **current best version and the evidence behind it**, not a
contract. Anyone working here — either teammate, or a Claude session on any
machine — is expected to keep exploring and to change direction when the
evidence supports it.

- Every decision in `docs/GIVEN.md` has a status (decided, provisional or open)
  and a "what would change this" column. Use it: if you learn something that
  meets that bar, change the decision.
- When you change a decision, update the log in the same commit and say what
  you observed. A one-line reason beats a silent rewrite.
- Prefer evidence you produced yourself (a sandbox run, a data pull, a test)
  over anything written in these docs. Several facts here came from documents
  read second-hand and are marked as such.
- Ideas that were cut are listed with the reason. A cut is "not now, for this
  reason", so reopening one is fine once the reason no longer holds.

## Working conventions

- **Branches:** work on a feature branch and push it; `main` only changes by
  agreement between the two teammates.
- **Secrets:** Gemini credentials live in `.env` at the repo root, which is
  git-ignored. Never print, log or commit them. Each machine needs its own
  copy; it does not travel through git.
- **Sandbox only:** the executor refuses to run against production Gemini
  unless `GIVEN_ALLOW_PRODUCTION=1` is set. Don't set it without both
  teammates agreeing; production means real money.
- **Prove it:** a change to anything that places orders or moves money is done
  when it has been run and the result observed, not when it compiles. For the
  executor that means `npm test`, `npm run typecheck`, and for order-path
  changes a real sandbox run followed by `node src/cli.ts reconcile`.
- **The repo will be public** for submission. Don't commit anything you
  wouldn't want a judge to read: no credentials, no personal details, and no
  raw research notes (the conclusions belong in `docs/`).

## Running it

Three packages: `executor/` (places the Gemini orders), `chain/` (Solana commit-reveal and the leaderboard) and `web/`
(the app). From the repo root:

```bash
npm run install:all
npm run dev        # whole stack with NO keys and no SOL: local test exchange + in-memory chain + web
npm run status     # who is listening on this project's ports (web 5273, executor 8741, chain 8742)
npm run stop       # stop this project's servers (never touches another project's)
npm run dev:quotes # REAL Gemini sandbox prices and order books, no keys, every order refused
npm run dev:live   # real Gemini sandbox + Solana devnet; needs .env keys and a funded chain/data/authority.json
npm run preflight  # which of the above is ready, and the exact fix for what is not (places nothing)
npm run rehearse   # the golden path through the real executor + chain code, Gemini and Solana stood in on the wire
npm run build      # production web build; npm start serves it with both backends on one public port (see docs/DEPLOY.md)
npm run check:deploy -- https://your-demo   # checks a deployed demo from outside (add --bet to place one small bet)
npm run quicknode -- pitch-on | pitch-off   # start / pause the QuickNode Stream (kept PAUSED: it bills per block); runbook: docs/PITCH_DAY.md
npm run e2e        # the production build in real Chrome: golden path, live updates, a not-open market, a click storm, phone layout
npm test           # every package
npm run typecheck
```

- The ports are fixed and the stack refuses to start if one is taken, naming who holds it. Do not change a port to dodge
  a clash: a service that quietly talks to another project's server is worse than one that does not start.
- `chain/data/` and `executor/data/` hold keys, salts and ledgers and are git-ignored.
- `docs/CONTRACTS.md` lists every endpoint and what each lane still owes. `chain/README.md` covers Solana and QuickNode,
  including what has and has not been verified.

## Wording guardrails (from our reading of Gemini's rules; re-verify before the pitch)

- Never say "risk-free" or "guaranteed". Say "money back if…" and show the cost.
- Never imply a partnership with Gemini. Say "uses Gemini's API; not affiliated
  with Gemini".
- Never match users against each other, and never rank or reward by volume.
- Don't put Gemini's price feeds, or anything that identifies a user's trades,
  on a public chain.
