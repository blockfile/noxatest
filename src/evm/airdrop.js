'use strict';

const { NonceManager } = require('ethers');
const config = require('../config');
const repo = require('../db/repository');
const { wallet } = require('./provider');
const { erc20, getDecimals } = require('./erc20');

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// Airdrop a reward token to allocations [{owner, amountRaw}]. EVM has no batch
// transfer without a helper contract, so each recipient gets one transfer tx —
// pipelined through a SLIDING WINDOW: up to `airdropBatchSize` txs stay in
// flight (NonceManager assigns nonces locally), and the moment one confirms
// the next is submitted, so there is no per-batch barrier and the pipeline
// never idles. Records every send (repo.addAirdrop). Returns { sent, failed }.
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

  const signer = new NonceManager(wallet);
  const token = erc20(rewardToken, signer);
  const windowSize = Math.max(1, config.airdropBatchSize);
  const total = allocations.length;
  const inFlight = new Set();
  let settled = 0;

  const logProgress = () => {
    if (settled % 50 === 0 || settled === total) {
      console.log(`[airdrop] ${settled}/${total} settled (sent=${sent} failed=${failed})`);
    }
  };

  for (const a of allocations) {
    // Free a slot before submitting the next transfer.
    while (inFlight.size >= windowSize) await Promise.race(inFlight);

    // Submit, retrying once — RPC rate limits are transient.
    let tx = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && !tx; attempt++) {
      try {
        tx = await token.transfer(a.owner, BigInt(a.amountRaw));
      } catch (err) {
        lastErr = err;
        signer.reset(); // resync the local nonce after a failed submission
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
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
