const express = require('express');
const path = require('path');

const sessionsRouter = require('./routes/sessions');
const strategiesRouter = require('./routes/strategies');
const backtestsRouter = require('./routes/backtests');
const auditRouter = require('./routes/audit');

function createApp() {
  const app = express();

  app.use(express.json());

  // CORS for local development
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // API routes
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/strategies', strategiesRouter);
  app.use('/api/backtests', backtestsRouter);
  app.use('/api/audit', auditRouter);

  // Serve static dashboard
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  // SPA fallback
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html'));
    }
  });

  // Error handler
  app.use((err, req, res, next) => {
    console.error('API Error:', err);
    res.status(500).json({ error: err.message });
  });

  return app;
}

module.exports = { createApp };
