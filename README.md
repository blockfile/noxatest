# noxa-rewards

Port of the BABYCUPSY reward system (Solana / pump.fun) to **NOXA Fun on Robinhood Chain** (EVM).

The flow is identical to the original:

1. **Claim** — the scheduler checks every 5 minutes and claims once the accrued creator fees are worth **`CLAIM_THRESHOLD_USD`** (default $50; set 0 to claim whatever accrued on every tick). `POST /api/run` bypasses the threshold.
2. **Buy** — spend 80% of the claim buying the reward token on Uniswap V3.
3. **Airdrop** — send the bought tokens to your token's holders, pro-rata by holdings (optional per-wallet cap, wallet clustering). The remaining 20% is unwrapped to native ETH so the wallet keeps paying gas.

Everything runs in `DRY_RUN=true` by default — all on-chain calls are simulated and no funds are ever touched until you flip it off.

## How the NOXA fee claim works (verified on-chain)

NOXA Fun deploys each token straight into a Uniswap V3 pool (1% fee tier) and parks the LP position in its **Launch Locker**. Trading fees accrue in that position. The claim path (reverse-engineered from live Robinhood Chain transactions — the contracts are unverified on Blockscout):

- Anyone calls `collect(address token)` (selector `0x06ec16f8`) on the **fee vault** `0x9eFdC1A8e6E94f16A228e44f3025E1f346EE0417`.
- The vault pulls the position's fees through the locker and splits them. The **creator share (~35% of the WETH side) is sent directly to the token's deployer address**, no matter who called. Most of the token-side fees are burned.
- Therefore the operating wallet **must be the wallet that deployed the token on NOXA Fun**. The claim lands as WETH.

Claimable balance is estimated without claiming by static-calling the Uniswap position manager's `collect()` as the locker (the standard way to read uncollected V3 fees), then taking the creator share.

### Robinhood Chain reference (defaults in `.env.example`)

| What | Value |
|---|---|
| Chain ID | 4663 |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer (Blockscout) | `https://robinhoodchain.blockscout.com` |
| NOXA Launch Factory | `0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB` |
| NOXA Launch Locker | `0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85` |
| NOXA Fee Vault (`collect`) | `0x9eFdC1A8e6E94f16A228e44f3025E1f346EE0417` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Uniswap SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |

Other NOXA chains (Monad, MegaETH, Merlin, …) use the same architecture — point the contract addresses + RPC at that chain via env vars.

## What changed vs. the Solana original

| Solana original | This port |
|---|---|
| pump.fun `collectCoinCreatorFee` | NOXA fee vault `collect(token)` → WETH to deployer |
| PumpSwap / bonding curve / Jupiter buys | Uniswap V3 `exactInputSingle` (WETH → reward token) |
| `getProgramAccounts` holder scan | Blockscout `/api/v2/tokens/{addr}/holders` (paginated) |
| SPL batched transfers (8/tx) | One ERC-20 `transfer` tx per recipient (sequential) |
| WSOL unwrap after claim | WETH remainder unwrapped after the buy (gas top-up) |
| Streamflow LP locking scripts | Dropped (NOXA locks the LP itself — "the LP never moves") |

Storage (MongoDB), the Express API (`/activity`, `/stats`, `/summary`, `/airdrops`, `/countdown`, `/api/*`, SSE stream), the scheduler, and the weighted-distribution math are unchanged apart from SOL→ETH field renames (`eth_claimed`, `amountEth`, `ethPriceUsd`, …).

## Quick start

```bash
npm install
cp .env.example .env       # defaults are safe: DRY_RUN=true, ephemeral wallet
npm start                  # needs a local MongoDB (or set MONGODB_URI)
npm test                   # unit tests (in-memory MongoDB)
```

Going live:

1. Launch your token on <https://fun.noxa.fi/robinhood> **from the operating wallet**.
2. Fill `.env`: `WALLET_PRIVATE_KEY` (the deployer key), `TOKEN_ADDRESS`, `REWARD_TOKEN_ADDRESS`, `MONGODB_URI`, and set `DRY_RUN=false`.
3. `node scripts/check.js` — read-only preflight (verifies the deployer matches, reads claimable fees, holder count).
4. `node scripts/claim.js --confirm` / `node scripts/buy.js 0.001 --confirm` — test each leg with dust amounts.
5. `node scripts/run-once.js --confirm` — one full cycle, then `npm start` for the 5-minute loop.

## Scripts

| Script | What it does |
|---|---|
| `scripts/check.js` | Read-only preflight: config, RPC/chain, balances, NOXA launch record, claimable fees, holder count |
| `scripts/claim.js` | Claim creator fees (`--confirm` to send) |
| `scripts/buy.js <eth>` | Buy the reward token with N ETH (`--confirm` to send) |
| `scripts/run-once.js` | One full claim → buy → airdrop cycle (`--confirm` to send) |
