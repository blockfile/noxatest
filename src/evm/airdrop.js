'use strict';

const config = require('../config');
const repo = require('../db/repository');
const { wallet } = require('./provider');
const { erc20, getDecimals } = require('./erc20');

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// Airdrop a reward token to allocations [{owner, amountRaw}]. EVM has no batch
// transfer without a helper contract, so each recipient gets one transfer tx,
// sent sequentially (the wallet nonce serializes them anyway). Batches only
// group progress logging. Records every send (repo.addAirdrop).
// Returns { sent, failed }.
async function airdropToken({ rewardToken, allocations, cycleId }) {
  if (allocations.length === 0) return { sent: 0, failed: 0 };

  const decimals = config.dryRun ? 18 : await getDecimals(rewardToken);
  const uiOf = (raw) => Number(raw) / 10 ** decimals;
  const token = config.dryRun ? null : erc20(rewardToken, wallet);
  const batches = chunk(allocations, config.airdropBatchSize);

  let sent = 0;
  let failed = 0;
  for (const [i, batch] of batches.entries()) {
    for (const a of batch) {
      let signature = null;
      let status = 'ok';
      try {
        if (config.dryRun) {
          signature = fakeSig('airdrop');
        } else {
          const tx = await token.transfer(a.owner, BigInt(a.amountRaw));
          await tx.wait();
          signature = tx.hash;
        }
      } catch (err) {
        status = 'failed';
        console.error(`[airdrop] transfer to ${a.owner} failed: ${err.message}`);
      }
      await repo.addAirdrop({
        cycleId,
        rewardToken,
        recipient: a.owner,
        amountRaw: a.amountRaw,
        amountUi: uiOf(a.amountRaw),
        signature,
        status,
      });
      if (status === 'ok') sent += 1;
      else failed += 1;
    }
    if (batches.length > 1) console.log(`[airdrop] batch ${i + 1}/${batches.length} done (sent=${sent} failed=${failed})`);
  }
  return { sent, failed };
}

module.exports = { airdropToken };
