/**
 * Main SPA router and application entry point.
 */
const App = {
  currentView: null,

  init() {
    WS.connect();
    window.addEventListener('hashchange', () => this.route());
    this.route();
  },

  route() {
    const hash = location.hash || '#/sessions';
    const [path, queryString] = hash.substring(1).split('?');
    const parts = path.split('/').filter(Boolean);
    const params = Object.fromEntries(new URLSearchParams(queryString || ''));

    // Update nav active state
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.toggle('active', hash.startsWith(`#/${link.dataset.route}`));
    });

    const container = document.getElementById('app');

    // Cleanup previous view
    if (this.currentView?.cleanup) this.currentView.cleanup();

    if (parts[0] === 'sessions' && parts[1]) {
      this.currentView = SessionViewer;
      SessionViewer.render(container, parts[1]);
    } else if (parts[0] === 'sessions') {
      this.currentView = SessionBrowser;
      SessionBrowser.render(container);
    } else if (parts[0] === 'backtest') {
      this.currentView = BacktestRunner;
      BacktestRunner.render(container, params);
    } else if (parts[0] === 'results' && parts[1]) {
      this.currentView = BacktestResults;
      BacktestResults.render(container, parts[1]);
    } else if (parts[0] === 'results') {
      this.currentView = BacktestResults;
      BacktestResults.render(container, null);
    } else {
      // Default to sessions
      location.hash = '#/sessions';
    }
  },
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
