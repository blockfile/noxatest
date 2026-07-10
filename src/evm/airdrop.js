'use strict';

const config = require('../config');
const repo = require('../db/repository');
const { provider, wallet } = require('./provider');
const { erc20, getDecimals } = require('./erc20');

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// Airdrop a reward token to allocations [{owner, amountRaw}]. EVM has no batch
// transfer without a helper contract, so each recipient gets one transfer tx —
// pipelined through a SLIDING WINDOW: up to `airdropBatchSize` txs stay in
// flight, and the moment one confirms the next is submitted, so there is no
// per-batch barrier and the pipeline never idles.
//
// Submissions are kept to ONE RPC call each: gas limit is fixed
// (AIRDROP_GAS_LIMIT — ERC-20 transfers are predictable), fees are fetched
// once per run, and the nonce is tracked locally — no per-tx estimate/fee/
// nonce round trips, which is what used to pace the whole drop.
// Records every send (repo.addAirdrop). Returns { sent, failed }.
async function airdropToken({ rewardToken, allocations, cycleId }) {
  if (allocations.length === 0) return { sent: 0, failed: 0 };

  const decimals = config.dryRun ? 18 : await getDecimals(rewardToken);
  const uiOf = (raw) => Number(raw) / 10 ** decimals;
  const record = (a, signature, status) =>
    repo.addAirdrop({
      cycleId,
      rewardToken,
      recipient: a.owner,
      amountRaw: a.amountRaw,
      amountUi: uiOf(a.amountRaw),
      signature,
      status,
    });

  let sent = 0;
  let failed = 0;

  if (config.dryRun) {
    for (const a of allocations) {
      await record(a, fakeSig('airdrop'), 'ok');
      sent += 1;
    }
    return { sent, failed };
  }

  const token = erc20(rewardToken, wallet);
  const windowSize = Math.max(1, config.airdropBatchSize);
  const gasLimit = BigInt(config.airdropGasLimit);
  const total = allocations.length;
  const inFlight = new Set();
  let settled = 0;

  let feeData = await provider.getFeeData();
  let nonce = await provider.getTransactionCount(wallet.address, 'pending');
  const overrides = () => ({
    gasLimit,
    nonce,
    ...(feeData.maxFeePerGas != null
      ? { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0n }
      : { gasPrice: feeData.gasPrice }),
  });

  const logProgress = () => {
    if (settled % 50 === 0 || settled === total) {
      console.log(`[airdrop] ${settled}/${total} settled (sent=${sent} failed=${failed})`);
    }
  };

  for (const a of allocations) {
    // Free a slot before submitting the next transfer.
    while (inFlight.size >= windowSize) await Promise.race(inFlight);

    // Submit, retrying once. On failure resync fees AND the nonce from the
    // network — a timed-out send may or may not have consumed the nonce.
    let tx = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && !tx; attempt++) {
      try {
        tx = await token.transfer(a.owner, BigInt(a.amountRaw), overrides());
        nonce += 1;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 1500));
        feeData = await provider.getFeeData();
        nonce = await provider.getTransactionCount(wallet.address, 'pending');
      }
    }
    if (!tx) {
      console.error(`[airdrop] transfer to ${a.owner} failed to send: ${lastErr.message}`);
      await record(a, null, 'failed');
      failed += 1;
      settled += 1;
      logProgress();
      continue;
    }

    // Confirmation + DB record happen off the submission path; the loop moves
    // straight on to the next recipient while this one waits for its block.
    const p = (async () => {
      let status = 'ok';
      try {
        await tx.wait();
      } catch (err) {
        status = 'failed';
        console.error(`[airdrop] transfer to ${a.owner} reverted: ${err.message}`);
      }
      await record(a, tx.hash, status);
      if (status === 'ok') sent += 1;
      else failed += 1;
      settled += 1;
      logProgress();
    })().finally(() => inFlight.delete(p));
    inFlight.add(p);
  }

  await Promise.all(inFlight);
  return { sent, failed };
}

module.exports = { airdropToken };
