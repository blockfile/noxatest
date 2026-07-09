'use strict';

// Buy the reward token with a given amount of ETH (spent as WETH) on Uniswap V3.
//   node scripts/buy.js <ethAmount> [--confirm]
const { config, hr, arg, requireConfirm } = require('./_util');
const { buyToken } = require('../src/evm/uniswap');

(async () => {
  hr('BUY REWARD TOKEN');
  const amount = Number(arg(0));
  if (!(amount > 0)) {
    console.log('usage: node scripts/buy.js <ethAmount> [--confirm]');
    process.exit(1);
  }
  if (!config.rewardTokenAddress) throw new Error('REWARD_TOKEN_ADDRESS is required');

  if (!(await requireConfirm(`buy ${config.rewardTokenAddress} with ${amount} ETH (as WETH)`))) {
    process.exit(0);
  }
  const result = await buyToken(config.rewardTokenAddress, amount);
  console.log('\nresult:', JSON.stringify(result, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ FAILED:', e.message);
  process.exit(1);
});
