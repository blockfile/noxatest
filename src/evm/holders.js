'use strict';

const { Interface } = require('ethers');
const config = require('../config');
const { provider, walletAddress } = require('./provider');
const { getTokenSupplyRaw } = require('./erc20');

const TRANSFER_IFACE = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const TRANSFER_TOPIC = TRANSFER_IFACE.getEvent('Transfer').topicHash;
const ZERO = '0x0000000000000000000000000000000000000000';

// Pure: collapse balance rows to per-owner totals, drop excluded + below min.
// Owners are compared case-insensitively (EVM addresses are lowercased upstream).
function filterEligible(accounts, minHoldRaw, excludeSet) {
  const min = BigInt(minHoldRaw.toString());
  const byOwner = new Map();
  for (const a of accounts) {
    if (excludeSet.has(a.owner)) continue;
    byOwner.set(a.owner, (byOwner.get(a.owner) || 0n) + BigInt(a.amountRaw.toString()));
  }
  const out = [];
  for (const [owner, bal] of byOwner) {
    if (bal >= min) out.push({ owner, balanceRaw: bal.toString() });
  }
  return out;
}

// Pure: do the fetched balances account for (almost) the whole token supply?
// Sum-of-balances == totalSupply is a hard on-chain invariant, so a shortfall
// beyond `tolerancePct` means the source's data is incomplete — Blockscout
// serves partial holder lists (HTTP 200!) while it is still backfilling a
// token, which once mis-airdropped a whole cycle to a single holder.
function coversSupply(accounts, supplyRaw, tolerancePct = 2) {
  const supply = BigInt(supplyRaw.toString());
  if (supply <= 0n) return true; // nothing to compare against
  let sum = 0n;
  for (const a of accounts) sum += BigInt(a.amountRaw.toString());
  const diff = supply > sum ? supply - sum : sum - supply;
  return diff * 100n <= supply * BigInt(tolerancePct);
}

// Pure: distinct owners with any nonzero balance — the "total holders" figure
// (explorer-style: no min-hold filter, no exclusions).
function countOwners(accounts) {
  const owners = new Set();
  for (const a of accounts) {
    if (BigInt(a.amountRaw.toString()) > 0n) owners.add(a.owner);
  }
  return owners.size;
}

// Page through Blockscout's holders API for `token`. Every NOXA chain ships a
// Blockscout instance, so this needs no API key. Returns [{owner, amountRaw}]
// with owners lowercased.
const MAX_PAGES = 400; // 50 holders/page → 20k holders; log if we ever truncate

async function fetchHoldersFromExplorer(token) {
  const base = `${config.explorerApi}/api/v2/tokens/${token}/holders`;
  const accounts = [];
  let url = base;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`explorer holders HTTP ${res.status}`);
    const data = await res.json();
    for (const item of data.items || []) {
      accounts.push({ owner: item.address.hash.toLowerCase(), amountRaw: String(item.value) });
    }
    if (!data.next_page_params) return accounts;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(data.next_page_params)) qs.set(k, String(v));
    url = `${base}?${qs}`;
  }
  console.warn(`[holders] truncated at ${MAX_PAGES} pages (${accounts.length} holders) — raise MAX_PAGES`);
  return accounts;
}

// Fallback holder source: rebuild every balance from the token's Transfer log
// history via RPC. Needed because Blockscout indexes with lag and 404s on
// tokens younger than its indexed head.
//
// Providers cap eth_getLogs ranges (QuickNode: 10,000 blocks, error -32614),
// and Robinhood Chain mints ~864k blocks/day, so the scan is CHUNKED — and
// INCREMENTAL: per token we keep the running balance map and the last scanned
// block in memory, so only the first call walks history (from the token's
// creation block, found by bisecting getCode) and each later call scans just
// the new blocks since. A bot restart rescans once.
const logIndex = new Map(); // token -> { fromBlock, balances: Map, inflight: Promise|null }

