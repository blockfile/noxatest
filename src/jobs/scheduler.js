'use strict';

const cron = require('node-cron');
const config = require('../config');
const { runCycle } = require('./cycle');
const { getClaimableEth, simulateFeeAccrual } = require('../evm/noxa');
const { getEthPriceUsd } = require('../evm/price');
const bus = require('../events');

const state = {
  task: null,
  paused: false,
  isRunning: false,
  lastRunAt: null,
  lastResult: null, // { id, status }
  lastClaimable: null,
  lastClaimableUsd: null,
  startedAt: null,
};

/**
 * One timer tick (every POLL_SCHEDULE, default 5 minutes). Advances the simulated
 * vault (DRY_RUN only), reads the claimable creator-fee balance, and runs a cycle
 * once it is worth >= CLAIM_THRESHOLD_USD (threshold 0 = claim whatever accrued).
 * Skips silently (no cycle row) otherwise. Overlap-guarded.
 * @param {string} trigger 'poll' | 'manual'
 * @returns {Promise<{ran:boolean, claimable?:number, claimableUsd?:number, reason?:string, cycle?:object}>}
 */
async function pollOnce(trigger) {
  if (state.paused) return { ran: false, reason: 'paused' };
  if (state.isRunning) {
    console.log(`[scheduler] ${trigger} tick ignored — a cycle is already running`);
    return { ran: false, reason: 'cycle already running' };
  }

  // Hold the run flag through the balance/price reads too — a manual
  // POST /api/run landing between these awaits and the cycle start must not
  // spawn a second concurrent cycle (wallet-nonce contention in live mode).
  state.isRunning = true;
  try {
    simulateFeeAccrual(); // no-op in live mode
    const claimable = await getClaimableEth();
    state.lastClaimable = claimable;
    if (!(claimable > 0)) {
      return { ran: false, claimable, reason: 'nothing claimable' };
    }

    // USD threshold gate: accumulate until the claim is worth pulling the trigger.
    // Manual POST /api/run bypasses this via triggerNow().
    let claimableUsd = null;
    if (config.claimThresholdUsd > 0) {
      const price = await getEthPriceUsd();
      if (price == null) {
        // Can't price the claim — hold rather than claim blind; next tick retries.
        return { ran: false, claimable, reason: 'ETH price unavailable — cannot evaluate USD threshold' };
      }
      claimableUsd = +(claimable * price).toFixed(2);
      state.lastClaimableUsd = claimableUsd;
      if (claimableUsd < config.claimThresholdUsd) {
        return {
          ran: false,
          claimable,
          claimableUsd,
          reason: `below threshold ($${claimableUsd} < $${config.claimThresholdUsd})`,
        };
      }
    }

    state.lastRunAt = new Date().toISOString();
    const cycle = await runCycle();
    state.lastResult = { id: cycle.id, status: cycle.status };
    return { ran: true, claimable, claimableUsd, cycle };
  } finally {
    state.isRunning = false;
  }
}

function start() {
  if (state.task) return;
  if (!cron.validate(config.pollSchedule)) {
    throw new Error(`Invalid POLL_SCHEDULE: ${config.pollSchedule}`);
  }
  state.startedAt = new Date().toISOString();
  state.task = cron.schedule(config.pollSchedule, () => {
    pollOnce('poll').catch((err) => console.error('[scheduler] poll error:', err));
  });
  console.log(
    `[scheduler] started — claims on schedule "${config.pollSchedule}" (dryRun=${config.dryRun})`
  );
}

function pause() {
  state.paused = true;
  const s = getState();
  bus.emit('scheduler', s);
  return s;
}

function resume() {
  state.paused = false;
  const s = getState();
  bus.emit('scheduler', s);
  return s;
}

/** Manual trigger from the API — forces a cycle immediately, off-schedule. */
async function triggerNow() {
  if (state.isRunning) return { skipped: true, reason: 'cycle already running' };
  state.isRunning = true;
  state.lastRunAt = new Date().toISOString();
  try {
    const cycle = await runCycle();
    state.lastResult = { id: cycle.id, status: cycle.status };
    return cycle;
  } finally {
    state.isRunning = false;
  }
}

function getState() {
  return {
    pollSchedule: config.pollSchedule,
    claimThresholdUsd: config.claimThresholdUsd,
    paused: state.paused,
    isRunning: state.isRunning,
    lastRunAt: state.lastRunAt,
    lastResult: state.lastResult,
    lastClaimable: state.lastClaimable,
    lastClaimableUsd: state.lastClaimableUsd,
    startedAt: state.startedAt,
  };
}

module.exports = { start, pause, resume, triggerNow, pollOnce, getState };
