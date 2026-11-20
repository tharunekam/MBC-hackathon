# Two chain lanes: resolved

*Written 2026-11-17 evening, rewritten 2026-11-18 after Victor's follow-up. Kept as the record of why there is one chain
service and what is left.*

## What happened

Victor and I built the chain lane in parallel to the same contract: his as an Anchor program plus a second service
(`receipts-feed/`), mine as Memo records in `chain/`. Within an hour of the overlap being noticed, Victor resolved it
himself (`e220756`): he merged my branch, **deleted `receipts-feed/`**, and made his program verify `chain/`'s own hash
format (`given1|betId|event|condition|target|entry|fair|at|salt`). The program is now an **opt-in on-chain check** inside
the one service: with `GIVEN_PROGRAM_ID` set, every record's transaction carries the Memo plus the program instruction;
unset, behaviour is unchanged.

So the answer to "which one wins" is: neither, they compose. The service and its API, the Memo format, the browser
verifier and the Stream filter are `chain/`; the on-chain checks (the hash must reproduce, no repeat reveal, scoring) are
`receipts-program/`.

## Where the merge needed care

Both of us had changed `SolanaChain.sendMemo` in `chain/src/chain.ts`. Resolved by keeping both: his
`programId` argument and program instructions, my polled confirmation (no WebSocket), typed `ChainError`s and retry on an
expired blockhash. `SolanaChain(rpcUrl, keypair, programId?, options?)`; his callers are unchanged.

## What is verified on real devnet (2026-11-18)

- Victor's deployed program `8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK` (about 0.88 SOL of rent, upgrade authority
  `5fE6B5sF…`) and his first call through it.
- **Our authority key `2QfQ…HeHz`, Memo only and through the program**: `npm run smoke` passed both ways. Through the
  program a reveal with a changed fair price and a second reveal were both refused on chain. The browser verifier then
  passed all seven checks, program row included, on Victor's first real call, ingested through the real webhook route.
- A browser can call the public devnet RPC (CORS allows it), so the proof page works live.

## Still open

1. ~~A call driven by a real executor bet.~~ **Done 2026-11-18** on Victor's laptop: real sandbox bets `92e80990` and
   `557869d4` were committed on devnet through the program by the chain service (authority `9GVn…hM4X`), commit
   signatures `5P8xNpVv…` and `4FkLnjHR…`. See the build status in `docs/PLAN.md`.
2. **The QuickNode Stream** delivering real logs. The webhook route, authentication and ingestion are tested, including
   with real devnet signatures; the Stream exists but is kept paused and has not delivered a real record yet.
3. ~~That the deployed program equals the source tree.~~ **Checked 2026-11-18** on the machine that deployed it: the
   program downloaded from devnet is byte for byte the file the committed source builds there (SHA-256 `5462d1fc…4ac7`;
   `receipts-program/scripts/verify-deployed.sh` repeats the check), and a clean checkout built there gives the same
   bytes. It is not a Docker-reproducible build, so another
   machine may not get the same bytes; `receipts-program/README.md` lists the toolchain. The program's interface is
   published on chain. **Still to decide: the upgrade authority.** It is the deploy key on Victor's machine; the plan
   is to make the program final after the feature freeze (command and consequences in that README).
4. ~~The program's Rust tests.~~ **Run 2026-11-17 and again 2026-11-18** on the machine with the toolchain: 8 pass
   against the built program. They are not in CI, which has no Solana toolchain.
