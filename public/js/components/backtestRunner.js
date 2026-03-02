/**
 * Backtest Runner — select strategy, configure params, run backtest.
 */
const BacktestRunner = {
  state: {
    strategies: [],
    selectedStrategy: null,
    sessions: [],
    selectedMarketIds: [],
    running: false,
  },

  async render(container, queryParams = {}) {
    container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';

    try {
      const [strategies, sessionsData] = await Promise.all([
        API.strategies.list(),
        API.sessions.list({ limit: 200 }),
      ]);

      this.state.strategies = strategies;
      this.state.sessions = sessionsData.sessions;
      this.state.selectedStrategy = strategies[0] || null;

      // Pre-select market if passed via query
      if (queryParams.marketId) {
        this.state.selectedMarketIds = [queryParams.marketId];
      }

      this.draw(container, queryParams);
    } catch (err) {
      container.innerHTML = `<div class="card"><div class="empty-state">Error: ${err.message}</div></div>`;
    }
  },

  draw(container, queryParams = {}) {
    const { strategies, selectedStrategy, sessions } = this.state;
    const preselectedId = queryParams.marketId || '';

    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Run Backtest</h2>
          <button class="btn btn-sm" id="btn-reload-strategies">Reload Strategies</button>
        </div>

        <div class="form-grid" style="margin-bottom:20px">
          <div class="form-group">
            <label>Strategy</label>
            <select id="select-strategy">
              ${strategies.map(s => `<option value="${s.name}">${s.name} (${s.source})</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Starting Balance ($)</label>
            <input type="number" id="input-balance" value="100" min="1" step="10">
          </div>
        </div>

        <div id="strategy-description" style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
          ${selectedStrategy ? selectedStrategy.description : ''}
        </div>

        <div id="params-container" style="margin-bottom:20px"></div>

        <div class="card" style="background:var(--bg)">
          <div class="card-header">
            <h3 class="card-title">Select Sessions</h3>
            <div style="display:flex;gap:8px;align-items:center">
              <select id="batch-asset-filter" style="font-size:12px">
                <option value="">All Assets</option>
                <option value="BTC">BTC</option>
                <option value="ETH">ETH</option>
                <option value="SOL">SOL</option>
                <option value="XRP">XRP</option>
              </select>
              <button class="btn btn-sm" id="btn-select-all">Select All Visible</button>
              <button class="btn btn-sm" id="btn-select-none">Clear</button>
              <span id="selected-count" style="font-size:12px;color:var(--text-muted)">0 selected</span>
            </div>
          </div>
          <div class="table-wrap" style="max-height:300px;overflow-y:auto">
            <table>
              <thead>
                <tr>
                  <th style="width:30px"><input type="checkbox" id="check-all"></th>
                  <th>Asset</th>
                  <th>Title</th>
                  <th>Ticks</th>
                </tr>
              </thead>
              <tbody id="session-select-tbody"></tbody>
            </table>
          </div>
        </div>

        <div style="margin-top:20px;display:flex;gap:12px">
          <button class="btn btn-primary" id="btn-run" style="min-width:140px">
            Run Backtest
          </button>
          <button class="btn btn-success" id="btn-run-batch" style="min-width:140px">
            Run Batch
          </button>
        </div>
      </div>

      <div id="run-status"></div>
    `;

    this.renderParamsForm();
    this.renderSessionSelect(preselectedId);
    this.bindEvents(container);
  },

  renderParamsForm() {
    const container = document.getElementById('params-container');
    if (!container) return;

    const strategy = this.state.strategies.find(
      s => s.name === document.getElementById('select-strategy')?.value
    );
    if (!strategy || !strategy.params || Object.keys(strategy.params).length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No configurable parameters</div>';
      return;
    }

    container.innerHTML = `
      <label style="margin-bottom:8px;display:block">Strategy Parameters</label>
      <div class="form-grid">
        ${Object.entries(strategy.params).map(([key, schema]) => {
          if (schema.type === 'select') {
            return `<div class="form-group">
              <label>${schema.desc || key}</label>
              <select id="param-${key}" data-param="${key}">
                ${schema.options.map(o => `<option value="${o}" ${o === schema.default ? 'selected' : ''}>${o}</option>`).join('')}
              </select>
            </div>`;
          }
          return `<div class="form-group">
            <label>${schema.desc || key}</label>
            <input type="number" id="param-${key}" data-param="${key}"
              value="${schema.default ?? ''}"
              ${schema.min !== undefined ? `min="${schema.min}"` : ''}
              ${schema.max !== undefined ? `max="${schema.max}"` : ''}
              step="${schema.type === 'number' && schema.max <= 1 ? '0.01' : '1'}">
          </div>`;
        }).join('')}
      </div>
    `;
  },

  renderSessionSelect(preselectedId = '') {
    const tbody = document.getElementById('session-select-tbody');
    if (!tbody) return;

    const filter = document.getElementById('batch-asset-filter')?.value || '';
    const filtered = filter
      ? this.state.sessions.filter(s => s.asset === filter)
      : this.state.sessions;

    tbody.innerHTML = filtered.map(s => {
      const checked = preselectedId === s.market_id || this.state.selectedMarketIds.includes(s.market_id);
      return `<tr>
        <td><input type="checkbox" class="session-check" data-id="${s.market_id}" ${checked ? 'checked' : ''}></td>
        <td><span class="badge badge-${s.asset.toLowerCase()}">${s.asset}</span></td>
        <td style="font-size:12px">${s.title}</td>
        <td>${s.tick_count}</td>
      </tr>`;
    }).join('');

    this.updateSelectedCount();
  },

  getSelectedMarketIds() {
    const checks = document.querySelectorAll('.session-check:checked');
    return Array.from(checks).map(c => c.dataset.id);
  },

  updateSelectedCount() {
    const el = document.getElementById('selected-count');
    if (el) {
      const count = document.querySelectorAll('.session-check:checked').length;
      el.textContent = `${count} selected`;
    }
  },

  getParams() {
    const params = {};
    document.querySelectorAll('[data-param]').forEach(el => {
      const key = el.dataset.param;
      const val = el.type === 'number' ? parseFloat(el.value) : el.value;
      params[key] = val;
    });
    return params;
  },

  bindEvents(container) {
    document.getElementById('select-strategy')?.addEventListener('change', (e) => {
      const strategy = this.state.strategies.find(s => s.name === e.target.value);
      document.getElementById('strategy-description').textContent = strategy?.description || '';
      this.renderParamsForm();
    });

    document.getElementById('btn-reload-strategies')?.addEventListener('click', async () => {
      await API.strategies.reload();
      const strategies = await API.strategies.list();
      this.state.strategies = strategies;
      location.hash = '#/backtest';
    });

    document.getElementById('batch-asset-filter')?.addEventListener('change', () => {
      this.state.selectedMarketIds = this.getSelectedMarketIds();
      this.renderSessionSelect();
    });

    document.getElementById('btn-select-all')?.addEventListener('click', () => {
      document.querySelectorAll('.session-check').forEach(c => c.checked = true);
      this.updateSelectedCount();
    });

    document.getElementById('btn-select-none')?.addEventListener('click', () => {
      document.querySelectorAll('.session-check').forEach(c => c.checked = false);
      this.updateSelectedCount();
    });

    document.getElementById('check-all')?.addEventListener('change', (e) => {
      document.querySelectorAll('.session-check').forEach(c => c.checked = e.target.checked);
      this.updateSelectedCount();
    });

    document.addEventListener('change', (e) => {
      if (e.target.classList.contains('session-check')) this.updateSelectedCount();
    });

    // Run single
    document.getElementById('btn-run')?.addEventListener('click', async () => {
      const ids = this.getSelectedMarketIds();
      if (ids.length === 0) return alert('Select at least one session');

      const strategy = document.getElementById('select-strategy').value;
      const balance = parseFloat(document.getElementById('input-balance').value) || 100;
      const params = this.getParams();

      // Use first selected for single run
      const statusEl = document.getElementById('run-status');
      statusEl.innerHTML = '<div class="card"><div class="loading"><div class="spinner"></div>Running backtest...</div></div>';

      try {
        const result = await API.backtests.runSync({
          marketId: ids[0],
          strategy,
          params,
          balance,
        });
        location.hash = `#/results/${result.runId}`;
      } catch (err) {
        statusEl.innerHTML = `<div class="card" style="border-color:var(--red)"><div class="empty-state" style="color:var(--red)">Error: ${err.message}</div></div>`;
      }
    });

    // Run batch
    document.getElementById('btn-run-batch')?.addEventListener('click', async () => {
      const ids = this.getSelectedMarketIds();
      if (ids.length === 0) return alert('Select at least one session');

      const strategy = document.getElementById('select-strategy').value;
      const balance = parseFloat(document.getElementById('input-balance').value) || 100;
      const params = this.getParams();

      const statusEl = document.getElementById('run-status');
      statusEl.innerHTML = `<div class="card"><div class="loading"><div class="spinner"></div>Running batch (${ids.length} sessions)...</div></div>`;

      try {
        const result = await API.backtests.runBatch({
          marketIds: ids,
          strategy,
          params,
          balance,
        });

        this.renderBatchResults(statusEl, result);
      } catch (err) {
        statusEl.innerHTML = `<div class="card" style="border-color:var(--red)"><div class="empty-state" style="color:var(--red)">Error: ${err.message}</div></div>`;
      }
    });
  },

  renderBatchResults(container, batchResult) {
    const { aggregate, results } = batchResult;
    const pnlClass = aggregate.totalPnL >= 0 ? 'positive' : 'negative';

    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Batch Results</h3>
          <span style="color:var(--text-muted);font-size:13px">${aggregate.totalRuns} runs</span>
        </div>

        <div class="metrics-grid" style="margin-bottom:20px">
          <div class="metric-card">
            <div class="metric-label">Total PnL</div>
            <div class="metric-value ${pnlClass}">$${aggregate.totalPnL.toFixed(2)}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Avg PnL</div>
            <div class="metric-value ${aggregate.avgPnL >= 0 ? 'positive' : 'negative'}">$${aggregate.avgPnL.toFixed(2)}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Avg Return</div>
            <div class="metric-value ${aggregate.avgReturn >= 0 ? 'positive' : 'negative'}">${aggregate.avgReturn.toFixed(2)}%</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Avg Win Rate</div>
            <div class="metric-value">${aggregate.avgWinRate.toFixed(1)}%</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Successful</div>
            <div class="metric-value">${aggregate.successful}/${aggregate.totalRuns}</div>
          </div>
        </div>

        <div class="table-wrap" style="max-height:400px;overflow-y:auto">
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Title</th>
                <th>PnL</th>
                <th>Return</th>
                <th>Trades</th>
                <th>Win Rate</th>
                <th>Outcome</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${results.map(r => {
                if (r.error) {
                  return `<tr><td colspan="8" style="color:var(--red)">${r.marketId}: ${r.error}</td></tr>`;
                }
                return `<tr>
                  <td><span class="badge badge-${r.asset.toLowerCase()}">${r.asset}</span></td>
                  <td style="font-size:12px">${r.title}</td>
                  <td style="color:${r.pnl >= 0 ? 'var(--green)' : 'var(--red)'};font-family:var(--mono)">$${r.pnl.toFixed(2)}</td>
                  <td style="color:${r.returnPct >= 0 ? 'var(--green)' : 'var(--red)'}">${r.returnPct.toFixed(2)}%</td>
                  <td>${r.trades}</td>
                  <td>${r.winRate.toFixed(1)}%</td>
                  <td><span class="badge badge-${r.outcome.toLowerCase()}">${r.outcome}</span></td>
                  <td><button class="btn btn-sm" onclick="location.hash='#/results/${r.runId}'">View</button></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },
};
