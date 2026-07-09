'use strict';

// Read-only preflight. Sends NO transactions. Verifies your config + on-chain state.
//   node scripts/check.js
const { formatEther } = require('ethers');
const { config, provider, wallet, hr } = require('./_util');

(async () => {
  hr('CONFIG');
  console.log('dryRun     :', config.dryRun);
  console.log('rpcUrl     :', config.rpcUrl, `(chain ${config.chainId})`);
  console.log('wallet     :', wallet.address, config.walletIsEphemeral ? '⚠️ EPHEMERAL — set WALLET_PRIVATE_KEY' : '');
  console.log('token      :', config.tokenAddress || '⚠️ MISSING — set TOKEN_ADDRESS');
  console.log('reward     :', config.rewardTokenAddress || '⚠️ MISSING — set REWARD_TOKEN_ADDRESS');
  console.log('factory    :', config.noxaFactory);
  console.log('locker     :', config.noxaLocker);
  console.log('feeVault   :', config.noxaFeeVault);
  console.log('router     :', config.swapRouter);

  hr('RPC + WALLET BALANCE');
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== config.chainId) {
    console.log(`⚠️ RPC reports chain ${net.chainId}, expected ${config.chainId}`);
  } else {
    console.log('chainId    :', Number(net.chainId), '✓');
  }
  const wei = await provider.getBalance(wallet.address);
  console.log('ETH balance:', formatEther(wei), 'ETH');
  if (wei === 0n) console.log('⚠️ wallet has 0 ETH — fund it before any live test');
  const { wethContract } = require('../src/evm/erc20');
  const wethBal = await wethContract().balanceOf(wallet.address);
  console.log('WETH       :', formatEther(wethBal), 'WETH');

  if (!config.tokenAddress) {
    console.log('\nSet TOKEN_ADDRESS to run the remaining checks.');
    process.exit(0);
  }

  hr('NOXA LAUNCH RECORD');
  const { getLaunchedToken, getClaimableEth } = require('../src/evm/noxa');
  const launch = await getLaunchedToken(config.tokenAddress);
  console.log('exists     :', launch.exists);
  if (!launch.exists) {
    console.log('⚠️ this token was not launched via the NOXA factory on this chain');
    process.exit(0);
  }
  console.log('deployer   :', launch.deployer, launch.deployer.toLowerCase() === wallet.address.toLowerCase() ? '✓ (this wallet — fees pay here)' : '⚠️ NOT this wallet — creator fees pay to the deployer!');
  console.log('pairToken  :', launch.pairedToken);
  console.log('positionId :', launch.positionId.toString());
  console.log('poolFee    :', Number(launch.poolFee) / 10000, '%');

  hr('CLAIMABLE CREATOR FEES');
  if (config.dryRun) {
    console.log('(DRY_RUN — simulated vault; set DRY_RUN=false to read the real position)');
  } else {
    const claimable = await getClaimableEth();
    console.log('claimable  :', claimable, `ETH (creator share, est. ${config.creatorFeeSharePct}% of WETH-side LP fees)`);
  }

  hr('HOLDERS (explorer)');
  try {
    const res = await fetch(`${config.explorerApi}/api/v2/tokens/${config.tokenAddress}`, { headers: { accept: 'application/json' } });
    const t = await res.json();
    console.log('symbol     :', t.symbol, ' holders:', t.holders_count ?? t.holders);
  } catch (e) {
    console.log('explorer lookup failed:', e.message);
  }

  console.log('\n✅ preflight complete (no transactions sent)');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ check failed:', e.message);
  process.exit(1);
});
