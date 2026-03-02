/**
 * Example Custom Strategy
 *
 * This file demonstrates how to write a custom strategy for the Poly Backtester.
 * Place .js files in this /strategies directory and they'll be auto-loaded.
 *
 * STRATEGY CONTRACT:
 *
 * Required exports:
 *   name      - string: unique strategy name
 *   onTick    - function(tick, history, portfolio, state, ctx): signal or null
 *
 * Optional exports:
 *   description - string: what the strategy does
 *   params      - object: configurable parameters with defaults
 *   init        - function(ctx): initial state object
 *   onSettle    - function(outcome, portfolio, state, ctx): post-settlement logic
 *
 * TICK OBJECT:
 *   { t, sr, bid, ask, bidDelta, askDelta, bidVega, askVega }
 *   - t: unix timestamp (seconds)
 *   - sr: seconds remaining in the 5-min market window
 *   - bid: NO/Down price (0-1)
 *   - ask: YES/Up price (0-1)
 *   - bid + ask ≈ 1.0
 *
 * SIGNAL OBJECT (returned from onTick):
 *   { action: 'BUY_YES' | 'BUY_NO' | 'SELL', size: number, reason: string }
 *   - BUY_YES: buy shares that pay $1 if market resolves YES (up)
 *   - BUY_NO: buy shares that pay $1 if market resolves NO (down)
 *   - SELL: sell an existing position (optionally specify positionId)
 *   - Return null to do nothing (hold)
 *
 * PORTFOLIO SNAPSHOT (read-only):
 *   { balance, positions, positionCount, realizedPnL, unrealizedPnL }
 *
 * CONTEXT:
 *   { asset, title, marketId, params, tickIndex }
 *
 * IMPORTANT: The `history` array is guarded — accessing future ticks will throw
 * a LookaheadViolation and taint the backtest audit. Only access indices 0..current.
 */

module.exports = {
  name: 'Early Bird',
  description: 'Simple strategy: buy YES early if ask < 0.55 (underpriced), bet on upward resolution.',

  params: {
    entryPrice: { type: 'number', default: 0.55, min: 0.01, max: 0.99, desc: 'Max ask price to enter' },
    size: { type: 'number', default: 10, min: 1, max: 1000, desc: 'Shares to buy' },
    minSecondsRemaining: { type: 'number', default: 200, min: 0, max: 300, desc: 'Only enter when at least this many seconds remain' },
  },

  init(ctx) {
    return { bought: false };
  },

  onTick(tick, history, portfolio, state, ctx) {
    // Only buy once
    if (state.bought) return null;

    // Only enter early in the market
    if (tick.sr < ctx.params.minSecondsRemaining) return null;

    // Buy YES if ask is below our entry threshold
    if (tick.ask < ctx.params.entryPrice) {
      state.bought = true;
      return {
        action: 'BUY_YES',
        size: ctx.params.size,
        reason: `Ask ${tick.ask.toFixed(4)} < entry threshold ${ctx.params.entryPrice}`,
      };
    }

    return null;
  },

  onSettle(outcome, portfolio, state, ctx) {
    // Optional: log or analyze after settlement
  },
};
