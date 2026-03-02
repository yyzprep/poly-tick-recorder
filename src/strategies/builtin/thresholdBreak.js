/**
 * Threshold Break — Enter when price crosses a configured threshold level.
 * Buy YES when ask breaks above the upper threshold, NO when below lower threshold.
 */
module.exports = {
  name: 'Threshold Break',
  description: 'Enters when ask price crosses above/below configurable threshold levels. Simple level-based entry.',
  params: {
    upperThreshold: { type: 'number', default: 0.65, min: 0.5, max: 0.99, desc: 'Buy YES when ask crosses above this' },
    lowerThreshold: { type: 'number', default: 0.35, min: 0.01, max: 0.5, desc: 'Buy NO when ask crosses below this' },
    size: { type: 'number', default: 10, min: 1, max: 1000, desc: 'Position size (shares)' },
    cooldown: { type: 'number', default: 30, min: 0, max: 500, desc: 'Minimum ticks between entries' },
    maxPositions: { type: 'number', default: 3, min: 1, max: 10, desc: 'Maximum concurrent positions' },
  },

  init(ctx) {
    return { lastEntryTick: -Infinity };
  },

  onTick(tick, history, portfolio, state, ctx) {
    const { upperThreshold, lowerThreshold, size, cooldown, maxPositions } = ctx.params;

    if (history.length < 2) return null;
    if (portfolio.positionCount >= maxPositions) return null;
    if (ctx.tickIndex - state.lastEntryTick < cooldown) return null;

    const prevTick = history[history.length - 2];

    // Crossed above upper threshold
    if (prevTick.ask <= upperThreshold && tick.ask > upperThreshold) {
      state.lastEntryTick = ctx.tickIndex;
      return { action: 'BUY_YES', size, reason: `Ask broke above ${upperThreshold} (${prevTick.ask.toFixed(4)} → ${tick.ask.toFixed(4)})` };
    }

    // Crossed below lower threshold
    if (prevTick.ask >= lowerThreshold && tick.ask < lowerThreshold) {
      state.lastEntryTick = ctx.tickIndex;
      return { action: 'BUY_NO', size, reason: `Ask broke below ${lowerThreshold} (${prevTick.ask.toFixed(4)} → ${tick.ask.toFixed(4)})` };
    }

    return null;
  },
};
