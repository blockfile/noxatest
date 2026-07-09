'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('buildExcludeSet includes wallet, devWallet, NOXA contracts and manual AIRDROP_EXCLUDE', async () => {
  process.env.DRY_RUN = 'true';
  process.env.DEV_WALLET = '0xDEv1000000000000000000000000000000000001';
  process.env.AIRDROP_EXCLUDE = '0xAbC0000000000000000000000000000000000001, 0xDef0000000000000000000000000000000000002';
  delete require.cache[require.resolve('../config')];
  const { walletAddress } = require('./provider');
  const { buildExcludeSet } = require('./exclude');
  const config = require('../config');

  const set = await buildExcludeSet('0xToKen00000000000000000000000000000000001');
  assert.ok(set.has('0xabc0000000000000000000000000000000000001'), 'manual vault excluded (lowercased)');
  assert.ok(set.has('0xdef0000000000000000000000000000000000002'));
  assert.ok(set.has('0xdev1000000000000000000000000000000000001'));
  assert.ok(set.has(walletAddress().toLowerCase()), 'operating wallet excluded');
  assert.ok(set.has(config.noxaLocker.toLowerCase()), 'NOXA locker excluded');
  assert.ok(set.has(config.noxaFeeVault.toLowerCase()), 'NOXA fee vault excluded');
  assert.ok(set.has('0xtoken00000000000000000000000000000000001'), 'the token contract itself excluded');
  assert.ok(set.has('0x0000000000000000000000000000000000000000'), 'zero address excluded');

  delete process.env.DEV_WALLET;
  delete process.env.AIRDROP_EXCLUDE;
  delete require.cache[require.resolve('../config')];
});
