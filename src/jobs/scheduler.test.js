'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('pollOnce: skips when empty, holds below the USD threshold, claims at/above it', async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
  process.env.REWARD_TOKEN_ADDRESS = '0x00000000000000000000000000000000000c0459';
  process.env.DRY_RUN_FEE_PER_POLL = '0'; // no simulated accrual — we control the vault
  process.env.CLAIM_THRESHOLD_USD = '50';
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'noxarewards_test_sched';
  const db = require('../db/index');
  const repo = require('../db/repository');
  const simvault = require('../evm/simvault');
  const price = require('../evm/price');
  const scheduler = require('./scheduler');
  await db.connect();
  try {
    price._prime(3000); // deterministic ETH price — no network fetch
    simvault.reset(0);

    // Empty vault → tick skips silently, no cycle row written.
    const p1 = await scheduler.pollOnce('poll');
    assert.strictEqual(p1.ran, false);
    assert.strictEqual(p1.reason, 'nothing claimable');
    assert.strictEqual((await repo.getCycles(10, 0)).total, 0, 'no cycle while vault is empty');

    // Fees accrued but below the threshold ($30 < $50) → hold, no cycle.
    simvault.reset(0.01); // 0.01 ETH * $3000 = $30
    const p2 = await scheduler.pollOnce('poll');
    assert.strictEqual(p2.ran, false);
    assert.strictEqual(p2.claimableUsd, 30);
    assert.match(p2.reason, /below threshold/);
    assert.strictEqual((await repo.getCycles(10, 0)).total, 0, 'no cycle below the threshold');

    // At/above the threshold ($60 >= $50) → the tick claims and distributes.
    simvault.reset(0.02); // 0.02 ETH * $3000 = $60
    const p3 = await scheduler.pollOnce('poll');
    assert.strictEqual(p3.ran, true);
    assert.strictEqual(p3.cycle.status, 'complete');
    assert.strictEqual((await repo.getCycles(10, 0)).total, 1, 'one cycle once the threshold is reached');
  } finally {
    await db.close();
    await mongod.stop();
    delete process.env.CLAIM_THRESHOLD_USD;
    delete require.cache[require.resolve('../config')];
  }
});
