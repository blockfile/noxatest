'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('config exposes the reward-loop defaults', () => {
  const config = require('./config');
  assert.strictEqual(config.rewardBuyPct, 80);
  assert.strictEqual(config.rewardCapPct, 0);
  assert.strictEqual(config.minHold, 100000);
  assert.strictEqual(config.pollSchedule, '*/1 * * * *');
  assert.strictEqual(config.claimThresholdUsd, 20);
  assert.strictEqual(config.dryRunFeePerPoll, 0.01);
  assert.strictEqual(config.airdropBatchSize, 25);
  assert.strictEqual(config.chainId, 4663);
  assert.strictEqual(config.creatorFeeSharePct, 35);
  assert.ok(Array.isArray(config.clusters));
  assert.ok(Array.isArray(config.airdropExclude));
});

test('config.clusters parses a JSON array-of-arrays from env (lowercased)', () => {
  delete require.cache[require.resolve('./config')];
  process.env.CLUSTERS = '[["0xAAA","0xBBB"],["0xCCC"]]';
  const config = require('./config');
  assert.deepStrictEqual(config.clusters, [['0xaaa', '0xbbb'], ['0xccc']]);
  delete process.env.CLUSTERS;
  delete require.cache[require.resolve('./config')];
});
