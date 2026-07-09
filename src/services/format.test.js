'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  toPublicSummary,
  buildUnclaimedPayload,
  toActivityRow,
  toPublicActivityRow,
  toPublicStats,
} = require('./format');

test('buildUnclaimedPayload reports the live balance and the USD claim threshold', () => {
  const out = buildUnclaimedPayload(0.5, 3000);
  assert.deepStrictEqual(Object.keys(out).sort(), ['claimThresholdUsd', 'ethPriceUsd', 'unclaimedEth', 'unclaimedUsd']);
  assert.strictEqual(out.unclaimedEth, 0.5);
  assert.strictEqual(out.unclaimedUsd, 1500);
  assert.strictEqual(out.ethPriceUsd, 3000);
  assert.strictEqual(typeof out.claimThresholdUsd, 'number');
  // null balance is preserved (RPC unavailable)
  assert.strictEqual(buildUnclaimedPayload(null, 3000).unclaimedEth, null);
});

test('toActivityRow maps claim/buy/airdrop steps', () => {
  const buy = toActivityRow({ name: 'buy', detail: { ethSpent: 0.4, leg: 'A' }, signature: 'sig', created_at: 'x' }, 100);
  assert.strictEqual(buy.type, 'Buy');
  assert.strictEqual(buy.amountEth, 0.4);

  const airdropFail = toActivityRow({ name: 'airdrop', status: 'failed', detail: {} }, 0);
  assert.strictEqual(airdropFail.status, 'Failed');
});

test('toPublicActivityRow maps buy steps', () => {
  const row = toPublicActivityRow({ name: 'buy', detail: { ethSpent: 0.2, leg: 'A' }, signature: 's', created_at: '2026-06-29T00:00:00Z' }, 100);
  assert.strictEqual(row.type, 'buy');
  assert.strictEqual(row.amountEth, 0.2);
  assert.strictEqual(typeof row.usdtValue, 'number'); // never null
});

test('toPublicStats emits the flat frontend stats object', () => {
  const out = toPublicStats({
    stats: { total_eth_claimed: 12 },
    unclaimedEth: 0.5,
    operatingWallet: '0xwallet',
    market: { marketCap: 100 },
  });
  assert.strictEqual(out.totalCreatorFeesClaimed, 12);
  assert.strictEqual(out.operatingWallet, '0xwallet');
  assert.strictEqual(out.unclaimedFeesEth, 0.5);
  assert.strictEqual(out.marketCap, 100);
});

test('toPublicSummary reports reward distributed and current eligible holders', () => {
  const out = toPublicSummary({
    stats: { total_eth_claimed: 10 },
    byToken: { '0xreward': { sends: 5, totalUi: 2000, holders: 50 } },
    eligibleHolders: 42,
    totalHolders: 1200,
    price: 3000,
    rewardTokenAddress: '0xreward',
    marketCapUsd: 55_620_000,
  });
  assert.strictEqual(out.creatorFeesClaimedEth, 10);
  assert.strictEqual(out.creatorFeesClaimedUsd, 30000);
  assert.strictEqual(out.rewardDistributed, 2000);
  assert.strictEqual(out.holders, 42);
  assert.strictEqual(out.totalHolders, 1200);
  assert.strictEqual(out.distributions, 5);
  assert.strictEqual(out.marketCapUsd, 55_620_000);
});

test('toPublicSummary marketCapUsd and totalHolders default to null when not provided', () => {
  const out = toPublicSummary({ stats: {}, byToken: {}, price: 0, rewardTokenAddress: '0xreward' });
  assert.strictEqual(out.marketCapUsd, null);
  assert.strictEqual(out.totalHolders, null, 'null until a cycle has recorded it');
});
