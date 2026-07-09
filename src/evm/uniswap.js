'use strict';

// Buys on Uniswap V3 (SwapRouter02) — NOXA Fun tokens trade in ordinary V3
// pools (1% fee tier by default), so a plain exactInputSingle WETH→token swap
// is the whole buy path. The claim pays the wallet in WETH, which is exactly
// the router's input token; any native-ETH shortfall is wrapped on the fly.

const { Contract, parseEther, formatEther } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { wethContract, getDecimals, readTokenBalance } = require('./erc20');
const { launcherToken } = require('./noxa');

const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
];

const DEFAULT_POOL_FEE = 10000; // NOXA Fun launches on the 1% fee tier

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** The token's V3 fee tier (from its NOXA launcher fields), defaulting to 1%. */
async function resolvePoolFee(token) {
  try {
    return Number(await launcherToken(token).poolFee());
  } catch (_err) {
    return DEFAULT_POOL_FEE; // not a NOXA launcher token — assume the 1% tier
  }
}

/** Ensure the wallet holds >= amountIn WETH, wrapping native ETH to cover a shortfall. */
async function ensureWethBalance(amountIn) {
  const weth = wethContract(wallet);
  const bal = await weth.balanceOf(wallet.address);
  if (bal >= amountIn) return;
  const shortfall = amountIn - bal;
  const native = await provider.getBalance(wallet.address);
  if (native <= shortfall) {
    throw new Error(
      `insufficient WETH+ETH: need ${formatEther(amountIn)} WETH, have ${formatEther(bal)} WETH + ${formatEther(native)} ETH`
    );
  }
  const tx = await weth.deposit({ value: shortfall });
  await tx.wait();
  console.log(`[tx] wrap ${formatEther(shortfall)} ETH → WETH: ${tx.hash}`);
}

/** Approve the router to spend WETH once (max approval, skipped when already set). */
async function ensureRouterAllowance(amountIn) {
  const weth = wethContract(wallet);
  const allowance = await weth.allowance(wallet.address, config.swapRouter);
  if (allowance >= amountIn) return;
  const tx = await weth.approve(config.swapRouter, (1n << 256n) - 1n);
  await tx.wait();
  console.log(`[tx] approve router for WETH: ${tx.hash}`);
}

/**
 * Buy `token` with `ethAmount` (spent as WETH) via exactInputSingle.
 * @returns {Promise<{signature, tokensBought, tokensBoughtRaw, baseDecimals, simulated}>}
 */
async function buyToken(token, ethAmount) {
  if (config.dryRun) {
    const baseDecimals = 18;
    const tokensBought = +(ethAmount * 1_000_000 * (0.97 + Math.random() * 0.06)).toFixed(0);
    return {
      signature: fakeSig('buy'),
      tokensBought,
      tokensBoughtRaw: (BigInt(tokensBought) * 10n ** BigInt(baseDecimals)).toString(),
      baseDecimals,
      simulated: true,
    };
  }

  const amountIn = parseEther(String(ethAmount));
  if (amountIn <= 0n) throw new Error(`invalid buy amount: ${ethAmount}`);

  await ensureWethBalance(amountIn);
  await ensureRouterAllowance(amountIn);

  const router = new Contract(config.swapRouter, ROUTER_ABI, wallet);
  const fee = await resolvePoolFee(token);
  const params = {
    tokenIn: config.weth,
    tokenOut: token,
    fee,
    recipient: wallet.address,
    amountIn,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  };

  // Quote by static-calling the swap itself (needs the balance + approval above),
  // then bound the real send by the configured slippage.
  const quoted = await router.exactInputSingle.staticCall(params);
  params.amountOutMinimum = (quoted * BigInt(Math.round((100 - config.slippagePct) * 100))) / 10000n;

  const baseDecimals = await getDecimals(token);
  const balBefore = await readTokenBalance(token, wallet.address);
  const tx = await router.exactInputSingle(params);
  await tx.wait();
  console.log(`[tx] buy ${token} with ${ethAmount} WETH: ${tx.hash}`);
  const balAfter = await readTokenBalance(token, wallet.address);

  const boughtRaw = balAfter - balBefore;
  return {
    signature: tx.hash,
    tokensBought: Number(boughtRaw) / 10 ** baseDecimals,
    tokensBoughtRaw: boughtRaw.toString(),
    baseDecimals,
    simulated: false,
  };
}

module.exports = { buyToken, resolvePoolFee, DEFAULT_POOL_FEE };
