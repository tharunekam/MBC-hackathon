# given_receipts: the Solana program behind Given's calls

Anchor 1.2.2. Program id `8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK` (**not deployed on devnet yet**).

The chain service (`../chain`) writes every call to Solana as a Memo. With `GIVEN_PROGRAM_ID` set it calls this program
in the same transaction, so Solana itself checks the record:

| Instruction | What it does |
| --- | --- |
| `commit_call(hash, handle, at)` | Creates one account for the call: the hash, the pseudonymous handle, the service's time and Solana's own clock. Nothing about the trade. The same hash cannot be committed twice |
| `reveal_call(bet_id, event, condition, target, entry_price, fair_price, salt, outcome)` | Rebuilds the hashed text (`given1\|betId\|event\|condition\|target\|entry\|fair\|at\|salt`, the format in `chain/src/hash.ts`), hashes it and compares it with the commit. A changed field, a wrong salt or a second reveal fails the whole transaction, Memo included. Then it scores the call (outcome − fair price) and adds it to the handle's running total |

Accounts: `CallRecord` at `["call", authority, hash]` and `CallerStats` at `["caller", authority, handle]`. There is no
admin and no setup step. Records are filed under the key that signed them, only that key can reveal its own calls, and a
reader counts the authority it trusts. The outcome is attested by that authority: it is unknown at commit time, so no
hash can cover it.

No stake, payout or profit is ever passed to the program, and the leaderboard cannot rank by size.

## Build and test

Needs the Solana CLI (4.x) and Anchor 1.2.2.

```bash
anchor build      # writes target/deploy/given_receipts.so
cargo test        # 8 tests run the built program in LiteSVM
```

One test pins the hashed text to the same example as `chain/test/memo.test.ts`, so the program and the service cannot
drift apart unnoticed. After changing the program, refresh the bytes the service's encoder is tested against:

```bash
WRITE_PROGRAM_FIXTURE="$PWD/../chain/test/fixtures/program.json" cargo test
```

## Deploy

```bash
solana program deploy target/deploy/given_receipts.so --program-id target/deploy/given_receipts-keypair.json --url devnet
```

About 1.3 devnet SOL stays locked as the program's rent; have about 1.5 SOL on the deploying key (an upgrade later
needs the same amount again for a moment). The program id comes from `target/deploy/given_receipts-keypair.json`, which
is not in git. Deploying from another machine needs that file, or a new id: `anchor keys sync`, rebuild, refresh the
fixture, and use the new id in `GIVEN_PROGRAM_ID` and the READMEs.

Then set `GIVEN_PROGRAM_ID` for the chain service and run its smoke test (`../chain/README.md`, "With the program").
