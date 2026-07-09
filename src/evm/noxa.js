'use strict';

// NOXA Fun creator-fee claiming on Robinhood Chain.
//
// How it works on-chain (reverse-engineered from live transactions — the
// contracts are unverified but the flow is stable and observable):
//   - The Launch Locker (config.noxaLocker) holds each launched token's Uniswap
//     V3 LP position. Uncollected trading fees accrue inside that position.
//   - Anyone can call `collect(address token)` on the fee vault
//     (config.noxaFeeVault, selector 0x06ec16f8). The vault pulls the position's
//     fees through the locker and splits them; the creator share of the
//     WETH-side fees (observed 35%) is sent DIRECTLY to the token's deployer
//     address, regardless of who called. The token-side fees are mostly burned.
//   - So the operating wallet must be the deployer of TOKEN_ADDRESS; the claim
//     lands as WETH in this wallet.

const { Contract, Interface, formatEther } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const simvault = require('./simvault');

const FACTORY_ABI = [
  'function getLaunchedToken(address token) view returns (tuple(address token, address deployer, address pairedToken, address positionManager, uint256 positionId, uint256 dexId, uint256 launchConfigId, uint256 restrictionsEndBlock, uint256 supply, bool isToken0, uint24 poolFee, bool exists, uint256 initialBuyAmount))',
];

const VAULT_ABI = ['function collect(address token)'];

// Uniswap V3 NonfungiblePositionManager — static-calling collect() as the
// position owner returns the currently collectable (amount0, amount1) without
// sending a transaction. That is the standard way to read uncollected V3 fees.
const POSITION_MANAGER_ABI = [
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)',
];

const LAUNCHER_TOKEN_ABI = [
  'function liquidityPool() view returns (address)',
  'function poolFee() view returns (uint24)',
  'function pairToken() view returns (address)',
];

const MAX_UINT128 = (1n << 128n) - 1n;
const TRANSFER_IFACE = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const TRANSFER_TOPIC = TRANSFER_IFACE.getEvent('Transfer').topicHash;

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function factory() {
  return new Contract(config.noxaFactory, FACTORY_ABI, provider);
}

function launcherToken(address) {
  return new Contract(address, LAUNCHER_TOKEN_ABI, provider);
}

/** NOXA launch record for a token (throws if TOKEN_ADDRESS is unset). */
async function getLaunchedToken(token = config.tokenAddress) {
  if (!token) throw new Error('TOKEN_ADDRESS is required');
  return factory().getLaunchedToken(token);
}

/**
 * Read the uncollected LP fees for the launched token WITHOUT claiming, split
 * into the WETH side (creator payout source) and the token side (which NOXA
 * mostly burns when collect() runs). Read by static-calling the position
 * manager's collect() as the locker. Live mode only.
 * @returns {Promise<{wethRaw: bigint, tokenRaw: bigint}>} base units
 */
async function getUncollectedLpFees() {
  const launch = await getLaunchedToken();
  if (!launch.exists) throw new Error(`token ${config.tokenAddress} was not launched via the NOXA factory`);

  const pm = new Contract(launch.positionManager, POSITION_MANAGER_ABI, provider);
  const [amount0, amount1] = await pm.collect.staticCall(
    {
      tokenId: launch.positionId,
      recipient: config.noxaLocker,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    },
    { from: config.noxaLocker } // the locker owns the position NFT
  );
  // launch.isToken0 == our token is token0 → WETH (pair token) is the other side.
  return {
    wethRaw: launch.isToken0 ? amount1 : amount0,
    tokenRaw: launch.isToken0 ? amount0 : amount1,
  };
}

/**
 * Read the claimable creator-fee balance WITHOUT claiming (gates the trigger).
 * Estimate: creator share (CREATOR_FEE_SHARE_PCT) of the WETH-side uncollected
 * LP fees.
 * @returns {Promise<number>} claimable ETH (WETH)
 */
async function getClaimableEth() {
  if (config.dryRun) {
    return simvault.peek(); // pure read — accrual happens in simulateFeeAccrual()
  }
  const { wethRaw } = await getUncollectedLpFees();
  const creatorShare = (wethRaw * BigInt(Math.round(config.creatorFeeSharePct * 100))) / 10000n;
  return Number(formatEther(creatorShare));
}

/**
 * Advance the simulated creator-fee vault by one poll's worth of fees. DRY_RUN
 * only — in live mode fees accrue on-chain, so this is a no-op. Called once per
 * scheduler poll so the trigger can actually fire in testing.
 */
function simulateFeeAccrual() {
  if (config.dryRun) simvault.accrue(config.dryRunFeePerPoll);
}

/**
 * Claim creator fees: call collect(TOKEN_ADDRESS) on the NOXA fee vault. The
 * creator's WETH share is paid straight to the deployer wallet (this wallet).
 * The claimed amount is read exactly from the receipt's WETH Transfer logs.
 * @returns {Promise<{signature, ethClaimed, simulated, note?}>}
 */
async function claimCreatorFees() {
  if (config.dryRun) {
    const ethClaimed = +simvault.drain().toFixed(6);
    return { signature: fakeSig('claim'), ethClaimed, simulated: true };
  }

  const claimable = await getClaimableEth();
  if (!(claimable > 0)) {
    return { signature: null, ethClaimed: 0, simulated: false, note: 'nothing to claim' };
  }

  const vault = new Contract(config.noxaFeeVault, VAULT_ABI, wallet);
  const tx = await vault.collect(config.tokenAddress);
  const receipt = await tx.wait();
  console.log(`[tx] claim creator fees: ${tx.hash}`);

  // Sum the WETH actually transferred to our wallet in this tx — the exact payout.
  const me = wallet.address.toLowerCase();
  let wethReceived = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== config.weth.toLowerCase()) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    const parsed = TRANSFER_IFACE.parseLog({ topics: [...log.topics], data: log.data });
    if (parsed.args.to.toLowerCase() === me) wethReceived += parsed.args.value;
  }

  return { signature: tx.hash, ethClaimed: Number(formatEther(wethReceived)), simulated: false };
}

module.exports = {
  getLaunchedToken,
  launcherToken,
  getUncollectedLpFees,
  getClaimableEth,
  simulateFeeAccrual,
  claimCreatorFees,
  MAX_UINT128,
};
