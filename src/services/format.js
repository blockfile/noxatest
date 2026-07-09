'use strict';

const { toUsd } = require('../evm/price');
const config = require('../config');

const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL || 'TOKEN';

// Map a stored step to the activity-row shape the dashboard renders. The cycle
// emits these step types: claim, buy, airdrop (+ error). `leg` tags which reward
// leg a step belongs to.
function toActivityRow(s, price) {
  const d = s.detail || {};
  let type;
  let amountEth = null;
  let status = 'Completed';

  switch (s.name) {
    case 'claim':
      type = 'Auto Claim';
      amountEth = d.ethClaimed ?? null;
      status = 'Claimed';
      break;
    case 'buy':
      type = 'Buy';
      amountEth = d.ethSpent ?? null;
      break;
    case 'airdrop':
      type = 'Airdrop';
      status = d.failed ? 'Failed' : 'Completed';
      break;
    default:
      type = s.name;
  }
  if (s.status === 'failed') status = 'Failed';

  return {
    id: s.id ?? null,
    cycleId: s.cycle_id,
    type,
    rawType: s.name,
    amountEth,
    usdValue: toUsd(amountEth, price),
    leg: d.leg ?? null,
    status,
    txHash: s.signature ?? null,
    at: s.created_at,
  };
}

// ── Public (frontend-facing) shapes — match the frontend's API_SPEC exactly ──
// These power GET /activity and GET /stats, consumed by the frontend site.

// rawType (stored step name) -> the frontend's lowercase activity enum.
const PUBLIC_TYPE = {
  claim: 'claim',
  buy: 'buy',
  airdrop: 'airdrop',
};

// Map a stored step to the exact ActivityRow shape the frontend table renders.
// Caller passes steps newest-first (repo.getAllSteps already sorts desc).
function toPublicActivityRow(s, price) {
  const d = s.detail || {};

  let amountEth = null;
  let status = 'completed';
  switch (s.name) {
    case 'claim':
      amountEth = d.ethClaimed ?? null;
      status = 'claimed';
      break;
    case 'buy':
      amountEth = d.ethSpent ?? null;
      break;
    case 'airdrop':
      status = d.failed ? 'failed' : 'completed';
      break;
    default:
      break;
  }
  if (s.status === 'failed') status = 'failed';

  return {
    id: s.id != null ? String(s.id) : s.signature ?? null,
    type: PUBLIC_TYPE[s.name] ?? s.name,
    amountEth,
    // usdtValue MUST be a number — the frontend table calls .toLocaleString()
    // on it with no null guard.
    usdtValue: toUsd(amountEth, price) ?? 0,
    leg: d.leg ?? null,
    status,
    txHash: s.signature ?? null,
    timestamp: Date.parse(s.created_at) || null, // ISO -> epoch ms
  };
}

// Map the backend aggregates to the frontend's flat /stats object. tokenInLp and
// marketCap have no backend source until the token is listed -> null.
function toPublicStats({ stats, unclaimedEth, operatingWallet, market = {} }) {
  return {
    tokenInLp: market.tokenInLp ?? null, // tokens in the LP (DexScreener); null until listed
    marketCap: market.marketCap ?? null, // USD market cap (DexScreener); null until listed
    unclaimedFeesEth: unclaimedEth == null ? null : +unclaimedEth.toFixed(9),
    totalCreatorFeesClaimed: stats.total_eth_claimed,
    // The signer that performs claim/buy/airdrop (whose activity the table lists).
    operatingWallet: operatingWallet ?? null,
  };
}

// The unclaimed-fees card payload (used by /api/unclaimed and the SSE stream).
// Fees accumulate until they are worth CLAIM_THRESHOLD_USD, then a cycle claims
// them — claimThresholdUsd lets the frontend render a "$32 / $50" progress bar
// (0 = no threshold: every tick claims whatever accrued).
function buildUnclaimedPayload(eth, price) {
  return {
    unclaimedEth: eth == null ? null : +eth.toFixed(9),
    unclaimedUsd: toUsd(eth, price),
    ethPriceUsd: price,
    claimThresholdUsd: config.claimThresholdUsd,
  };
}

// Headline numbers for the frontend: reward token distributed to holders.
// byToken is keyed by reward_token (repo.getAirdropTotals): { sends, totalUi, holders }.
function toPublicSummary({ stats, byToken, eligibleHolders = 0, totalHolders = null, price, rewardTokenAddress, marketCapUsd = null }) {
  const z = { totalUi: 0, holders: 0, sends: 0 };
  const reward = byToken[rewardTokenAddress] || z;
  const claimedEth = stats.total_eth_claimed || 0;
  return {
    creatorFeesClaimedEth: claimedEth,
    creatorFeesClaimedUsd: +(claimedEth * (price || 0)).toFixed(2),
    marketCapUsd: marketCapUsd ?? null,
    // reward token sent to holders
    rewardDistributed: reward.totalUi,
    // currently-eligible holders (latest cycle's snapshot) — NOT the all-time recipient union
    holders: eligibleHolders,
    // ALL wallets with any balance (explorer-style), from the same snapshot;
    // null until a cycle has recorded it
    totalHolders,
    distributions: reward.sends,
  };
}

module.exports = {
  toActivityRow,
  toPublicActivityRow,
  toPublicStats,
  toPublicSummary,
  buildUnclaimedPayload,
  TOKEN_SYMBOL,
};
