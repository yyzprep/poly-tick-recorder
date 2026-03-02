const crypto = require('crypto');

/**
 * Deterministic SHA-256 hash for reproducibility verification.
 * Same strategy + params + data = same hash.
 */
function hashRun({ strategyName, strategySource, params, marketId, ticksBlobHash, initialBalance }) {
  const hasher = crypto.createHash('sha256');

  // Hash inputs deterministically
  hasher.update(strategyName || '');
  hasher.update(strategySource || '');
  hasher.update(JSON.stringify(params, Object.keys(params).sort()));
  hasher.update(marketId);
  hasher.update(String(initialBalance));

  // Hash the raw tick data
  if (ticksBlobHash && Buffer.isBuffer(ticksBlobHash)) {
    hasher.update(ticksBlobHash);
  } else if (ticksBlobHash) {
    hasher.update(String(ticksBlobHash));
  }

  return hasher.digest('hex');
}

/**
 * Hash a strategy's source code for audit tracking.
 */
function hashSource(sourceCode) {
  return crypto.createHash('sha256').update(sourceCode).digest('hex');
}

module.exports = { hashRun, hashSource };
