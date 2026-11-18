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

1. **A call driven by a real executor bet.** Every real devnet record so far came from a synthetic bet in the smoke
   script. It needs Gemini sandbox keys.
2. **The QuickNode Stream** delivering real logs. The webhook route, authentication and ingestion are tested, including
   with real devnet signatures; the Stream itself does not exist yet.
3. **That the deployed program equals the source tree.** Someone should run a verifiable build before the submission
   claims it, and decide who holds the upgrade authority: an upgradeable program can be changed by whoever holds it.
4. **The program's Rust tests** need the Anchor toolchain (not installed here); I ran none of them.
