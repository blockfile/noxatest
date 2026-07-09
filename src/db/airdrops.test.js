'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

// One mongo server per file (config.mongoUri is captured at module load, so a
// second connect() in the same process would point at the first, stopped server).
test('addAirdrop + getAirdrops: round-trip newest-first, and reward_token filter', async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'noxarewards_test_airdrops';
  const db = require('./index');
  const repo = require('./repository');
  await db.connect();
  try {
    await repo.addAirdrop({ cycleId: 1, rewardToken: '0xother', recipient: '0xa', amountRaw: '10', amountUi: 1, signature: 's1', status: 'ok' });
    await repo.addAirdrop({ cycleId: 1, rewardToken: '0xreward', recipient: '0xb', amountRaw: '20', amountUi: 2, signature: 's2', status: 'ok' });
    await repo.addAirdrop({ cycleId: 1, rewardToken: '0xreward', recipient: '0xc', amountRaw: '30', amountUi: 3, signature: 's3', status: 'ok' });

    // Round-trip: all rows, newest first.
    const all = await repo.getAirdrops(10, 0);
    assert.strictEqual(all.total, 3);
    assert.strictEqual(all.items[0].recipient, '0xc'); // newest first
    assert.strictEqual(all.items[2].recipient, '0xa');

    // reward_token filter — powers GET /airdrops?token=<symbol>.
    const reward = await repo.getAirdrops(10, 0, '0xreward');
    assert.strictEqual(reward.total, 2);
    assert.ok(reward.items.every((i) => i.reward_token === '0xreward'));

    const none = await repo.getAirdrops(10, 0, '__none__'); // unknown token -> empty
    assert.strictEqual(none.total, 0);
  } finally {
    await db.close();
    await mongod.stop();
  }
});
