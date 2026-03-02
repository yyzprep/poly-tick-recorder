/**
 * Backtest Results — display metrics, equity curve, trade table, and audit info.
 */
const BacktestResults = {
  charts: [],

  async render(container, runId) {
    this.cleanup();

    if (!runId) {
      // Show list of past runs
      return this.renderList(container);
    }

    container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading results...</div>';

    try {
      const result = await API.backtests.get(runId);
      this.renderResult(container, result);
    } catch (err) {
      container.innerHTML = `<div class="card"><div class="empty-state">Error: ${err.message}</div></div>`;
    }
  },

  async renderList(container) {
    container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';

    try {
      const runs = await API.backtests.list();

      if (runs.length === 0) {
        container.innerHTML = '<div class="card"><div class="empty-state">No backtest runs yet. Go to Backtest tab to run one.</div></div>';
        return;
      }

      container.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Past Backtest Runs</h2>
            <span style="color:var(--text-muted);font-size:13px">${runs.length} runs</span>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th>Market</th>
                  <th>PnL</th>
                  <th>Trades</th>
                  <th>Outcome</th>
                  <th>Time</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${runs.map(r => `<tr class="clickable" data-id="${r.runId}">
                  <td>${r.strategy}</td>
                  <td>${r.marketId.substring(0, 12)}...</td>
                  <td style="color:${r.metrics.totalPnL >= 0 ? 'var(--green)' : 'var(--red)'};font-family:var(--mono)">
                    $${r.metrics.totalPnL.toFixed(2)}
                  </td>
                  <td>${r.tradeCount}</td>
                  <td><span class="badge badge-${r.outcome.toLowerCase()}">${r.outcome}</span></td>
                  <td>${new Date(r.timestamp).toLocaleTimeString()}</td>
                  <td>
                    <button class="btn btn-sm" onclick="location.hash='#/results/${r.runId}'">View</button>
                  </td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<div class="card"><div class="empty-state">Error: ${err.message}</div></div>`;
    }
  },

  renderResult(container, result) {
    const m = result.metrics;
    const pnlClass = m.totalPnL >= 0 ? 'positive' : 'negative';

    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <button class="btn btn-sm" id="btn-back-results">&larr; All Runs</button>
        <h2 style="font-size:18px;font-weight:600">${result.strategy} — ${result.session.title}</h2>
      </div>

      <!-- Metrics -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Performance Metrics</h3>
          <span class="badge badge-${result.outcome.toLowerCase()}">${result.outcome}</span>
        </div>
        <div class="metrics-grid">
          <div class="metric-card">
            <div class="metric-label">Total PnL</div>
            <div class="metric-value ${pnlClass}">$${m.totalPnL.toFixed(2)}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Return</div>
            <div class="metric-value ${pnlClass}">${m.returnPct.toFixed(2)}%</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Win Rate</div>
            <div class="metric-value">${m.winRate.toFixed(1)}%</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Trades</div>
            <div class="metric-value">${m.totalTrades}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Sharpe</div>
            <div class="metric-value">${m.sharpe.toFixed(3)}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Max Drawdown</div>
            <div class="metric-value negative">${m.maxDrawdownPct.toFixed(2)}%</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Profit Factor</div>
            <div class="metric-value">${m.profitFactor}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Final Balance</div>
            <div class="metric-value ${m.finalBalance >= result.initialBalance ? 'positive' : 'negative'}">$${m.finalBalance.toFixed(2)}</div>
          </div>
        </div>
      </div>

      <!-- Equity Chart -->
      <div class="card">
        <h3 class="card-title" style="margin-bottom:12px">Equity Curve</h3>
        <div class="chart-container chart-container-sm" id="equity-chart"></div>
      </div>

      <!-- Price Chart with Trades -->
      <div class="card">
        <h3 class="card-title" style="margin-bottom:12px">Price Chart + Trades</h3>
        <div class="chart-container" id="price-chart"></div>
      </div>

      <!-- Trade Log -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Trade Log</h3>
          <span style="color:var(--text-muted);font-size:13px">${result.trades.length} trades</span>
        </div>
        ${result.trades.length > 0 ? `
        <div class="table-wrap" style="max-height:400px;overflow-y:auto">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Action</th>
                <th>Side</th>
                <th>Size</th>
                <th>Price</th>
                <th>Cost</th>
                <th>Balance After</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              ${result.trades.map((t, i) => `<tr>
                <td>${i + 1}</td>
                <td>${t.action}</td>
                <td><span class="badge badge-${t.side.toLowerCase()}">${t.side}</span></td>
                <td>${t.size}</td>
                <td style="font-family:var(--mono)">${t.price.toFixed(4)}</td>
                <td style="font-family:var(--mono)">$${t.cost.toFixed(2)}</td>
                <td style="font-family:var(--mono)">$${t.balanceAfter.toFixed(2)}</td>
                <td style="font-size:11px;color:var(--text-muted);max-width:300px;overflow:hidden;text-overflow:ellipsis">${t.reason}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<div class="empty-state">No trades executed</div>'}
      </div>

      <!-- Audit -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Audit</h3>
          <span class="badge badge-${result.audit.tainted ? 'tainted' : 'clean'}">${result.audit.tainted ? 'TAINTED' : 'CLEAN'}</span>
        </div>
        <div class="metrics-grid">
          <div class="metric-card">
            <div class="metric-label">Run Hash</div>
            <div class="metric-value" style="font-size:11px;word-break:break-all">${result.audit.hash.substring(0, 24)}...</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Ticks Processed</div>
            <div class="metric-value">${result.audit.ticksProcessed}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Duration</div>
            <div class="metric-value">${result.audit.durationMs}ms</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Violations</div>
            <div class="metric-value ${result.audit.violations.length > 0 ? 'negative' : ''}">${result.audit.violations.length}</div>
          </div>
        </div>
        ${result.audit.violations.length > 0 ? `
        <div style="margin-top:12px;padding:12px;background:rgba(239,68,68,0.1);border-radius:var(--radius);border:1px solid rgba(239,68,68,0.2)">
          <div style="font-size:13px;font-weight:600;color:var(--red);margin-bottom:8px">Lookahead Violations Detected:</div>
          ${result.audit.violations.map(v => `<div style="font-size:12px;color:var(--text-muted);font-family:var(--mono)">${v}</div>`).join('')}
        </div>` : ''}
        <div style="margin-top:12px">
          <button class="btn btn-sm" id="btn-verify">Verify Reproducibility</button>
          <span id="verify-result" style="margin-left:12px;font-size:13px"></span>
        </div>
      </div>
    `;

    // Render charts
    this.renderCharts(result);

    // Events
    document.getElementById('btn-back-results')?.addEventListener('click', () => {
      location.hash = '#/results';
    });

    document.getElementById('btn-verify')?.addEventListener('click', async () => {
      const el = document.getElementById('verify-result');
      el.textContent = 'Verifying...';
      try {
        const res = await API.audit.verify(result.runId);
        if (res.match) {
          el.innerHTML = '<span style="color:var(--green)">VERIFIED — hashes match</span>';
        } else {
          el.innerHTML = '<span style="color:var(--red)">MISMATCH — results may not be reproducible</span>';
        }
      } catch (err) {
        el.innerHTML = `<span style="color:var(--red)">Error: ${err.message}</span>`;
      }
    });
  },

  async renderCharts(result) {
    // Equity chart
    const eqEl = document.getElementById('equity-chart');
    if (eqEl && result.equityCurve.length > 0) {
      const ec = Charts.createEquityChart(eqEl, result.equityCurve, result.initialBalance);
      this.charts.push(ec);
    }

    // Price chart with trade markers — need to load ticks
    const priceEl = document.getElementById('price-chart');
    if (priceEl) {
      try {
        const ticks = await API.sessions.ticks(result.marketId);
        const pc = Charts.createSessionChart(priceEl, ticks);
        this.charts.push(pc);

        if (result.trades.length > 0) {
          Charts.addTradeMarkers(pc.askSeries, result.trades);
        }
      } catch (_) {}
    }
  },

  cleanup() {
    for (const c of this.charts) {
      c.resizeObserver?.disconnect();
      c.chart?.remove();
    }
    this.charts = [];
  },
};
