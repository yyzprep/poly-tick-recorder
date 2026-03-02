/**
 * Momentum Strategy — Track bid/ask velocity over a lookback window.
 * Buys YES when ask price is rising (momentum positive), NO when falling.
 */
module.exports = {
  name: 'Momentum',
  description: 'Tracks price momentum over a lookback window. Buys YES when ask is rising, NO when falling. Enters once when signal triggers.',
  params: {
    lookback: { type: 'number', default: 20, min: 3, max: 200, desc: 'Number of ticks to measure momentum' },
    threshold: { type: 'number', default: 0.02, min: 0.001, max: 0.5, desc: 'Minimum momentum magnitude to enter' },
    size: { type: 'number', default: 10, min: 1, max: 1000, desc: 'Position size (shares)' },
    maxPositions: { type: 'number', default: 1, min: 1, max: 10, desc: 'Maximum concurrent positions' },
  },

  init(ctx) {
    return { entered: false };
  },

  onTick(tick, history, portfolio, state, ctx) {
    const { lookback, threshold, size, maxPositions } = ctx.params;

    // Wait for enough history
    if (history.length < lookback) return null;

    // Already at max positions
    if (portfolio.positionCount >= maxPositions) return null;

    // Calculate momentum: (current ask - ask N ticks ago) / N
    const pastTick = history[history.length - lookback];
    const momentum = (tick.ask - pastTick.ask) / lookback;

    if (momentum > threshold) {
      return { action: 'BUY_YES', size, reason: `Momentum +${momentum.toFixed(4)} > ${threshold}` };
    }

    if (momentum < -threshold) {
      return { action: 'BUY_NO', size, reason: `Momentum ${momentum.toFixed(4)} < -${threshold}` };
    }

    return null;
  },
};
