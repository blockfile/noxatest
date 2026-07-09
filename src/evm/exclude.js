'use strict';

const config = require('../config');
const { walletAddress } = require('./provider');

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';

// Addresses that must never receive an airdrop: the operating wallet, the dev
// wallet, any manually-listed vaults (AIRDROP_EXCLUDE), the NOXA protocol
// contracts, the token contract itself, the burn addresses, and — in live
// mode — the token's V3 liquidity pool. Pool lookup is best-effort: a failure
// must never break a cycle, so the manual list is the guaranteed path.
// All entries are lowercased; holder snapshots lowercase owners to match.
async function buildExcludeSet(holderToken) {
  const set = new Set();
  const add = (v) => { if (v) set.add(String(v).toLowerCase()); };

  add(walletAddress());
  add(config.devWallet);
  for (const a of config.airdropExclude) add(a);

  add(ZERO);
  add(DEAD);
  add(config.noxaFactory);
  add(config.noxaLocker);
  add(config.noxaFeeVault);
  add(holderToken); // the token contract holds no claimable balance for anyone

  if (!config.dryRun && holderToken) {
    try {
      const { launcherToken } = require('./noxa');
      add(await launcherToken(holderToken).liquidityPool());
    } catch (_err) {
      // lookup unavailable — rely on AIRDROP_EXCLUDE
    }
  }
  return set;
}

module.exports = { buildExcludeSet };
