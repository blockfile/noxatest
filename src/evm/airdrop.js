'use strict';

const { NonceManager } = require('ethers');
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
// transfer without a helper contract, so each recipient gets one transfer tx —
// but the txs of a batch are PIPELINED: submitted back-to-back with locally
// managed nonces, then confirmed together, so a batch costs ~one block
// confirmation instead of one per recipient. Records every send
// (repo.addAirdrop). Returns { sent, failed }.
async function airdropToken({ rewardToken, allocations, cycleId }) {
  if (allocations.length === 0) return { sent: 0, failed: 0 };

  const decimals = config.dryRun ? 18 : await getDecimals(rewardToken);
  const uiOf = (raw) => Number(raw) / 10 ** decimals;
  // NonceManager assigns nonces locally so the whole batch can be in flight at once.
  const signer = config.dryRun ? null : new NonceManager(wallet);
  const token = config.dryRun ? null : erc20(rewardToken, signer);
  const batches = chunk(allocations, config.airdropBatchSize);

  let sent = 0;
  let failed = 0;
  for (const [i, batch] of batches.entries()) {
    const results = [];
    if (config.dryRun) {
      for (const a of batch) results.push({ a, signature: fakeSig('airdrop'), status: 'ok' });
    } else {
      // Submit every transfer in the batch without waiting for inclusion…
      // A failed submission is retried once (RPC rate limits are transient)
      // before the recipient is marked failed for this cycle.
      const pending = [];
      for (const a of batch) {
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
        if (tx) {
          pending.push({ a, tx });
        } else {
          console.error(`[airdrop] transfer to ${a.owner} failed to send: ${lastErr.message}`);
          results.push({ a, signature: null, status: 'failed' });
        }
      }
      // …then wait for all their confirmations together.
      await Promise.all(
        pending.map(async (p) => {
          try {
            await p.tx.wait();
            results.push({ a: p.a, signature: p.tx.hash, status: 'ok' });
          } catch (err) {
            console.error(`[airdrop] transfer to ${p.a.owner} reverted: ${err.message}`);
            results.push({ a: p.a, signature: p.tx.hash, status: 'failed' });
          }
        })
      );
    }

    for (const r of results) {
      await repo.addAirdrop({
        cycleId,
        rewardToken,
        recipient: r.a.owner,
        amountRaw: r.a.amountRaw,
        amountUi: uiOf(r.a.amountRaw),
        signature: r.signature,
        status: r.status,
      });
      if (r.status === 'ok') sent += 1;
      else failed += 1;
    }
    if (batches.length > 1) console.log(`[airdrop] batch ${i + 1}/${batches.length} done (sent=${sent} failed=${failed})`);
  }
  return { sent, failed };
}

module.exports = { airdropToken };
