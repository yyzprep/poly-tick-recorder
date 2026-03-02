const { hashRun } = require('../utils/hash');
const { getSessionBlob } = require('../data/db');

/**
 * Reproducer — Verifies that backtest results are reproducible.
 * Same strategy + params + data → must produce identical hash.
 */

// In-memory store of past run hashes (in production, persist to DB)
const runStore = new Map();

function storeRun(result) {
  runStore.set(result.runId, {
    runId: result.runId,
    hash: result.audit.hash,
    strategy: result.strategy,
    params: result.params,
    marketId: result.marketId,
    initialBalance: result.initialBalance,
    finalBalance: result.finalBalance,
    tradeCount: result.trades.length,
    outcome: result.outcome,
    metrics: result.metrics,
    timestamp: Date.now(),
  });
}

function getRun(runId) {
  return runStore.get(runId) || null;
}

function getAllRuns() {
  return Array.from(runStore.values()).sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Verify a run: recompute the hash and compare.
 * Returns { match: boolean, originalHash, recomputedHash }
 */
function verifyRun(runId, { strategyName, strategySource, params, marketId, initialBalance }) {
  const stored = runStore.get(runId);
  if (!stored) return { error: `Run ${runId} not found` };

  const blob = getSessionBlob(marketId);
  const recomputedHash = hashRun({
    strategyName,
    strategySource,
    params,
    marketId,
    ticksBlobHash: blob,
    initialBalance,
  });

  return {
    match: stored.hash === recomputedHash,
    originalHash: stored.hash,
    recomputedHash,
    runId,
  };
}

module.exports = { storeRun, getRun, getAllRuns, verifyRun };
