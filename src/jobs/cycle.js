'use strict';

const config = require('../config');
const repo = require('../db/repository');
const { claimCreatorFees } = require('../evm/noxa');
const { buyToken } = require('../evm/uniswap');
const { snapshotEligibleHolders } = require('../evm/holders');
const { computeWeightedAllocations } = require('../services/distribution');
const { airdropToken } = require('../evm/airdrop');
const { getDecimals, getTokenSupplyRaw, getWethBalanceEth, unwrapAllWeth } = require('../evm/erc20');
const { buildExcludeSet } = require('../evm/exclude');

// Snapshot the eligible holders for a leg (decimals → min-hold → exclusions).
// Split out so runCycle can preflight it BEFORE claiming fees.
async function snapshotLegHolders({ holderToken, minHold }) {
  const decimals = config.dryRun ? 18 : await getDecimals(holderToken);
  const minHoldRaw = BigInt(Math.trunc(minHold)) * 10n ** BigInt(decimals);
  const exclude = await buildExcludeSet(holderToken);
  return snapshotEligibleHolders({ token: holderToken, minHoldRaw, exclude });
}

// Run one reward leg. Snapshot holders of `holderToken` (>= minHold) ONCE (or use
// the caller's preflighted `snapshot`), then for each { token, ethAmount } in
// `buys`: buy it and airdrop it weighted by holdings — each wallet's weight capped
// at `capPct`% of the holder token's supply, clusters grouped as one wallet.
// Distribution is based ONLY on the amount bought THIS cycle
// (buy.tokensBoughtRaw), never the wallet's existing balance.
async function runRewardLeg(cycleId, { name, holderToken, minHold, capPct = null, clusters = [], buys, snapshot = null }) {
  const log = (m) => console.log(`[cycle ${cycleId}] [Leg ${name}] ${m}`);

  const { holders, totalHolders } = snapshot || (await snapshotLegHolders({ holderToken, minHold }));
  log(`${holders.length} eligible holders (>= ${minHold}) of ${totalHolders} total`);

  const supplyRaw = capPct == null ? null : await getTokenSupplyRaw(holderToken);

  const results = [];
  for (const { token: buyTokenAddress, ethAmount } of buys) {
    const buy = await buyToken(buyTokenAddress, ethAmount);
    await repo.addStep({ cycleId, name: 'buy', status: 'ok', signature: buy.signature, detail: { leg: name, buyToken: buyTokenAddress, ethSpent: ethAmount, tokensBought: buy.tokensBought } });
    log(`bought ${buy.tokensBought} of ${buyTokenAddress} with ${ethAmount} ETH`);

    const distributeRaw = BigInt(buy.tokensBoughtRaw || '0');
    const allocations = computeWeightedAllocations(holders, distributeRaw.toString(), { capPct, supplyRaw, clusters });
    const result = await airdropToken({ rewardToken: buyTokenAddress, allocations, cycleId });
    await repo.addStep({ cycleId, name: 'airdrop', status: result.failed ? 'failed' : 'ok', detail: { leg: name, rewardToken: buyTokenAddress, recipients: allocations.length, sent: result.sent, failed: result.failed } });
    log(`airdrop ${buyTokenAddress} sent=${result.sent} failed=${result.failed}`);
    results.push({ buyToken: buyTokenAddress, tokensBought: buy.tokensBought, sent: result.sent, failed: result.failed });
  }
  return { results, eligibleHolders: holders.length, totalHolders };
}

/**
 * One reward cycle (fired by the scheduler on a fixed timer, default every
 * 5 minutes — skipped upstream when nothing is claimable):
 *   claim TOKEN creator fees from the NOXA fee vault (paid in WETH, once)
 *   buy REWARD_TOKEN (80%) -> airdrop to TOKEN holders pro-rata by holdings
 *     (optional per-wallet cap via REWARD_CAP_PCT; 0 = no cap)
 *   the remaining 20% is unwrapped to native ETH and stays in the operating
 *   wallet to cover gas
 */
async function runCycle() {
  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (m) => console.log(`[cycle ${id}] ${m}`);
  try {
    if (!config.tokenAddress || !config.rewardTokenAddress) {
      throw new Error('TOKEN_ADDRESS and REWARD_TOKEN_ADDRESS are required');
    }

    // Preflight the holder snapshot BEFORE claiming: it is the one fragile
    // external read (explorer / RPC), and fees claimed without a holder list
    // would be stranded in the wallet. Skipping is free — unclaimed fees keep
    // accruing in the vault until the next poll.
    let snapshot;
    try {
      snapshot = await snapshotLegHolders({ holderToken: config.tokenAddress, minHold: config.minHold });
    } catch (err) {
      const note = `holder snapshot unavailable: ${err.message}`;
      log(`SKIPPED: ${note}`);
      await repo.finishCycle(id, { status: 'skipped', note });
      return repo.getCycleWithSteps(id);
    }
    if (snapshot.holders.length === 0) {
      log('SKIPPED: no eligible holders');
      await repo.finishCycle(id, { status: 'skipped', eligible_holders: 0, total_holders: snapshot.totalHolders, note: 'no eligible holders' });
      return repo.getCycleWithSteps(id);
    }

    const claim = await claimCreatorFees();
    await repo.addStep({ cycleId: id, name: 'claim', status: 'ok', signature: claim.signature, detail: { ethClaimed: claim.ethClaimed } });
    log(`claimed ${claim.ethClaimed} ETH`);

    // Distribute the wallet's WHOLE WETH balance — this claim plus any residue
    // stranded by previously failed cycles. Healthy cycles end with ~0 WETH
    // (the remainder is unwrapped to native ETH), so normally these are equal.
    // Skip only when BOTH are empty, so a manual run can flush residue even
    // when nothing new was claimable.
    const distributableEth = config.dryRun
      ? claim.ethClaimed
      : await getWethBalanceEth().catch(() => claim.ethClaimed);
    if (!(distributableEth > 0)) {
      await repo.finishCycle(id, { status: 'skipped', eth_claimed: claim.ethClaimed, note: 'nothing claimed' });
      return repo.getCycleWithSteps(id);
    }
    if (distributableEth > claim.ethClaimed) {
      log(`including ${+(distributableEth - claim.ethClaimed).toFixed(9)} WETH residue from prior cycles`);
    }
    const eth = (pct) => +(distributableEth * (pct / 100)).toFixed(9);

    // Buy the reward token and airdrop it to holders pro-rata (no cap unless
    // REWARD_CAP_PCT > 0).
    const legA = await runRewardLeg(id, {
      name: 'A',
      holderToken: config.tokenAddress,
      minHold: config.minHold,
      capPct: config.rewardCapPct > 0 ? config.rewardCapPct : null,
      clusters: config.clusters,
      buys: [{ token: config.rewardTokenAddress, ethAmount: eth(config.rewardBuyPct) }],
      snapshot,
    });

    // Unwrap the WETH remainder (the ~20% not spent on the buy) into native ETH
    // so the wallet can keep paying gas. Best-effort — never fails the cycle.
    await unwrapAllWeth().catch((err) => log(`unwrap remainder failed (non-fatal): ${err.message}`));

    const sent = legA.results.reduce((s, r) => s + r.sent, 0);
    await repo.finishCycle(id, {
      status: 'complete',
      mode: 'airdrop',
      eth_claimed: claim.ethClaimed,
      eligible_holders: legA.eligibleHolders,
      total_holders: legA.totalHolders,
      note: `sent ${sent}`,
    });
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    console.log(`[cycle ${id}] FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = { runCycle, runRewardLeg, snapshotLegHolders };
