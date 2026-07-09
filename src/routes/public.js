'use strict';

// Public, frontend-shaped endpoints for the frontend site. These emit the
// exact shapes in the frontend's API_SPEC (GET /activity, GET /stats) so the
// frontend only has to point at these URLs — no field remapping on its side.

const express = require('express');
const repo = require('../db/repository');
const { getUnclaimedEth } = require('../services/metrics');
const { getMarketData } = require('../services/marketdata');
const { getBurnInfo } = require('../services/burn');
const { getEthPriceUsd } = require('../evm/price');
const { walletAddress } = require('../evm/provider');
const { toPublicActivityRow, toPublicStats, toPublicSummary, buildUnclaimedPayload } = require('../services/format');
const config = require('../config');
const { nextRun } = require('../services/countdown');

const router = express.Router();

// Tiny in-memory TTL cache. The frontend polls activity ~4s and stats ~20s and
// the spec asks the backend to cache; this also de-dupes concurrent requests.
function cached(ttlMs, fn) {
  let value;
  let expires = 0;
  let inflight = null;
  return async () => {
    if (Date.now() < expires) return value;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        value = await fn();
        expires = Date.now() + ttlMs;
        return value;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

const loadActivity = cached(3000, async () => {
  const [steps, price] = await Promise.all([repo.getAllSteps(100, 0), getEthPriceUsd()]);
  return steps.map((s) => toPublicActivityRow(s, price)); // repo returns newest-first
});

const loadStats = cached(15000, async () => {
  const [stats, unclaimed, market] = await Promise.all([
    repo.getStats(),
    getUnclaimedEth().catch(() => ({ eth: null })),
    getMarketData().catch(() => ({ tokenInLp: null, marketCap: null })),
  ]);
  return toPublicStats({
    stats,
    unclaimedEth: unclaimed.eth,
    operatingWallet: walletAddress(),
    market,
  });
});

// GET /activity — array of transactions, newest first
router.get('/activity', async (req, res, next) => {
  try {
    res.json(await loadActivity());
  } catch (err) {
    next(err);
  }
});

// GET /stats — single object of live numbers
router.get('/stats', async (req, res, next) => {
  try {
    res.json(await loadStats());
  } catch (err) {
    next(err);
  }
});

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// Map a frontend token tab to its reward_token address. 'OUR' is the legacy tab
// key for the main token. Unknown/unconfigured tokens map to a sentinel so the
// query returns empty (never an unfiltered dump).
function tokenToAddress(token) {
  if (!token) return null;
  const map = {
    [config.rewardSymbol.toUpperCase()]: config.rewardTokenAddress,
    [config.tokenSymbol.toUpperCase()]: config.tokenAddress,
    OUR: config.tokenAddress,
  };
  return map[String(token).toUpperCase()] || '__none__';
}

// GET /airdrops?limit=&offset=&token=<REWARD_SYMBOL|TOKEN_SYMBOL|OUR> — per-recipient
// send history, newest first. `token` filters by reward stream (the frontend's tabs).
router.get('/airdrops', async (req, res, next) => {
  try {
    const limit = clampInt(req.query.limit, 100, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const token = req.query.token ? String(req.query.token).toUpperCase() : null;
    const rewardToken = tokenToAddress(token);
    const { total, items } = await repo.getAirdrops(limit, offset, rewardToken);
    res.json({ total, limit, offset, token, items });
  } catch (err) {
    next(err);
  }
});

// GET /countdown — authoritative next-cycle time for a synced frontend countdown
// (cycles run on a fixed timer, default every 5 minutes). Not cached: serverTime
// must be fresh so the client can anchor to the server clock.
router.get('/countdown', (req, res) => {
  const now = Date.now();
  const { nextAirdropAt, intervalSec } = nextRun(config.pollSchedule, now);
  res.json({ serverTime: now, nextAirdropAt, intervalSec });
});

// Headline numbers for the frontend.
const loadSummary = cached(10000, async () => {
  const [stats, byToken, holderCounts, price, market] = await Promise.all([
    repo.getStats(),
    repo.getAirdropTotals(),
    repo.getLatestEligibleHolders(),
    getEthPriceUsd().catch(() => 0),
    getMarketData().catch(() => ({ marketCap: null })),
  ]);
  return toPublicSummary({
    stats,
    byToken,
    eligibleHolders: holderCounts.eligible,
    totalHolders: holderCounts.total,
    price,
    rewardTokenAddress: config.rewardTokenAddress,
    marketCapUsd: market.marketCap ?? null,
  });
});

// GET /summary — hero headline stats.
router.get('/summary', async (req, res, next) => {
  try {
    res.json(await loadSummary());
  } catch (err) {
    next(err);
  }
});

// GET /accrual — fees accrued toward the next drop, frontend-shaped
// ({ accruedUsd, thresholdUsd }). Public mirror of /api/unclaimed: the /api
// namespace may sit behind an API key in deployments, this router never does.
const loadAccrual = cached(15000, async () => {
  const [{ eth }, price] = await Promise.all([getUnclaimedEth(), getEthPriceUsd()]);
  const { unclaimedUsd, claimThresholdUsd } = buildUnclaimedPayload(eth, price);
  return { accruedUsd: unclaimedUsd ?? 0, thresholdUsd: claimThresholdUsd };
});
router.get('/accrual', async (req, res, next) => {
  try {
    res.json(await loadAccrual());
  } catch (err) {
    next(err);
  }
});

// GET /burn — NOXA automatic-burn stats for the frontend's "Accrued fees" card:
// uncollected token-side LP fees (queued to burn) + burn-address balance so far.
const loadBurn = cached(15000, getBurnInfo);
router.get('/burn', async (req, res, next) => {
  try {
    res.json(await loadBurn());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
