# grow. frontend

The site for the grow. launchpad on NEAR. It runs in one of two modes:

- **Live** (`VITE_API_URL` set): data comes from the grow. API and the contracts, and every action is a
  wallet transaction (NEAR Wallet Selector: MyNearWallet, Meteor, HOT, Intear) or an API call. See
  `src/lib/live.ts`. The backend is in `grow-backend` (contracts and the Cloudflare API).
- **Built-in market** (no `VITE_API_URL`): sample tokens and a simulated market in `src/lib/store.ts`, for
  working on the design without a chain. Do not put this mode online as a live product.

```bash
npm install
npm run dev        # built-in market on :5173
npm run dev:live   # live mode on :5174, reads .env.live
```

Live settings (`.env.live`, or the host's environment for a build):

| Variable | What |
|---|---|
| `VITE_API_URL` | the grow. API, e.g. `https://api.grow.example` |
| `VITE_NETWORK` | `testnet` or `mainnet` |
| `VITE_LAUNCHPAD` | the launchpad contract, e.g. `grow.testnet` |
| `VITE_RPC_URL` | optional NEAR RPC for read-only views |

`npm run build` writes the site to `dist/` (add `--mode live` for the live build). The host must serve
`index.html` for all paths, because the site uses normal URLs such as `/token/oak-1`.

To try live mode locally before the contracts are on testnet, run the API with `npm run dev` in
`grow-backend/api` and fill its local database with `npx vitest run -c vitest.seed.config.ts` (see that
script). Reading works fully this way; transactions need the contracts deployed.

## Where things are

- `src/lib/live.ts`: loading from the API into the app state, and every live action.
- `src/lib/near.ts`: wallet sign-in, NEP-413 message signing and transactions (loaded only when needed).
- `src/lib/chain.ts`: read-only contract views and NEAR units.
- `src/lib/store.ts`: app state; actions call `live.ts` in live mode, the built-in market otherwise.
- `src/lib/engine.ts`: curve, pool, fee and hold-reward maths, the same numbers as the contracts.
- `src/components/Tree.tsx`: the canvas tree. It takes only `growth` (0 to 1) and `twin`.

## Brand

`brand/` holds the logo (`grow-logo.svg`), the X banner (`grow-banner.png`, 1500x500, and `@2x`) and the intro
video with the files it was made from (`brand/intro`).
