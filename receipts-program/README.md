# given_receipts: the Solana program behind Given's calls

Anchor 1.2.2. Program id [`8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK`](https://explorer.solana.com/address/8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK?cluster=devnet), deployed on Solana devnet on 2026-11-17.
First call recorded through it: [commit](https://explorer.solana.com/tx/2DFD8UjXaPofQh82UXFpwsUm47ArcVkteQAxFSeyjp76CRFtr8tNK7JvZD8Th8NepmctkYqnDypHdKRavEJxQnQL?cluster=devnet), [reveal](https://explorer.solana.com/tx/45iRt5TRfiiyBTY8PDJNp4gbscBsTSfmsW4sZkqPSbKLPgAiGcFTLTKX9hvEgA8hYCP6oFx1iGsBL6LoBJ3DT9xU?cluster=devnet).

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

Already done for devnet; the command above is how. About 0.9 devnet SOL stays locked as the program's rent, and an
upgrade needs about the same again for a moment. The upgrade authority is the key that deployed it
(`5fE6B5sFJQURtKiJJepzqvHshJZR9SkKSMgeKB3oaGsN`), so only the machine holding that key can upgrade it. The program id
comes from `target/deploy/given_receipts-keypair.json`, which is not in git: a fresh deployment from another machine
needs a new id (`anchor keys sync`, rebuild, refresh the fixture, and use the new id in `GIVEN_PROGRAM_ID` and the
READMEs).

Then set `GIVEN_PROGRAM_ID` for the chain service and run its smoke test (`../chain/README.md`, "With the program").

## Is the deployed program this source?

```bash
anchor build && scripts/verify-deployed.sh     # downloads the deployed program and compares it byte for byte
```

Checked 2026-11-18: **match**. The program on devnet is `5462d1fc620dd1a1b83cc32e0e7f7be40f66d641a388121ae9764d4d0a444ac7`
(SHA-256, 172,968 bytes, deployed in slot 523513183), the same file this folder builds on the machine that deployed it.
The program source has not changed since that deployment (commit `e220756`). A second copy of the committed source,
checked out into an empty folder and built with `anchor build --ignore-keys`, produced the same bytes, so the build
repeats on that machine. Use `anchor build`: a bare `cargo build-sbf` targets a different SBPF version by default and
gives a different, larger file.

What that does and does not show:

- It was built with anchor-cli 1.2.2, solana-cli 4.1.2 (cargo-build-sbf 4.1.0, platform-tools v1.54) and Rust 1.89.0 on
  macOS (arm64), with the `Cargo.lock` in this folder.
- It is **not** a Docker-reproducible ("verified") build: the build machine has no Docker. A different machine or
  toolchain may produce different bytes from the same source, so a mismatch elsewhere is not by itself a sign of
  tampering. Rebuild with the versions above before drawing a conclusion.
- The program's interface (its Anchor IDL) is published on chain, in the metadata account
  `CwzE3vPRsWMH8T8oJHZjnwM2vwxVEZsXkqXe1ioMSzHz`, so tools that read on-chain IDLs can decode its instructions,
  accounts and errors: `anchor idl fetch 8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK --provider.cluster devnet`.

## Who can change it

The program is upgradeable, and the upgrade authority is the deploy key (`5fE6B5sF…`), held on one machine. Until that
changes, whoever holds that key can replace the program, which is the honest limit on "the chain checks it". The plan is
to make it final once features are frozen (Thursday 2026-11-19, 15:00 CST), after the hosted demo has run through it:

```bash
solana program set-upgrade-authority 8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK --final --url devnet
```

That cannot be undone. If a fault turned up afterwards, the chain service would go back to Memo records alone by
unsetting `GIVEN_PROGRAM_ID`; a fixed program would need a new id.
