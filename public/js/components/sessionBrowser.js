/**
 * Session Browser — browse, filter, and search all sessions.
 */
const SessionBrowser = {
  state: {
    sessions: [],
    total: 0,
    page: 1,
    limit: 50,
    totalPages: 0,
    asset: '',
    search: '',
    assets: [],
    stats: null,
    loading: false,
  },

  async render(container) {
    this.container = container;
    this.state.page = 1;

    // Load assets list and stats in parallel
    if (this.state.assets.length === 0) {
      const [assets, stats] = await Promise.all([
        API.sessions.assets(),
        API.sessions.stats(),
      ]);
      this.state.assets = assets;
      this.state.stats = stats;
    }

    this.draw();
    await this.loadData();
  },

  draw() {
    const { stats, assets, asset, search } = this.state;

    this.container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Sessions</h2>
          ${stats ? `<span style="color:var(--text-muted);font-size:13px">${stats.total.toLocaleString()} total sessions</span>` : ''}
        </div>

        ${stats ? `
        <div class="metrics-grid" style="margin-bottom:20px">
          ${assets.map(a => {
            const count = stats.byAsset.find(x => x.asset === a)?.count || 0;
            return `<div class="metric-card">
              <div class="metric-label">${a}</div>
              <div class="metric-value">${count.toLocaleString()}</div>
            </div>`;
          }).join('')}
          <div class="metric-card">
            <div class="metric-label">Avg Ticks</div>
            <div class="metric-value">${Math.round(stats.avgTicks).toLocaleString()}</div>
          </div>
        </div>` : ''}

        <div class="filters-bar">
          <div class="filter-group">
            <label>Asset</label>
            <select id="filter-asset">
              <option value="">All Assets</option>
              ${assets.map(a => `<option value="${a}" ${a === asset ? 'selected' : ''}>${a}</option>`).join('')}
            </select>
          </div>
          <div class="filter-group">
            <label>Search</label>
            <input type="text" id="filter-search" placeholder="Search titles..." value="${search}" style="width:250px">
          </div>
          <button class="btn btn-primary" id="btn-filter">Filter</button>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Title</th>
                <th>Date</th>
                <th>Ticks</th>
                <th>Duration</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="sessions-tbody">
              <tr><td colspan="6" class="loading"><div class="spinner"></div>Loading...</td></tr>
            </tbody>
          </table>
        </div>

        <div class="pagination" id="pagination"></div>
      </div>
    `;

    // Event listeners
    document.getElementById('btn-filter').addEventListener('click', () => {
      this.state.asset = document.getElementById('filter-asset').value;
      this.state.search = document.getElementById('filter-search').value;
      this.state.page = 1;
      this.loadData();
    });

    document.getElementById('filter-search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.state.asset = document.getElementById('filter-asset').value;
        this.state.search = document.getElementById('filter-search').value;
        this.state.page = 1;
        this.loadData();
      }
    });
  },

  async loadData() {
    const tbody = document.getElementById('sessions-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="loading"><div class="spinner"></div>Loading...</td></tr>';

    try {
      const params = { page: this.state.page, limit: this.state.limit };
      if (this.state.asset) params.asset = this.state.asset;
      if (this.state.search) params.search = this.state.search;

      const data = await API.sessions.list(params);
      this.state.sessions = data.sessions;
      this.state.total = data.total;
      this.state.totalPages = data.totalPages;

      this.renderTable();
      this.renderPagination();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Error: ${err.message}</td></tr>`;
    }
  },

  renderTable() {
    const tbody = document.getElementById('sessions-tbody');
    if (!tbody) return;

    if (this.state.sessions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No sessions found</td></tr>';
      return;
    }

    tbody.innerHTML = this.state.sessions.map(s => {
      const date = new Date(s.end_time * 1000);
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const badge = `badge-${s.asset.toLowerCase()}`;
      const duration = Math.round(s.span);

      return `<tr class="clickable" data-id="${s.market_id}">
        <td><span class="badge ${badge}">${s.asset}</span></td>
        <td>${this.escapeHtml(s.title)}</td>
        <td>${dateStr} ${timeStr}</td>
        <td>${s.tick_count.toLocaleString()}</td>
        <td>${duration}s</td>
        <td>
          <button class="btn btn-sm view-btn" data-id="${s.market_id}">View</button>
          <button class="btn btn-sm btn-primary backtest-btn" data-id="${s.market_id}">Backtest</button>
        </td>
      </tr>`;
    }).join('');

    // Row click handlers
    tbody.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        location.hash = `#/sessions/${btn.dataset.id}`;
      });
    });

    tbody.querySelectorAll('.backtest-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        location.hash = `#/backtest?marketId=${btn.dataset.id}`;
      });
    });

    tbody.querySelectorAll('tr.clickable').forEach(row => {
      row.addEventListener('click', () => {
        location.hash = `#/sessions/${row.dataset.id}`;
      });
    });
  },

  renderPagination() {
    const el = document.getElementById('pagination');
    if (!el) return;

    const { page, totalPages, total } = this.state;
    const start = (page - 1) * this.state.limit + 1;
    const end = Math.min(page * this.state.limit, total);

    el.innerHTML = `
      <span class="page-info">Showing ${start}-${end} of ${total.toLocaleString()}</span>
      <div style="display:flex;gap:4px">
        <button class="btn btn-sm" id="btn-prev" ${page <= 1 ? 'disabled' : ''}>Prev</button>
        <span style="padding:4px 12px;font-size:13px;color:var(--text-muted)">Page ${page} of ${totalPages}</span>
        <button class="btn btn-sm" id="btn-next" ${page >= totalPages ? 'disabled' : ''}>Next</button>
      </div>
    `;

    document.getElementById('btn-prev')?.addEventListener('click', () => {
      if (this.state.page > 1) { this.state.page--; this.loadData(); }
    });
    document.getElementById('btn-next')?.addEventListener('click', () => {
      if (this.state.page < this.state.totalPages) { this.state.page++; this.loadData(); }
    });
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};
