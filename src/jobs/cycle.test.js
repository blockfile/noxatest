'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('runCycle (DRY_RUN): claim, buy reward token + airdrop', async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69'; // holder token
  process.env.REWARD_TOKEN_ADDRESS = '0x00000000000000000000000000000000000c0459'; // reward token
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'noxarewards_test_cycle';
  const db = require('../db/index');
  const repo = require('../db/repository');
  const simvault = require('../evm/simvault');
  const { runCycle } = require('./cycle');
  await db.connect();
  try {
    simvault.reset(0.05); // creator-fee vault has fees to claim
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'complete');
    assert.ok(typeof cycle.eligible_holders === 'number', 'records the eligible-holder count');
    assert.strictEqual(cycle.total_holders, 3, 'records the raw distinct-owner count (sim: 2 eligible + wallet)');
    const names = cycle.steps.map((s) => s.name);
    assert.ok(names.includes('claim'));
    assert.strictEqual(names.filter((n) => n === 'buy').length, 1, 'one buy (reward token)');
    assert.strictEqual(names.filter((n) => n === 'airdrop').length, 1, 'one airdrop (reward token)');

    const { items } = await repo.getAirdrops(500, 0);
    const tokens = new Set(items.map((a) => a.reward_token));
    assert.ok(tokens.has(process.env.REWARD_TOKEN_ADDRESS.toLowerCase()), 'airdropped the reward token');
    assert.ok(!tokens.has(process.env.TOKEN_ADDRESS.toLowerCase()), 'the holder token was NOT airdropped');
  } finally {
    await db.close();
    await mongod.stop();
    delete require.cache[require.resolve('../config')];
  }
});
