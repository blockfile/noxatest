'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('pollOnce claims whatever accrued and skips when the vault is empty', async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
  process.env.REWARD_TOKEN_ADDRESS = '0x00000000000000000000000000000000000c0459';
  process.env.DRY_RUN_FEE_PER_POLL = '0'; // no simulated accrual — we control the vault
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'noxarewards_test_sched';
  const db = require('../db/index');
  const repo = require('../db/repository');
  const simvault = require('../evm/simvault');
  const scheduler = require('./scheduler');
  await db.connect();
  try {
    simvault.reset(0);

    // Empty vault → tick skips silently, no cycle row written.
    const p1 = await scheduler.pollOnce('poll');
    assert.strictEqual(p1.ran, false);
    assert.strictEqual(p1.reason, 'nothing claimable');
    const p2 = await scheduler.pollOnce('poll');
    assert.strictEqual(p2.ran, false);
    assert.strictEqual((await repo.getCycles(10, 0)).total, 0, 'no cycle while vault is empty');

    // Any accrued fees → the next tick claims and distributes them.
    simvault.reset(0.005);
    const p3 = await scheduler.pollOnce('poll');
    assert.strictEqual(p3.ran, true);
    assert.strictEqual(p3.cycle.status, 'complete');
    assert.strictEqual((await repo.getCycles(10, 0)).total, 1, 'one cycle once fees accrued');
  } finally {
    await db.close();
    await mongod.stop();
    delete require.cache[require.resolve('../config')];
  }
});
