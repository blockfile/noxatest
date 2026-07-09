'use strict';

const { Interface } = require('ethers');
const config = require('../config');
const { provider, walletAddress } = require('./provider');

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
// history via RPC (a single address+topic-filtered eth_getLogs call — verified
// the Robinhood Chain RPC serves the full range in one request). Needed because
// Blockscout indexes with lag and 404s on tokens younger than its indexed head.
async function fetchHoldersFromLogs(token) {
  const logs = await provider.getLogs({
    address: token,
    topics: [TRANSFER_TOPIC],
    fromBlock: 0,
    toBlock: 'latest',
  });
  const balances = new Map();
  const add = (addr, delta) => {
    const k = addr.toLowerCase();
    balances.set(k, (balances.get(k) || 0n) + delta);
  };
  for (const l of logs) {
    const { args } = TRANSFER_IFACE.parseLog({ topics: [...l.topics], data: l.data });
    add(args.from, -args.value);
    add(args.to, args.value);
  }
  balances.delete(ZERO); // the mint source runs negative; not a holder
  const accounts = [];
  for (const [owner, bal] of balances) {
    if (bal > 0n) accounts.push({ owner, amountRaw: bal.toString() });
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
  let accounts;
  let totalHolders;
  try {
    accounts = await fetchHoldersFromExplorer(token);
    totalHolders = (await fetchHolderCount(token)) ?? countOwners(accounts);
  } catch (err) {
    console.warn(`[holders] explorer unavailable (${err.message}) — rebuilding from Transfer logs`);
    accounts = await fetchHoldersFromLogs(token);
    totalHolders = countOwners(accounts);
  }
  return { holders: filterEligible(accounts, minHoldRaw, exclude), totalHolders };
}

module.exports = { filterEligible, countOwners, snapshotEligibleHolders };
