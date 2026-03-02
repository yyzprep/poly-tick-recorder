/**
 * Mean Reversion — Fade extreme moves by betting on price returning to the mean.
 * When ask deviates by N standard deviations from its rolling average, bet opposite.
 */
module.exports = {
  name: 'Mean Reversion',
  description: 'Fades extreme price moves. When ask deviates beyond N std devs from rolling mean, bets on reversion.',
  params: {
    window: { type: 'number', default: 50, min: 10, max: 500, desc: 'Rolling window size for mean/stddev' },
    deviations: { type: 'number', default: 2.0, min: 0.5, max: 5.0, desc: 'Std dev threshold to trigger entry' },
    size: { type: 'number', default: 10, min: 1, max: 1000, desc: 'Position size (shares)' },
    maxPositions: { type: 'number', default: 2, min: 1, max: 10, desc: 'Maximum concurrent positions' },
  },

  init(ctx) {
    return {};
  },

  onTick(tick, history, portfolio, state, ctx) {
    const { window, deviations, size, maxPositions } = ctx.params;

    if (history.length < window) return null;
    if (portfolio.positionCount >= maxPositions) return null;

    // Compute rolling mean and stddev of ask
    const recentAsks = [];
    for (let i = history.length - window; i < history.length; i++) {
      recentAsks.push(history[i].ask);
    }

    const mean = recentAsks.reduce((a, b) => a + b, 0) / recentAsks.length;
    const variance = recentAsks.reduce((sum, v) => sum + (v - mean) ** 2, 0) / recentAsks.length;
    const std = Math.sqrt(variance);

    if (std < 0.001) return null; // No volatility

    const zScore = (tick.ask - mean) / std;

    // Ask is abnormally HIGH → price likely to revert down → buy NO
    if (zScore > deviations) {
      return { action: 'BUY_NO', size, reason: `Z-score ${zScore.toFixed(2)} > ${deviations} (overbought)` };
    }

    // Ask is abnormally LOW → price likely to revert up → buy YES
    if (zScore < -deviations) {
      return { action: 'BUY_YES', size, reason: `Z-score ${zScore.toFixed(2)} < -${deviations} (oversold)` };
    }

    return null;
  },
};
