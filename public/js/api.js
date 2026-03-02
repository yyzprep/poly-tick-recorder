/**
 * API client — wraps all fetch calls to the backend.
 */
const API = {
  base: '',

  async get(path) {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  async post(path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  // Sessions
  sessions: {
    list: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return API.get(`/api/sessions${qs ? '?' + qs : ''}`);
    },
    stats: () => API.get('/api/sessions/stats'),
    assets: () => API.get('/api/sessions/assets'),
    get: (id) => API.get(`/api/sessions/${encodeURIComponent(id)}`),
    ticks: (id) => API.get(`/api/sessions/${encodeURIComponent(id)}/ticks`),
  },

  // Strategies
  strategies: {
    list: () => API.get('/api/strategies'),
    get: (name) => API.get(`/api/strategies/${encodeURIComponent(name)}`),
    reload: () => API.post('/api/strategies/reload'),
  },

  // Backtests
  backtests: {
    run: (body) => API.post('/api/backtests/run', body),
    runSync: (body) => API.post('/api/backtests/run-sync', body),
    runBatch: (body) => API.post('/api/backtests/run-batch', body),
    list: () => API.get('/api/backtests'),
    get: (runId) => API.get(`/api/backtests/${runId}`),
  },

  // Audit
  audit: {
    get: (runId) => API.get(`/api/audit/${runId}`),
    verify: (runId) => API.post(`/api/audit/verify/${runId}`),
  },
};

/**
 * WebSocket manager for live backtest updates.
 */
const WS = {
  _ws: null,
  _listeners: new Map(),

  connect() {
    if (this._ws && this._ws.readyState <= 1) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this._ws = new WebSocket(`${proto}//${location.host}/ws`);

    this._ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const runId = msg.data?.runId;
        if (runId && this._listeners.has(runId)) {
          for (const cb of this._listeners.get(runId)) {
            cb(msg);
          }
        }
      } catch (_) {}
    };

    this._ws.onclose = () => {
      setTimeout(() => this.connect(), 2000);
    };
  },

  subscribe(runId, callback) {
    if (!this._listeners.has(runId)) {
      this._listeners.set(runId, new Set());
    }
    this._listeners.get(runId).add(callback);

    if (this._ws && this._ws.readyState === 1) {
      this._ws.send(JSON.stringify({ type: 'subscribe', runId }));
    }
  },

  unsubscribe(runId, callback) {
    const listeners = this._listeners.get(runId);
    if (listeners) {
      listeners.delete(callback);
      if (listeners.size === 0) this._listeners.delete(runId);
    }
  },
};
