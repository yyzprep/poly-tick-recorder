const { v4: uuidv4 } = require('uuid');
const { TickCursor } = require('./TickCursor');
const { Portfolio } = require('./Portfolio');
const { computeStats } = require('../utils/stats');
const { hashRun } = require('../utils/hash');
const { getSession, getSessionTicks, getSessionBlob } = require('../data/db');

/**
 * Core backtester — runs a strategy tick-by-tick against a session.
 */
class Backtester {
  constructor({ strategy, params = {}, marketId, balance = 100, onTick = null }) {
    this.runId = uuidv4();
    this.strategy = strategy;
    this.params = params;
    this.marketId = marketId;
    this.initialBalance = balance;
    this.onTick = onTick; // callback for live updates: (event) => {}
    this._aborted = false;
  }

  abort() {
    this._aborted = true;
  }

  async run() {
    const session = getSession(this.marketId);
    if (!session) throw new Error(`Session not found: ${this.marketId}`);

    const ticks = getSessionTicks(this.marketId);
    if (!ticks || ticks.length === 0) throw new Error(`No ticks for session: ${this.marketId}`);

    const cursor = new TickCursor(ticks);
    const portfolio = new Portfolio(this.initialBalance);

    const ctx = {
      asset: session.asset,
      title: session.title,
      marketId: this.marketId,
      params: Object.freeze({ ...this.params }),
      tickIndex: 0,
    };

    // Initialize strategy
    let state = {};
    if (typeof this.strategy.init === 'function') {
      state = this.strategy.init(ctx) || {};
    }

    const guardedHistory = cursor.guardedProxy();
    const tradeLog = [];
    const equityCurve = [];
    const startTime = Date.now();

    // Tick-by-tick simulation
    while (cursor.advance()) {
      if (this._aborted) break;

      const tick = cursor.current();
      ctx.tickIndex = cursor.index;

      const portfolioSnap = portfolio.snapshot(tick.bid, tick.ask);

      // Call strategy
      let signal = null;
      try {
        signal = this.strategy.onTick(tick, guardedHistory, portfolioSnap, state, ctx);
      } catch (err) {
        if (err.name === 'LookaheadViolation') {
          // Already recorded in cursor.violations, continue
        } else {
          throw err;
        }
      }

      // Execute signal
      if (signal && signal.action) {
        const tradeResult = this._executeSignal(signal, tick, cursor.index, portfolio);
        if (tradeResult.success) {
          tradeLog.push(tradeResult.trade.toJSON());
        }
      }

      // Record equity point
      const equity = portfolio.balance + portfolio.positions.reduce(
        (sum, p) => sum + ((p.side === 'YES' ? tick.ask : tick.bid) * p.size), 0
      );
      equityCurve.push({ t: tick.t, sr: tick.sr, equity, balance: portfolio.balance });

      // Live update callback
      if (this.onTick) {
        this.onTick({
          type: 'tick',
          data: {
            runId: this.runId,
            tickIndex: cursor.index,
            totalTicks: cursor.totalLength,
            tick,
            portfolio: portfolioSnap,
            equity,
            trade: tradeLog.length > 0 ? tradeLog[tradeLog.length - 1] : null,
            tradeCount: tradeLog.length,
          },
        });
      }

      // Yield to event loop every 100 ticks for WebSocket delivery
      if (cursor.index % 100 === 0) {
        await new Promise(r => setImmediate(r));
      }
    }

    // Determine outcome from final tick
    const finalTick = ticks[ticks.length - 1];
    const outcome = finalTick.ask > 0.5 ? 'YES' : 'NO';

    // Settle all open positions
    const settlements = portfolio.settle(outcome);

    // Call strategy onSettle
    if (typeof this.strategy.onSettle === 'function') {
      try {
        this.strategy.onSettle(outcome, portfolio.snapshot(), state, ctx);
      } catch (_) { /* non-critical */ }
    }

    // Compute metrics
    const metrics = computeStats({
      trades: tradeLog,
      equityCurve,
      initialBalance: this.initialBalance,
      finalBalance: portfolio.balance,
      outcome,
    });

    // Compute audit hash
    const blob = getSessionBlob(this.marketId);
    const auditHash = hashRun({
      strategyName: this.strategy.name,
      strategySource: this.strategy._sourceHash || '',
      params: this.params,
      marketId: this.marketId,
      ticksBlobHash: blob,
      initialBalance: this.initialBalance,
    });

    const result = {
      runId: this.runId,
      marketId: this.marketId,
      session: {
        asset: session.asset,
        title: session.title,
        endTime: session.end_time,
        tickCount: session.tick_count,
      },
      strategy: this.strategy.name,
      params: this.params,
      initialBalance: this.initialBalance,
      finalBalance: portfolio.balance,
      outcome,
      metrics,
      trades: tradeLog,
      settlements,
      equityCurve,
      audit: {
        hash: auditHash,
        tainted: cursor.tainted,
        violations: cursor.violations.map(v => v.message),
        tradeCount: tradeLog.length,
        ticksProcessed: cursor.index + 1,
        durationMs: Date.now() - startTime,
      },
    };

    return result;
  }

  _executeSignal(signal, tick, tickIndex, portfolio) {
    const { action, size, reason, positionId } = signal;

    if (!size || size <= 0) {
      return { success: false, error: 'Invalid size' };
    }

    switch (action) {
      case 'BUY_YES':
        return portfolio.buyYes({
          price: tick.ask,
          size,
          tickIndex,
          timestamp: tick.t,
          reason,
        });

      case 'BUY_NO':
        return portfolio.buyNo({
          price: tick.bid,
          size,
          tickIndex,
          timestamp: tick.t,
          reason,
        });

      case 'SELL': {
        if (!positionId) {
          // Sell first open position if no ID specified
          if (portfolio.positions.length === 0) {
            return { success: false, error: 'No open positions to sell' };
          }
          const pos = portfolio.positions[0];
          const exitPrice = pos.side === 'YES' ? tick.ask : tick.bid;
          return portfolio.sell({
            positionId: pos.id,
            price: exitPrice,
            tickIndex,
            timestamp: tick.t,
            reason,
          });
        }
        const pos = portfolio.positions.find(p => p.id === positionId);
        if (!pos) return { success: false, error: `Position ${positionId} not found` };
        const exitPrice = pos.side === 'YES' ? tick.ask : tick.bid;
        return portfolio.sell({
          positionId,
          price: exitPrice,
          tickIndex,
          timestamp: tick.t,
          reason,
        });
      }

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  }
}

module.exports = { Backtester };
