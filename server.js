'use strict';

const express = require('express');
const cors = require('cors');

const config = require('./src/config');
const db = require('./src/db');
const { walletAddress } = require('./src/evm/provider');
const scheduler = require('./src/jobs/scheduler');
const { getEthPriceUsd } = require('./src/evm/price');

const statusRoutes = require('./src/routes/status');
const cycleRoutes = require('./src/routes/cycles');
const controlRoutes = require('./src/routes/control');
const metricsRoutes = require('./src/routes/metrics');
const streamRoutes = require('./src/routes/stream');
const publicRoutes = require('./src/routes/public');

const app = express();

// CORS allowlist — non-browser requests (no Origin) always pass; browsers are
// restricted to config.corsOrigins (or any origin if it contains "*").
const allowAll = config.corsOrigins.includes('*');
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowAll || config.corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`origin ${origin} not allowed by CORS`));
    },
  })
);
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    name: 'noxa-rewards',
    description:
      'NOXA Fun creator fees → buy reward token for holders (claims at $20 accrued, Robinhood Chain)',
    dryRun: config.dryRun,
    chainId: config.chainId,
    wallet: walletAddress(),
    endpoints: [
      'GET  /activity',
      'GET  /stats',
      'GET  /airdrops',
      'GET  /summary',
      'GET  /burn',
      'GET  /countdown',
      'GET  /api/status',
      'GET  /api/unclaimed',
      'GET  /api/stream (SSE live push)',
      'GET  /api/cycles',
      'GET  /api/cycles/:id',
      'GET  /api/transactions',
      'POST /api/run',
      'POST /api/pause',
      'POST /api/resume',
    ],
  });
});

app.use('/api', statusRoutes);
app.use('/api', cycleRoutes);
app.use('/api', controlRoutes);
app.use('/api', metricsRoutes);
app.use('/api', streamRoutes);

// Public, frontend-shaped endpoints (GET /activity, GET /stats) for the site.
app.use('/', publicRoutes);

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[noxa-rewards] request error:', err);
  res.status(500).json({ error: err.message });
});

let server;

async function main() {
  await db.connect();
  console.log(`[noxa-rewards] MongoDB connected (${config.mongoDb})`);

  getEthPriceUsd().catch(() => {}); // warm the price cache for USD values

  server = app.listen(config.port, () => {
    console.log(`[noxa-rewards] listening on http://localhost:${config.port}`);
    console.log(`[noxa-rewards] dryRun=${config.dryRun} chainId=${config.chainId} wallet=${walletAddress()}`);
    if (config.walletIsEphemeral) {
      console.log('[noxa-rewards] WARNING: using an ephemeral wallet (no WALLET_PRIVATE_KEY set) — dry run only');
    }
    scheduler.start();
  });
}

async function shutdown(signal) {
  console.log(`\n[noxa-rewards] ${signal} received, shutting down`);
  if (server) server.close();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[noxa-rewards] failed to start:', err);
  process.exit(1);
});

module.exports = app;
