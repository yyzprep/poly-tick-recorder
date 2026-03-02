const { Router } = require('express');
const { Backtester } = require('../../engine/Backtester');
const { prepareStrategy } = require('../../strategies/StrategyLoader');
const { storeRun, getRun, getAllRuns } = require('../../audit/Reproducer');
const { broadcast } = require('../websocket');

const router = Router();

// In-memory store of full results (for retrieval)
const resultStore = new Map();

// POST /api/backtests/run — run a single backtest
router.post('/run', async (req, res) => {
  try {
    const { marketId, strategy: strategyName, params = {}, balance = 100 } = req.body;

    if (!marketId) return res.status(400).json({ error: 'marketId is required' });
    if (!strategyName) return res.status(400).json({ error: 'strategy is required' });

    const { strategy, params: resolvedParams } = prepareStrategy(strategyName, params);

    const backtester = new Backtester({
      strategy,
      params: resolvedParams,
      marketId,
      balance,
      onTick: (event) => broadcast(backtester.runId, event),
    });

    // Send runId immediately so client can subscribe via WebSocket
    res.json({ runId: backtester.runId, status: 'running' });

    // Run in background
    try {
      const result = await backtester.run();
      resultStore.set(result.runId, result);
      storeRun(result);
      broadcast(result.runId, { type: 'complete', data: { runId: result.runId, metrics: result.metrics } });
    } catch (err) {
      broadcast(backtester.runId, { type: 'error', data: { runId: backtester.runId, message: err.message } });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/backtests/run-sync — run and wait for result
router.post('/run-sync', async (req, res) => {
  try {
    const { marketId, strategy: strategyName, params = {}, balance = 100 } = req.body;

    if (!marketId) return res.status(400).json({ error: 'marketId is required' });
    if (!strategyName) return res.status(400).json({ error: 'strategy is required' });

    const { strategy, params: resolvedParams } = prepareStrategy(strategyName, params);

    const backtester = new Backtester({
      strategy,
      params: resolvedParams,
      marketId,
      balance,
    });

    const result = await backtester.run();
    resultStore.set(result.runId, result);
    storeRun(result);

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/backtests/run-batch — run across multiple sessions
router.post('/run-batch', async (req, res) => {
  try {
    const { marketIds, strategy: strategyName, params = {}, balance = 100 } = req.body;

    if (!marketIds || !Array.isArray(marketIds) || marketIds.length === 0) {
      return res.status(400).json({ error: 'marketIds array is required' });
    }
    if (!strategyName) return res.status(400).json({ error: 'strategy is required' });

    const { strategy, params: resolvedParams } = prepareStrategy(strategyName, params);

    const results = [];
    for (const marketId of marketIds) {
      try {
        const backtester = new Backtester({
          strategy,
          params: resolvedParams,
          marketId,
          balance,
        });
        const result = await backtester.run();
        resultStore.set(result.runId, result);
        storeRun(result);
        results.push({
          runId: result.runId,
          marketId,
          asset: result.session.asset,
          title: result.session.title,
          pnl: result.metrics.totalPnL,
          returnPct: result.metrics.returnPct,
          trades: result.metrics.totalTrades,
          winRate: result.metrics.winRate,
          outcome: result.outcome,
        });
      } catch (err) {
        results.push({ marketId, error: err.message });
      }
    }

    // Compute aggregate stats
    const successful = results.filter(r => !r.error);
    const aggregate = {
      totalRuns: results.length,
      successful: successful.length,
      failed: results.length - successful.length,
      avgPnL: successful.length > 0 ? successful.reduce((s, r) => s + r.pnl, 0) / successful.length : 0,
      avgReturn: successful.length > 0 ? successful.reduce((s, r) => s + r.returnPct, 0) / successful.length : 0,
      avgWinRate: successful.length > 0 ? successful.reduce((s, r) => s + r.winRate, 0) / successful.length : 0,
      totalPnL: successful.reduce((s, r) => s + r.pnl, 0),
    };

    res.json({ aggregate, results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/backtests — list past runs
router.get('/', (req, res) => {
  try {
    res.json(getAllRuns());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/backtests/:runId — get full result
router.get('/:runId', (req, res) => {
  try {
    const result = resultStore.get(req.params.runId);
    if (!result) return res.status(404).json({ error: 'Run not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
