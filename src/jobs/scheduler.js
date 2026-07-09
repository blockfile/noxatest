'use strict';

const cron = require('node-cron');
const config = require('../config');
const { runCycle } = require('./cycle');
const { getClaimableEth, simulateFeeAccrual } = require('../evm/noxa');
const bus = require('../events');

const state = {
  task: null,
  paused: false,
  isRunning: false,
  lastRunAt: null,
  lastResult: null, // { id, status }
  lastClaimable: null,
  startedAt: null,
};

/**
 * One timer tick (every POLL_SCHEDULE, default 5 minutes). Advances the simulated
 * vault (DRY_RUN only), reads the claimable creator-fee balance, and runs a cycle
 * claiming WHATEVER has accrued. Skips silently (no cycle row) when nothing is
 * claimable. Overlap-guarded.
 * @param {string} trigger 'poll' | 'manual'
 * @returns {Promise<{ran:boolean, claimable?:number, reason?:string, cycle?:object}>}
 */
async function pollOnce(trigger) {
  if (state.paused) return { ran: false, reason: 'paused' };
  if (state.isRunning) {
    console.log(`[scheduler] ${trigger} tick ignored — a cycle is already running`);
    return { ran: false, reason: 'cycle already running' };
  }

  simulateFeeAccrual(); // no-op in live mode
  const claimable = await getClaimableEth();
  state.lastClaimable = claimable;
  if (!(claimable > 0)) {
    return { ran: false, claimable, reason: 'nothing claimable' };
  }

  state.isRunning = true;
  state.lastRunAt = new Date().toISOString();
  try {
    const cycle = await runCycle();
    state.lastResult = { id: cycle.id, status: cycle.status };
    return { ran: true, claimable, cycle };
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
    paused: state.paused,
    isRunning: state.isRunning,
    lastRunAt: state.lastRunAt,
    lastResult: state.lastResult,
    lastClaimable: state.lastClaimable,
    startedAt: state.startedAt,
  };
}

module.exports = { start, pause, resume, triggerNow, pollOnce, getState };
