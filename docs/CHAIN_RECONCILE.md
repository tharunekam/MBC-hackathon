# Two chain lanes: where they overlap and how to converge

*2026-11-17 (evening). Written from reading Victor's branch `feat/solana-receipts-feed` (3 commits, 2026-11-17), running its
tests, and querying devnet, against our `chain/` on `plan/scope-v2`. Neither branch is merged. Nothing on Victor's branch was changed.*

## The situation

Both of us built the chain lane, in parallel, to the same contract (`docs/CONTRACTS.md`). It was never going to be
noticed until someone looked: the branches do not touch each other's files.

| | `chain/` (plan/scope-v2) | `receipts-feed/` + `receipts-program/` (feat/solana-receipts-feed) |
|---|---|---|
| On-chain record | **Memo program** records (`{g:1,t:'c'...}`), no custom program | **Anchor program** `given_receipts` (`commit_call`, `reveal_call`, `CallerStats` accounts) |
| Commit hash | `sha256("given1\|betId\|event\|…\|salt")` | `sha256("given:call:v1" ‖ borsh(details) ‖ salt)` |
| Checks on chain | none; the **service and every verifier** re-check | the **program** checks the hash, that the commit predates the event's expiry, that the event has closed (chain clock), and scores the edge |
| Who may write | memos signed by the authority key only count | the recorder key named in the program config |
| Leaderboard source | Stream hint, re-read from Solana, plus RPC backfill | `CallRevealed` events from the Stream, plus RPC backfill; `CallerStats` accounts as a cross-check |
| Stream filter + create script | filter + docs (`chain/README.md`) | filter + `scripts/create-stream.ts` |
| Browser proof page | yes (`/verify/:sig`, recomputes the hash in the browser) | no |
| Public reveal route | `GET /reveals/:signature` | `GET /receipts`, `GET /events` (SSE) |
| Dev stack, wire tests, rehearsal | yes (68 tests, stand-in Solana node, `npm run rehearse`) | `npm run e2e` needs `solana-test-validator` |
| Tests run here | 68 pass | 22 pass (service side); the program's Rust tests were not run (no Anchor/Solana CLI on this Mac) |
| Status | runs today against a stand-in node and the rehearsal; **no real devnet record yet** (wallet unfunded) | **deployed on devnet** (queried 2026-11-18 04:50 UTC) with a real `CommitCall` and `RevealCall` two seconds apart; not yet driven by a real executor bet or a Stream |
| Ports | 8742 | 8788 (local) and 8789 (public) |

Both serve the routes the web app calls (`POST /calls`, `POST /calls/:id/reveal`, `GET /calls`, `GET /leaderboard`),
so the app talks to either. Only `chain/` serves `/calls/:id/verify` and `/reveals/:sig`, which the proof page uses.

## Why it matters

The prize framing for Solana rewards a real program. A program that validates the reveal and the timing on chain is a
stronger answer to "why Solana" than memo records, and Victor's design is sound: the chain clock enforces "committed
before the event closed, revealed after", which memo records cannot.

**Measured on devnet, 2026-11-18 04:50 UTC:** program `8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK` is deployed (executable,
upgradeable loader, 173,013 bytes of program data holding about 0.88 SOL of rent, deployed at slot 523513183, upgrade
authority `5fE6B5sF…`). Three successful transactions touch it, within a minute of each other: one with no instruction log (04:42:24;
I did not decode it), then a `CommitCall` (04:43:18) and a `RevealCall` (04:43:20). The reveal two seconds after the commit means the test used an
expiry already in the past, so it proves the instruction path and the hash check on a real cluster, not yet an
end-to-end bet. The deployment cost about 0.9 SOL, which answers the earlier worry about whether the faucet could cover it.

What is still unproven on his side: a call driven by a real executor bet, the QuickNode Stream delivering its logs, and
the Rust tests (they need the Anchor toolchain, which this Mac does not have). What is still unproven on ours: any real
devnet record at all, because our wallet is unfunded.

## Recommendation

Both lanes keep their API. They differ only in what gets written to Solana and how it is read back.

**Make Victor's program the canonical record.** It is deployed, it has a real commit and reveal, and it gives the stronger
answer to "why Solana": the chain clock enforces "committed before the event closed, revealed after", which memo records
cannot. Ours stays as the fallback and as the source of the things only we have:

1. **Stop adding features to both.** `chain/` takes fixes only. `receipts-feed/` takes only what is needed to run a real
   bet through it and create the Stream.
2. **Prove it end to end this week.** One real executor bet (sandbox keys) → `POST /calls` on Victor's service → reveal after
   the event closes → the Stream delivers the log → `/leaderboard` shows the row. `npm run rehearse` already drives that
   shape against any service that exposes the contract's routes; point it at `receipts-feed` to find contract gaps first
   (it needs the executor and the routes, not a particular chain).
3. **Port the browser verifier** to the program: `web/src/lib/verify.ts` (150 lines) reads two memos and recomputes a hash;
   for the program it would read the `Call` account and the `CallRevealed` event and recompute
   `sha256("given:call:v1" ‖ borsh(details) ‖ salt)`. That keeps the "nothing here asks our server" claim.
4. **Keep the memo path documented as the fallback** and do not delete `chain/`. If the program path slips, the memo path
   already works with about 0.01 SOL.
5. Keep **one contract** in `docs/CONTRACTS.md`.

The decision is yours and Victor's; nothing here changes his branch. `Chain` in `chain/src/chain.ts` is the seam a
program-backed recorder would implement if we decide to keep one service instead of two.

## What I could not check

- Whether the program builds from source and its Rust tests pass (no Anchor or Solana CLI here; `cargo test` needs the built `.so`).
- That the deployed bytes match this branch's source. A deployed program and a source tree are not the same thing until
  someone runs a verifiable build; do that before the submission claims it.
- Whether the `5fE6B5sF…` upgrade authority is Victor's key, and whether we want the authority renounced or held by both of us
  before judging, since an upgradeable program can be changed by whoever holds it.
