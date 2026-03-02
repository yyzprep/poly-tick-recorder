const http = require('http');
const { createApp } = require('./src/server/app');
const { setupWebSocket } = require('./src/server/websocket');
const { loadAll } = require('./src/strategies/StrategyLoader');

const PORT = process.env.PORT || 3000;

// Load strategies on startup
const strategies = loadAll();
console.log(`Loaded ${strategies.length} strategies: ${strategies.map(s => s.name).join(', ')}`);

// Create Express app and HTTP server
const app = createApp();
const server = http.createServer(app);

// Attach WebSocket
setupWebSocket(server);

server.listen(PORT, () => {
  console.log(`\n  Poly Backtester running at http://localhost:${PORT}`);
  console.log(`  WebSocket at ws://localhost:${PORT}/ws`);
  console.log(`  Dashboard at http://localhost:${PORT}\n`);
});
