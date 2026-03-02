const { Router } = require('express');
const { listSessions, getSession, getSessionTicks, getSessionStats, getAssets } = require('../../data/db');

const router = Router();

// GET /api/sessions — list with filters and pagination
router.get('/', (req, res) => {
  try {
    const { asset, search, startDate, endDate, page, limit, sortBy, sortDir } = req.query;
    const result = listSessions({
      asset: asset || undefined,
      search: search || undefined,
      startDate: startDate ? parseFloat(startDate) : undefined,
      endDate: endDate ? parseFloat(endDate) : undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
      sortBy: sortBy || 'end_time',
      sortDir: sortDir || 'DESC',
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/stats — aggregate stats
router.get('/stats', (req, res) => {
  try {
    res.json(getSessionStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/assets — list distinct assets
router.get('/assets', (req, res) => {
  try {
    res.json(getAssets());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:id — single session metadata
router.get('/:id', (req, res) => {
  try {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:id/ticks — decoded tick array
router.get('/:id/ticks', (req, res) => {
  try {
    const ticks = getSessionTicks(req.params.id);
    if (!ticks) return res.status(404).json({ error: 'Session not found' });
    res.json(ticks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
