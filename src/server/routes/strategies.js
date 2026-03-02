const { Router } = require('express');
const { listStrategies, getStrategy, reload } = require('../../strategies/StrategyLoader');

const router = Router();

// GET /api/strategies — list all available strategies
router.get('/', (req, res) => {
  try {
    res.json(listStrategies());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/strategies/reload — hot-reload strategies from disk
router.post('/reload', (req, res) => {
  try {
    const strategies = reload();
    res.json({ message: 'Strategies reloaded', count: strategies.length, strategies });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/strategies/:name — single strategy details
router.get('/:name', (req, res) => {
  try {
    const strategy = getStrategy(req.params.name);
    if (!strategy) return res.status(404).json({ error: 'Strategy not found' });
    res.json({
      name: strategy.name,
      description: strategy.description || '',
      params: strategy.params || {},
      source: strategy._source,
      fileName: strategy._fileName,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
