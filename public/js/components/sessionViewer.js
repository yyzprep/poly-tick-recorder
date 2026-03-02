/**
 * Session Viewer — view a single session's tick data with interactive chart.
 */
const SessionViewer = {
  chartInstance: null,

  async render(container, marketId) {
    this.cleanup();
    container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading session...</div>';

    try {
      const [session, ticks] = await Promise.all([
        API.sessions.get(marketId),
        API.sessions.ticks(marketId),
      ]);

      const date = new Date(session.end_time * 1000);
      const badge = `badge-${session.asset.toLowerCase()}`;
      const outcome = ticks.length > 0 && ticks[ticks.length - 1].ask > 0.5 ? 'YES' : 'NO';

      container.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
          <button class="btn btn-sm" id="btn-back">&larr; Back</button>
          <h2 style="font-size:18px;font-weight:600">${this.escapeHtml(session.title)}</h2>
        </div>

        <div class="card">
          <div class="metrics-grid">
            <div class="metric-card">
              <div class="metric-label">Asset</div>
              <div class="metric-value"><span class="badge ${badge}">${session.asset}</span></div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Outcome</div>
              <div class="metric-value"><span class="badge badge-${outcome.toLowerCase()}">${outcome}</span></div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Ticks</div>
              <div class="metric-value">${session.tick_count.toLocaleString()}</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Duration</div>
              <div class="metric-value">${Math.round(session.span)}s</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Date</div>
              <div class="metric-value" style="font-size:14px">${date.toLocaleDateString()}</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Time</div>
              <div class="metric-value" style="font-size:14px">${date.toLocaleTimeString()}</div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h3 class="card-title">Price Chart (YES / NO)</h3>
            <button class="btn btn-sm btn-primary" id="btn-run-backtest">Run Backtest</button>
          </div>
          <div class="chart-container" id="session-chart"></div>
        </div>

        <div class="card">
          <div class="card-header">
            <h3 class="card-title">Tick Data</h3>
            <span style="color:var(--text-muted);font-size:12px">${ticks.length} ticks</span>
          </div>
          <div class="table-wrap" style="max-height:400px;overflow-y:auto">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Time</th>
                  <th>Sec Remaining</th>
                  <th>Bid (NO)</th>
                  <th>Ask (YES)</th>
                  <th>Spread</th>
                </tr>
              </thead>
              <tbody>
                ${ticks.filter((_, i) => i % Math.max(1, Math.floor(ticks.length / 200)) === 0 || i === ticks.length - 1).map((t, i) => {
                  const time = new Date(t.t * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  const spread = Math.abs(t.ask - t.bid);
                  return `<tr>
                    <td>${i}</td>
                    <td>${time}</td>
                    <td>${t.sr.toFixed(1)}s</td>
                    <td style="color:var(--red)">${t.bid.toFixed(4)}</td>
                    <td style="color:var(--green)">${t.ask.toFixed(4)}</td>
                    <td>${spread.toFixed(4)}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;

      // Render chart
      const chartEl = document.getElementById('session-chart');
      if (chartEl && ticks.length > 0) {
        this.chartInstance = Charts.createSessionChart(chartEl, ticks);
      }

      document.getElementById('btn-back').addEventListener('click', () => {
        location.hash = '#/sessions';
      });

      document.getElementById('btn-run-backtest').addEventListener('click', () => {
        location.hash = `#/backtest?marketId=${marketId}`;
      });

    } catch (err) {
      container.innerHTML = `<div class="card"><div class="empty-state">Error: ${err.message}</div></div>`;
    }
  },

  cleanup() {
    if (this.chartInstance) {
      this.chartInstance.resizeObserver?.disconnect();
      this.chartInstance.chart?.remove();
      this.chartInstance = null;
    }
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};
