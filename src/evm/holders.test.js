'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { filterEligible, countOwners, coversSupply } = require('./holders');

test('sums per owner, applies minimum and exclusions', () => {
  const accounts = [
    { owner: '0xa', amountRaw: '60000' },
    { owner: '0xa', amountRaw: '50000' }, // 0xa totals 110000
    { owner: '0xb', amountRaw: '90000' }, // below 100000
    { owner: '0xpool', amountRaw: '999999999' }, // excluded
  ];
  const out = filterEligible(accounts, 100000n, new Set(['0xpool']));
  assert.deepStrictEqual(out, [{ owner: '0xa', balanceRaw: '110000' }]);
});

test('countOwners counts distinct nonzero owners — no min, no exclusions (explorer-style)', () => {
  const accounts = [
    { owner: '0xa', amountRaw: '60000' },
    { owner: '0xa', amountRaw: '50000' }, // same owner, counted once
    { owner: '0xb', amountRaw: '90000' }, // below min-hold but still a holder
    { owner: '0xpool', amountRaw: '999999999' }, // exclusions don't apply here
    { owner: '0xempty', amountRaw: '0' }, // zero balance — not a holder
  ];
  assert.strictEqual(countOwners(accounts), 3);
});

test('coversSupply accepts a complete holder set (within tolerance)', () => {
  const accounts = [
    { owner: '0xa', amountRaw: '600000' },
    { owner: '0xb', amountRaw: '399000' }, // sum 999000 of 1000000 = 0.1% short
  ];
  assert.strictEqual(coversSupply(accounts, 1000000n), true);
  assert.strictEqual(coversSupply(accounts, 0n), true); // no supply — nothing to compare
});

test('coversSupply rejects a partial holder set (explorer mid-backfill)', () => {
  const accounts = [
    { owner: '0xa', amountRaw: '20000' },
    { owner: '0xb', amountRaw: '16000' }, // sum 36000 of 1000000 — way short
  ];
  assert.strictEqual(coversSupply(accounts, 1000000n), false);
});
