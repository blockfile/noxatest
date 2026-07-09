'use strict';

// Burn stats for the frontend's "Accrued fees" card (GET /burn). NOXA burns
// the token-side LP fees automatically when fees are collected (see evm/noxa.js),
// so:
//   toBurn / toBurnUsd  — uncollected token-side LP fees (queued for the next
//                         collect; NOXA burns "most" of this, so it is a close
//                         upper-bound estimate, not an exact figure)
//   burned / burnedUsd  — the token balance sitting at the burn addresses
//                         (all burns to date, exact)
//   supplyPct           — burned as % of total supply
// USD values come from DexScreener (services/marketdata) and are null until
// the token is listed. Never throws for missing market data — fields go null.

const { formatUnits } = require('ethers');
const config = require('../config');
const { getUncollectedLpFees } = require('../evm/noxa');
const { getDecimals, readTokenBalance, getTokenSupplyRaw } = require('../evm/erc20');
const { getMarketData } = require('./marketdata');

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';

const usd = (amount, price) =>
  amount == null || price == null ? null : +(amount * price).toFixed(2);

async function getBurnInfo() {
  if (config.dryRun) {
    // No chain to read in DRY_RUN — stable simulated numbers so the card renders.
    return {
      toBurn: 125_000,
      toBurnUsd: 18.75,
      burned: 4_200_000,
      burnedUsd: 630,
      supplyPct: 0.42,
      simulated: true,
    };
  }
  if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS is required');

  const [fees, deadRaw, zeroRaw, supplyRaw, decimals, market] = await Promise.all([
    getUncollectedLpFees(),
    readTokenBalance(config.tokenAddress, DEAD),
    readTokenBalance(config.tokenAddress, ZERO).catch(() => 0n), // some tokens revert on the zero address
    getTokenSupplyRaw(config.tokenAddress),
    getDecimals(config.tokenAddress),
    getMarketData().catch(() => ({ priceUsd: null })),
  ]);

  const burnedRaw = deadRaw + zeroRaw;
  const toBurn = Number(formatUnits(fees.tokenRaw, decimals));
  const burned = Number(formatUnits(burnedRaw, decimals));
  // bigint math for the ratio (raw amounts overflow Number), 2-decimal percent
  const supplyPct = supplyRaw > 0n ? Number((burnedRaw * 10000n) / supplyRaw) / 100 : null;
  const price = market.priceUsd ?? null;

  return {
    toBurn,
    toBurnUsd: usd(toBurn, price),
    burned,
    burnedUsd: usd(burned, price),
    supplyPct,
    simulated: false,
  };
}

module.exports = { getBurnInfo };
