const { WebSocketServer } = require('ws');

let wss = null;
const subscriptions = new Map(); // runId → Set<ws>

function setupWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.subscribedRuns = new Set();

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'subscribe' && msg.runId) {
          ws.subscribedRuns.add(msg.runId);
          if (!subscriptions.has(msg.runId)) {
            subscriptions.set(msg.runId, new Set());
          }
          subscriptions.get(msg.runId).add(ws);
        }
        if (msg.type === 'unsubscribe' && msg.runId) {
          ws.subscribedRuns.delete(msg.runId);
          const subs = subscriptions.get(msg.runId);
          if (subs) subs.delete(ws);
        }
      } catch (_) { /* ignore bad messages */ }
    });

    ws.on('close', () => {
      for (const runId of ws.subscribedRuns) {
        const subs = subscriptions.get(runId);
        if (subs) subs.delete(ws);
      }
    });
  });

  // Heartbeat every 30s
  const interval = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(interval));
}

/**
 * Broadcast an event to all clients subscribed to a runId.
 */
function broadcast(runId, event) {
  const subs = subscriptions.get(runId);
  if (!subs || subs.size === 0) return;

  const data = JSON.stringify(event);
  for (const ws of subs) {
    if (ws.readyState === 1) { // OPEN
      ws.send(data);
    }
  }
}

/**
 * Broadcast to ALL connected clients (for global events).
 */
function broadcastAll(event) {
  if (!wss) return;
  const data = JSON.stringify(event);
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(data);
  });
}

module.exports = { setupWebSocket, broadcast, broadcastAll };
