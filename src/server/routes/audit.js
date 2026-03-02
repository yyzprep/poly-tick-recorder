const { Router } = require('express');
const { getRun, verifyRun } = require('../../audit/Reproducer');
const { getStrategy } = require('../../strategies/StrategyLoader');

const router = Router();

// In-memory result store reference (shared with backtests route)
// We'll access it through the reproducer

// GET /api/audit/:runId — full audit info for a run
router.get('/:runId', (req, res) => {
  try {
    const run = getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/audit/verify/:runId — re-verify hash
router.post('/verify/:runId', (req, res) => {
  try {
    const run = getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const strategy = getStrategy(run.strategy);
    if (!strategy) return res.status(400).json({ error: `Strategy "${run.strategy}" not found (may have been removed)` });

    const result = verifyRun(req.params.runId, {
      strategyName: strategy.name,
      strategySource: strategy._sourceHash || '',
      params: run.params,
      marketId: run.marketId,
      initialBalance: run.initialBalance,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