// The token's deployment block, so the log scan starts there instead of
// genesis. Try the explorer first (it knows the creation tx even while its
// holder index lags), then bisect getCode over history, else genesis — the
// scan is chunked either way, this only bounds how much history it walks.
async function findCreationBlock(token, head) {
  try {
    const res = await fetch(`${config.explorerApi}/api/v2/addresses/${token}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const info = await res.json();
      if (info.creation_transaction_hash) {
        const tx = await provider.getTransactionReceipt(info.creation_transaction_hash);
        if (tx && tx.blockNumber != null) return tx.blockNumber;
      }
    }
  } catch (_err) {
    // explorer down — fall through to the RPC bisect
  }
  let lo = 0;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await provider.getCode(token, mid).catch(() => null);
    if (code === null) return 0; // non-archive RPC — scan from genesis, chunked anyway
    if (code === '0x') lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function scanLogsInto(state, token, toBlock) {
  const range = Math.max(1, config.logScanRange);
  const add = (addr, delta) => {
    const k = addr.toLowerCase();
    state.balances.set(k, (state.balances.get(k) || 0n) + delta);
  };
  while (state.fromBlock <= toBlock) {
    const chunkEnd = Math.min(state.fromBlock + range - 1, toBlock);
    const logs = await provider.getLogs({
      address: token,
      topics: [TRANSFER_TOPIC],
      fromBlock: state.fromBlock,
      toBlock: chunkEnd,
    });
    for (const l of logs) {
      const { args } = TRANSFER_IFACE.parseLog({ topics: [...l.topics], data: l.data });
      add(args.from, -args.value);
      add(args.to, args.value);
    }
    state.fromBlock = chunkEnd + 1; // resume point — safe even if a later chunk throws
  }
}

async function fetchHoldersFromLogs(token) {
  const key = token.toLowerCase();
  let state = logIndex.get(key);
  if (!state) {
    state = { fromBlock: null, balances: new Map(), inflight: null };
    logIndex.set(key, state);
  }
  // Serialize concurrent snapshots (cycle + /summary) onto one scan.
  while (state.inflight) await state.inflight.catch(() => {});
  state.inflight = (async () => {
    const head = await provider.getBlockNumber();
    if (state.fromBlock === null) {
      state.fromBlock = await findCreationBlock(token, head);
      console.log(`[holders] log scan starting from creation block ${state.fromBlock} (head ${head})`);
    }
    await scanLogsInto(state, token, head);
  })();
  try {
    await state.inflight;
  } finally {
    state.inflight = null;
  }

  const accounts = [];
  for (const [owner, bal] of state.balances) {
    if (owner !== ZERO && bal > 0n) accounts.push({ owner, amountRaw: bal.toString() });
  }
  return accounts;
}

// Explorer's own distinct-holder counter for the token (what the explorer UI
// shows). Falls back to null so the caller can use the snapshot count instead.
async function fetchHolderCount(token) {
  try {
    const res = await fetch(`${config.explorerApi}/api/v2/tokens/${token}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const n = Number(data.holders_count ?? data.holders);
    return Number.isFinite(n) ? n : null;
  } catch (_err) {
    return null;
  }
}

// Explorer circuit breaker: after a failure, go straight to the log scan for
// this long instead of re-paging a struggling Blockscout (503s, partial
// backfill) on every snapshot — /summary refreshes holder counts every minute.
const EXPLORER_COOLDOWN_MS = 5 * 60 * 1000;
let explorerCooldownUntil = 0;

// Snapshot of `token` holders. Returns { holders, totalHolders }: `holders` are
// the eligible per-owner balances (>= minHold, exclusions applied);
// `totalHolders` is the raw distinct-owner count (what explorers display).
async function snapshotEligibleHolders({ token, minHoldRaw, exclude }) {
  if (config.dryRun) {
    // Two simulated eligible holders + the wallet (excluded) so cycles exercise the path.
    const sim = [
      { owner: '0x1111111111111111111111111111111111111111', amountRaw: String(BigInt(minHoldRaw) * 2n) },
      { owner: '0x2222222222222222222222222222222222222222', amountRaw: String(BigInt(minHoldRaw) * 3n) },
      { owner: walletAddress().toLowerCase(), amountRaw: String(BigInt(minHoldRaw) * 9n) },
    ];
    return { holders: filterEligible(sim, minHoldRaw, exclude), totalHolders: countOwners(sim) };
  }
  const supplyRaw = await getTokenSupplyRaw(token);
  let accounts;
  let totalHolders;
  try {
    if (Date.now() < explorerCooldownUntil) {
      throw new Error('explorer in cooldown after recent failure');
    }
    accounts = await fetchHoldersFromExplorer(token);
    if (!coversSupply(accounts, supplyRaw)) {
      throw new Error('explorer holder list incomplete (balances do not cover the token supply)');
    }
    totalHolders = (await fetchHolderCount(token)) ?? countOwners(accounts);
  } catch (err) {
    if (Date.now() >= explorerCooldownUntil) {
      console.warn(`[holders] explorer unusable (${err.message}) — rebuilding from Transfer logs`);
      explorerCooldownUntil = Date.now() + EXPLORER_COOLDOWN_MS;
    }
    accounts = await fetchHoldersFromLogs(token);
    if (!coversSupply(accounts, supplyRaw)) {
      // Both sources failed the supply invariant — refusing beats mis-airdropping
      // a whole cycle to whoever happens to be in the partial list.
      throw new Error('holder set incomplete from both explorer and Transfer logs — refusing to distribute');
    }
    totalHolders = countOwners(accounts);
  }
  return { holders: filterEligible(accounts, minHoldRaw, exclude), totalHolders };
}

module.exports = { filterEligible, countOwners, coversSupply, snapshotEligibleHolders };
