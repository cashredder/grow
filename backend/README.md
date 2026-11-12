# grow. backend

NEAR contracts (Rust) and the API (Cloudflare Worker). The project overview, how to try it and the hackathon
notes are in the [root README](../README.md). A longer Russian description is in [README.ru.md](README.ru.md).

Deployed on NEAR **testnet**:

| What | Where |
|---|---|
| Launchpad contract | `growpad.testnet` |
| Tokens | `<ticker>-<n>.growpad.testnet`, deployed by the launchpad |
| Relayer (signs gardener trades, function-call key only) | `growpad-relayer.testnet` |
| House funder (grow.'s own gardeners) | `growpad-house.testnet` |
| API | https://grow-api-testnet.grow-api.workers.dev |

## Contracts (`contracts/`)

- `common`: curve and fee maths shared by both contracts and mirrored in the site (`app/src/lib/engine.ts`).
  Virtual reserves 1,200 NEAR / 1.073B coins; the curve sells 793M coins (≈3,398.6 NEAR) and the last buy moves
  everything into the pool with the 207M coins set aside. Fees: dev's choice 0–5% on the curve (1% default),
  0.5% in the pool, 50% falling to normal over the first 60 s. Split: dev 30%, holders 10%, referrer 6%,
  platform the rest.
- `token`: NEP-141/145/148 with **on-chain hold rewards**. A holder's weight is balance × multiplier
  (0 before 3 days, ×1 from 3, ×1.5 from 5, ×2 from 10). Multipliers step up by themselves, without
  transactions; rewards are settled lazily per holder. `launchpad_sell` lets the launchpad sell for a holder only
  when that holder signed `quick_sell`.
- `launchpad`:
  - **Market**: `create_token`, `buy`, selling via `ft_transfer_call {"action":"sell"}`, `quote_buy`,
    `quote_sell`, `buyback` (once per block, capped), `push_rewards`, referrals (90 days), pull payouts
    (`claim_dev`, `claim_credits`).
  - **Crossings**: `propose_cross`, `accept_cross`, an exit window, `finalize_cross` at a time-weighted rate so
    the new token's supply is exactly 1B; holders convert with `ft_transfer_call {"action":"convert"}` and keep
    their hold date.
  - **Gardeners (vaults)**: House (grow.'s, fired at −30% from peak), User (strategy, API key or own agent; budget,
    daily limit, stop loss, end date, allowed tokens), Copy (repeats a leader's recent trade, once), Dev (the
    token's own gardener). `vault_trade`, `copy_trade`, `check_vault` (anyone can fire a vault past its limit),
    `close_vault` (owner only).
  - **AI treasurer**: `treasury_action(vault_id, buyback | rewards | pay_dev, amount)`: agent only, within the
    daily limit, dev pay at most 20% of the treasury a day; spending is not counted as a trading loss.
  - **AI fees**: `pay_ai(vault_id, decision)`: a fixed fee per AI decision (0.001 NEAR, cap 0.01) into the AI fund,
    at most once per 5 minutes per vault, never for House gardeners; `claim_ai_fund` (owner) pays NEAR AI credits.
  - **Trading balance**: `deposit_trade`, `quick_buy`, `quick_sell`, `withdraw_trade` (needs 1 yoctoNEAR, so only
    the wallet can withdraw).
  - Events: NEP-297, standard `grow`.

Tests: `cargo test` (55 unit tests, Linux: near-sdk's test VM needs C libraries) and `contracts/e2e`
(near-workspaces sandbox with the real wasm). Build: `cargo near build non-reproducible-wasm --no-abi` in
`token/` and `launchpad/`.

## Calling the contracts

With [near-cli-rs](https://github.com/near/near-cli-rs) and a testnet account (`YOU.testnet`):

```bash
# read
near contract call-function as-read-only growpad.testnet list_tokens json-args '{}' network-config testnet now
near contract call-function as-read-only growpad.testnet quote_buy json-args '{"token_id":"leaf-2","amount":"100000000000000000000000"}' network-config testnet now

# buy LEAF for 0.1 NEAR (+0.00125 NEAR registration on a first buy)
near contract call-function as-transaction growpad.testnet buy json-args '{"token_id":"leaf-2","min_out":"1"}' prepaid-gas '150.0 Tgas' attached-deposit '0.10125 NEAR' sign-as YOU.testnet network-config testnet sign-with-keychain send

# sell 1,000 LEAF (18 decimals)
near contract call-function as-transaction leaf-2.growpad.testnet ft_transfer_call json-args '{"receiver_id":"growpad.testnet","amount":"1000000000000000000000","msg":"{\"action\":\"sell\",\"min_out\":\"1\"}"}' prepaid-gas '200.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as YOU.testnet network-config testnet sign-with-keychain send
```

## API (`api/`)

A Cloudflare Worker with D1 and two Durable Objects. The **clock** runs every 2 s: it indexes new contract events
(per-account reads from FastNEAR's transaction API, applied idempotently in one D1 batch), runs the gardeners every
~10 s and the keeper every minute (reward pushes, buybacks, crossings, firing), and sends the relayer's queued
transactions one at a time. The **hub** is the WebSocket live feed.

Open data (`/v1`, any origin): `stats`, `tokens` (tabs, search), `tokens/{id}` (with risk labels),
`tokens/{id}/trades|holders|comments|candles|quote`, `feed`, `leaderboard`, `gardeners`, `gardeners/{id}` (with
AI decisions), `users/{account}`, `ai`, `ai/decisions/{id}` (request, response, signature, how to verify),
`stream` (WebSocket).

Signed-in (NEP-413 `GET /auth/nonce` → wallet signs → `POST /auth/login`): profile, comments, favourites,
notifications, portfolio, invite code, API keys, own gardeners, picture and metadata upload.

Agents (`Authorization: Bearer gk_…`): `GET /v1/agent/vaults`, `GET /v1/agent/market`, `POST /v1/agent/trade`,
`GET /v1/agent/jobs/{id}`.

**AI gardeners** (`src/agents/ai.ts`, `src/agents/nearai.ts`): the AI Trader (strategy `ai`) and the AI Treasurer
(a token's Dev vault) ask a NEAR AI Cloud model (`AI_MODEL`, default `z-ai/glm-5.3-flash`). The model's answer is
checked against the vault (allowed tokens, at most 20% of the vault per buy, a quarter of the treasury per run) and
the contract checks the rest. Each decision is stored with its request, response, hashes and NEAR AI's signature;
the signer is recovered (EIP-191) and must be named in a fresh attestation report bound to our nonce. Without a key
or when the model fails, rules decide and no fee is charged; an unchanged market is not asked again.

Tests: `npm test` (27). Local run: `npm run dev`; fill a local database with
`npx vitest run -c vitest.seed.config.ts` (made-up activity, never against a remote database).

### Deploying your own

1. Build both contracts; deploy the launchpad with `new {owner, treasury, relayer}`, upload the token code with
   `set_token_code` (raw wasm as input), adjust `set_config`, `set_house_funder`.
2. Give the relayer account a function-call key for the launchpad limited to
   `vault_trade, copy_trade, push_rewards, buyback, finalize_cross, check_vault, treasury_action, pay_ai`.
3. `wrangler d1 create`, apply `api/schema.sql`, fill `[env.<name>]` in `api/wrangler.toml`, `wrangler deploy`.
4. Secrets: `RELAYER_KEY` (that function-call key), `SESSION_SALT`, `ADMIN_TOKEN`, optionally `NEARAI_KEY` and
   `HOUSE_FUNDER_KEY` (`wrangler secret put <NAME> --env <name>`).
