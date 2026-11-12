# grow.

**A token launchpad on NEAR where every token is a living tree, and AI gardeners run on NEAR AI.**

Built at **NEAR HACKATHON** (November 2026).

- Live demo (NEAR testnet): **https://grow-site-testnet.grow-api.workers.dev**
- Launchpad contract: [`growpad.testnet`](https://testnet.nearblocks.io/address/growpad.testnet)
- Public API: https://grow-api-testnet.grow-api.workers.dev/v1

## The problem

Memecoin launchpads reward the fastest bot, not the holder. Snipers buy in the first seconds, dump on
everyone who held, and the dev cashes out of a token whose "treasury" is just a wallet. Trading bots that
promise to manage money for you ask for your keys and your trust.

grow. changes the mechanics, not the marketing:

- **Holding pays.** Every trade sends part of its fee to the token's holders, in NEAR, from the token's own
  contract. The longer you hold, the bigger your share (×1 after 3 days, ×1.5 after 5, ×2 after 10).
- **Sniping does not.** For the first 60 seconds the fee starts at 50% and falls to normal; everything above
  normal goes to the platform, so a dev cannot snipe their own launch from other wallets.
- **Liquidity is locked forever.** When the bonding curve sells out (about 3,398.6 NEAR), the same call moves
  all of it into the token's own pool. There are no LP shares, so nobody can pull it.
- **A token's treasury is run by an AI treasurer under on-chain limits.** The dev's share of the fees goes to
  a treasury that a NEAR AI model spends on buybacks that burn coins, rewards for holders and the dev's pay
  (at most 20% a day). The contract enforces every limit; the model only proposes.
- **AI gardeners trade in the open.** Agents trade vaults whose limits live in the contract (daily limit,
  stop loss, end date, allowed tokens). A gardener that falls 30% from its peak is fired. You can copy one,
  create your own, or bring your own agent with an API key. Every AI decision is signed inside a TEE.
- **Every token is a tree.** The tree grows with the market cap, and two devs can cross their tokens into one
  tree on two trunks; holders swap at a time-weighted fair rate or sell during the exit window.

## How to try it (5 minutes, testnet)

1. Open **https://grow-site-testnet.grow-api.workers.dev**. Without a wallet you can browse everything:
   - **Tokens**: open any token. The tree, chart (price or market cap, 1s to 1D), holders, trades and the
     **Treasurer** tab (its AI decisions and actions) come from the chain through the API.
   - **Gardeners**: open **Sage**, an AI Trader. Its page lists AI decisions; each links to the signed proof.
   - **Share** on a token page draws a square card (the tree, market cap, holders, change) to download or post.
2. Connect a **testnet** wallet: Meteor Wallet (switch it to Testnet and create a free account). HOT Wallet
   connects mainnet accounts only, and the site refuses accounts from the wrong network.
   Get testnet NEAR from https://near-faucet.io. Sign the "Sign in to grow." message (NEP-413).
3. Buy any token for 0.1 NEAR, then sell part of it from **Profile** (25 / 50 / 100% or your own percent).
4. **Create** a token (about 2.7 testnet NEAR: 0.5 fee + 2.2 for its contract's storage). Watch the sprout
   come out of the soil; tick **Add an AI treasurer** to give it a treasury run by NEAR AI.
5. **Quick trading**: wallet menu → *Quick trading* → *Turn on*. One approval puts NEAR on a trading balance and
   adds a key that can only call `quick_buy` and `quick_sell`; after that, buys and sells need no wallet popup.
   Withdrawing always goes through the wallet.
6. **Verify an AI decision**: `GET /v1/ai` shows whether NEAR AI is enabled; `GET /v1/ai/decisions/{id}` returns
   the exact request, response, NEAR AI's signature and how to check it yourself.

On-chain, everything above can also be done with `near` CLI against `growpad.testnet`
(see [backend/README.md](backend/README.md#calling-the-contracts)).

## What is in this repository

| Folder | What |
|---|---|
| [`backend/contracts`](backend/contracts) | Rust (near-sdk 5): the **launchpad** (curve, pool, fees, referrals, buybacks, crossings, gardener vaults, AI treasurer, AI fees, trading balance) and the **token** (NEP-141/145/148 with on-chain hold rewards). |
| [`backend/contracts/e2e`](backend/contracts/e2e) | Sandbox tests with the real wasm on a local NEAR node (near-workspaces). |
| [`backend/api`](backend/api) | Cloudflare Worker (TypeScript): indexer of contract events, public API, WebSocket feed, NEP-413 sign-in, relayer job queue, the AI gardeners on NEAR AI Cloud, keeper. D1 + Durable Objects. |
| [`app`](app) | The site (React 19 + Vite): live mode against the API and contracts, or a built-in simulated market for design work. |

## NEAR technology used

- **Own contracts on NEAR** (testnet): launchpad `growpad.testnet`, one token contract per token as a sub-account
  (`<ticker>-<n>.growpad.testnet`), deployed by the launchpad from stored code.
- **NEAR AI Cloud** (private inference in TEEs): AI Trader and AI Treasurer decisions. For every decision the API
  stores the exact request and response, their SHA-256, NEAR AI's signature of
  `<model>:<request_hash>:<response_hash>`, recovers the signer (EIP-191) and checks it against a fresh
  attestation report bound to our nonce (`backend/api/src/agents/nearai.ts`).
- **Function-call access keys** as a security boundary: the relayer's key can only call
  `vault_trade, copy_trade, push_rewards, buyback, finalize_cross, check_vault, treasury_action, pay_ai`; the
  quick-trading key in your browser can only call `quick_buy, quick_sell` and cannot attach NEAR, so it can
  never withdraw.
- **NEP-141 / 145 / 148** tokens, **NEP-297** events, **NEP-413** sign-in, NEAR Wallet Selector (HOT, Meteor, Intear).
- Indexing from FastNEAR's transaction API and RPC.

## Tracks

- **Memecoins With Mechanics**: hold-time rewards paid in NEAR, the falling launch fee, the curve that locks its
  liquidity forever, buybacks that burn, crossings, and a treasury run by an AI under on-chain rules.
- **Privacy & Private AI**: gardener decisions come from NEAR AI Cloud inside a TEE, each with a verifiable signature.
- **AI Security & Defense**: agents trade only within limits the contract enforces (daily limit, stop loss, fire at
  −30%, allowed tokens, 20%/day dev pay), restricted function-call keys, per-decision AI fees with a 5-minute gap.
- **Autonomous Business**: each token can have an AI treasurer that manages its own treasury.

## What was built during the hackathon

Everything in this repository was written between **2026-11-06 and 2026-11-14**, inside the hackathon window
(announced 2026-10-19). The git history starts on 2026-11-07 (the site and the backend were separate repositories
until 2026-11-12 and were merged here with their full history).

### Pre-existing work and third-party code (disclosed)

- **Spark** ([`AlexLaevski/spark-launchpad`](https://github.com/AlexLaevski/spark-launchpad)), an earlier launchpad
  by the same team. Ideas and algorithms re-used from it, re-implemented here: virtual reserves and the atomic
  curve-to-pool move, the falling launch fee that goes to the platform, pull-only payouts, buyback limits,
  content-addressed images and metadata, checking images by file signature, normalising social links, comment
  limits by author and IP, risk labels, the idempotent indexer and the Durable Object "clock".
- **Libraries**: near-sdk, uint, near-workspaces, tokio (contracts); Cloudflare Workers, Wrangler, D1, Durable
  Objects, @noble/curves, @noble/hashes, Vitest (API); React, React Router, Vite, NEAR Wallet Selector,
  @near-js/* , buffer, Instrument Sans (site).
- **AI-assisted**: the code was written with Claude Code (Anthropic) under the team's direction.

## Status and honest limits

- **Testnet only and not audited.** Do not use with real money yet.
- AI gardeners decide with NEAR AI only when the API has a NEAR AI key with credits; otherwise they fall back to
  rules and the site marks those decisions as *Rules*. The TDX quote of the attestation report is stored by hash,
  not verified in the API (verify it with `dcap-qvl`, see docs.near.ai/cloud/verification).
- On testnet the token code is stored in the launchpad, so a launch costs ~2.7 NEAR; on mainnet it would use a NEAR
  global contract.
- Shade Agents were considered but are deprecated by NEAR (April 2026); the agents run in our API and are bounded
  by the contract instead.
- NEAR Intents (treasury diversification into stablecoins) is planned for mainnet; Intents has no testnet.

## Tests

- `backend/contracts`: 55 unit tests (`cargo test`, Linux) and 2 sandbox end-to-end tests: a launch, the buy that
  sells out the curve and opens the pool (3,398.57 NEAR), pool trading, rewards reaching the token, closing a gardener.
- `backend/api`: 27 tests (`npm test`): transaction signing byte-for-byte with near-api-js, NEP-413, event parsing,
  strategies, NEAR AI signature recovery and limits, an end-to-end test on a local D1.
- `app`: type check and both builds.

All of them run in GitHub Actions on every push ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Run it yourself

```bash
# the site with a simulated market (no chain needed)
cd app && npm install && npm run dev            # http://localhost:5173

# the site against the testnet API
cd app && npm run dev:live                      # http://localhost:5174

# API tests / contract tests (Linux)
cd backend/api && npm install && npm test
cd backend/contracts && cargo test
```

Deploying your own contracts and API: see [backend/README.md](backend/README.md).

## License

MIT, see [LICENSE](LICENSE).
