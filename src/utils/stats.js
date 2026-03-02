/**
 * Compute backtest performance metrics.
 */
function computeStats({ trades, equityCurve, initialBalance, finalBalance, outcome }) {
  const totalPnL = finalBalance - initialBalance;
  const returnPct = (totalPnL / initialBalance) * 100;

  // Win/loss analysis
  const buyTrades = trades.filter(t => t.action === 'BUY');
  const totalTrades = buyTrades.length;

  // For binary markets, a "win" is when we bought the correct side
  // We determine win/loss from the settlement
  const wins = [];
  const losses = [];

  for (const trade of buyTrades) {
    const pnl = trade.side === outcome
      ? (1.0 - trade.price) * trade.size   // won: paid price, received $1
      : (-trade.price) * trade.size;        // lost: paid price, received $0
    if (pnl >= 0) wins.push(pnl);
    else losses.push(pnl);
  }

  const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;

  // Equity curve analysis
  const equities = equityCurve.map(e => e.equity);
  const maxEquity = Math.max(...equities, initialBalance);
  const minEquity = Math.min(...equities, initialBalance);

  // Max drawdown
  let peak = initialBalance;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  for (const eq of equities) {
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
  }

  // Sharpe ratio (simplified — using equity returns)
  let sharpe = 0;
  if (equities.length > 1) {
    const returns = [];
    for (let i = 1; i < equities.length; i++) {
      if (equities[i - 1] > 0) {
        returns.push((equities[i] - equities[i - 1]) / equities[i - 1]);
      }
    }
    if (returns.length > 0) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
      const std = Math.sqrt(variance);
      sharpe = std > 0 ? mean / std : 0;
    }
  }

  return {
    totalPnL: round(totalPnL),
    returnPct: round(returnPct),
    totalTrades,
    wins: wins.length,
    losses: losses.length,
    winRate: round(winRate),
    avgWin: round(avgWin),
    avgLoss: round(avgLoss),
    profitFactor: profitFactor === Infinity ? 'Inf' : round(profitFactor),
    maxDrawdown: round(maxDrawdown),
    maxDrawdownPct: round(maxDrawdownPct),
    sharpe: round(sharpe),
    maxEquity: round(maxEquity),
    minEquity: round(minEquity),
    finalBalance: round(finalBalance),
    outcome,
  };
}

function round(n, decimals = 4) {
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}

module.exports = { computeStats };
