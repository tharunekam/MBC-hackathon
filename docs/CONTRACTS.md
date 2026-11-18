# Interfaces between the web app, the executor and the chain service

*Last updated 2026-11-17. The TypeScript source of truth is `web/src/api/types.ts`; the mock in
`web/src/api/mock.ts` implements every endpoint below so each lane can build without waiting for the others.*

Three services, one browser app:

```
web (Vite/React)  ──►  executor  (exists)   places the two Gemini orders, owns the ledger
                  └─►  chain svc (planned)  commits / reveals calls on Solana, serves the leaderboard
QuickNode Stream  ──►  chain svc  POST /hooks/quicknode
```

In dev the web app proxies `/api` to the executor (`GIVEN_API`, default `127.0.0.1:8787`) and `/chain` to the
chain service. `?live` in the address bar (or `VITE_API_MODE=live`) switches from the mock to the real services.

## Executor (exists; see `executor/README.md` for behaviour)

| Endpoint | Used by | Notes |
|---|---|---|
| `GET /health` | status | |
| `GET /markets` | ladder chart | Polled every 4 s. Rungs carry `bid`/`ask`; pairs carry the offer quote |
| `GET /quote?event&condition&target&stake` | quote panel | Authoritative. The UI shows its own estimate (`web/src/lib/pricing.ts`, pinned to the executor README example by a test) until this answers |
| `POST /bets` | place bet | ~4 s on the sandbox. A refusal is HTTP 422 with `code` and `quote` |
| `GET /bets?user=` | My bets | Newest first |
| `POST /settle` | "Check results" | |
| `GET /flow` | Proof page | |

### Needed from the executor lane (not built)

| What | Why |
|---|---|
| `GET /reconcile` returning `ReconcileResponse` (`web/src/api/types.ts`) | The Proof page button. `node src/cli.ts reconcile` already does the work |
| Session or token per visitor, a stake cap, rate limits, a kill switch, and a non-localhost bind behind HTTPS | The hosted demo. Today the API trusts the `user` field and listens on 127.0.0.1 only |
| A bet-filled and bet-settled event (webhook or polling endpoint) | So the chain service can commit and settle calls |
| CORS origin for the hosted web app (`GIVEN_CORS_ORIGINS` exists) | |

## Chain service (planned)

| Endpoint | Body / result | Behaviour |
|---|---|---|
| `POST /calls` | `{ betId }` → `CallRecord` (state `committed`) | Hashes `(betId, symbols, entry price, timestamp, salt)`, writes the hash to Solana, returns the signature. App is fee payer; user never sees a wallet |
| `POST /calls/:id/reveal` | → `CallRecord` (state `revealed`) | Allowed only after the bet settled with the condition held. 409 `not_settled` / `void_call` otherwise (the web app shows these messages as written) |
| `GET /calls` | → `{ calls }` | The signed-in user's calls |
| `GET /leaderboard` | → `LeaderboardResponse` | Rebuilt from revealed calls. Ranked by total edge; calls where the condition failed (`void`) are excluded |
| `POST /hooks/quicknode` | QuickNode Stream payload | Verify `X-QN-Signature` (HMAC-SHA256 over nonce + timestamp + payload), return 2xx at once, dedupe by transaction signature, then process. A stream pauses after 3 failed deliveries by default |

**Edge** for a revealed call = `outcome − fairPriceAtEntry`, where outcome is 1 if the target hit and 0 if the
condition held and the target missed. A refunded call (condition failed) is `void` and not scored. Rank by the sum;
show the number of calls. No volume, no profit.

**Privacy.** The commit is a salted hash. Only a user-chosen reveal publishes the call, under a pseudonymous handle
(never a Gemini account id). See `CLAUDE.md` guardrails.
