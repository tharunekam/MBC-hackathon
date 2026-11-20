# Given web app

React + TypeScript + Vite. Hand-built SVG chart, no UI kit. Light and dark themes from one token layer
(`src/styles/tokens.css`).

```bash
cd web && npm install
npm run dev          # http://127.0.0.1:5273 on demo data (in-browser mock, no real orders)
npm test             # pricing maths, pinned to the executor README's worked example
npm run build        # typecheck + production bundle
```

## Demo data versus live

The app runs on an in-browser mock by default and labels itself "Demo data". To use the real executor:

```bash
cd executor && npm run start:demo        # sandbox, needs .env (see executor/README.md)
cd web && VITE_API_MODE=live npm run dev # or open the app with ?live in the address
```

`/api` is proxied to the executor (`GIVEN_API`, default `http://127.0.0.1:8741`) and `/chain` to the chain
service (`GIVEN_CHAIN_API`, default `http://127.0.0.1:8742`). From the repo root, `npm run dev` starts all three. Endpoint shapes are in `docs/CONTRACTS.md` and `src/api/types.ts`.

`?theme=light` or `?theme=dark` forces a theme and `?still` switches animations off (both handy for screenshots).
`?mock` runs any page on the in-browser demo data with no backend at all: three assets, every product, labelled "Demo data".

## Layout

| Path | What |
|---|---|
| `src/api/` | Types, live client, in-browser mock |
| `src/lib/pricing.ts` | Instant quote estimate while dragging; the executor's `/quote` replaces it |
| `src/components/LadderChart.tsx` | The probability ladder with two draggable, keyboard-operable markers |
| `src/pages/` | Landing, Build, My bets, Leaderboard, Proof |
