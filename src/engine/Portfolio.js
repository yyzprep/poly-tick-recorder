const { v4: uuidv4 } = require('uuid');
const { Trade } = require('./Trade');

/**
 * Portfolio — manages balance, positions, and trades for a binary prediction market.
 *
 * In a binary market:
 * - YES shares cost `ask` and pay $1 if outcome=YES, $0 if outcome=NO
 * - NO shares cost `bid` and pay $1 if outcome=NO, $0 if outcome=YES
 * - bid + ask ≈ 1.0
 */
class Portfolio {
  constructor(initialBalance = 100) {
    this.initialBalance = initialBalance;
    this.balance = initialBalance;
    this.positions = [];  // open positions
    this.closedPositions = []; // settled/sold positions
    this.trades = [];
  }

  /** Buy YES shares at the current ask price */
  buyYes({ price, size, tickIndex, timestamp, reason }) {
    return this._buy('YES', price, size, tickIndex, timestamp, reason);
  }

  /** Buy NO shares at the current bid price */
  buyNo({ price, size, tickIndex, timestamp, reason }) {
    return this._buy('NO', price, size, tickIndex, timestamp, reason);
  }

  _buy(side, price, size, tickIndex, timestamp, reason) {
    const cost = price * size;
    if (cost > this.balance + 0.0001) {
      return { success: false, error: `Insufficient balance: need ${cost.toFixed(4)}, have ${this.balance.toFixed(4)}` };
    }

    const balanceBefore = this.balance;
    this.balance -= cost;

    const position = {
      id: uuidv4(),
      side,
      size,
      entryPrice: price,
      entryTick: tickIndex,
      entryTimestamp: timestamp,
      cost,
    };
    this.positions.push(position);

    const trade = new Trade({
      tickIndex,
      timestamp,
      action: 'BUY',
      side,
      size,
      price,
      reason,
      balanceBefore,
      balanceAfter: this.balance,
    });
    this.trades.push(trade);

    return { success: true, trade, position };
  }

  /** Sell a position back at current market price */
  sell({ positionId, price, tickIndex, timestamp, reason }) {
    const idx = this.positions.findIndex(p => p.id === positionId);
    if (idx === -1) {
      return { success: false, error: `Position ${positionId} not found` };
    }

    const position = this.positions[idx];
    const proceeds = price * position.size;
    const balanceBefore = this.balance;
    this.balance += proceeds;

    this.positions.splice(idx, 1);
    this.closedPositions.push({
      ...position,
      exitPrice: price,
      exitTick: tickIndex,
      exitTimestamp: timestamp,
      proceeds,
      pnl: proceeds - position.cost,
    });

    const trade = new Trade({
      tickIndex,
      timestamp,
      action: 'SELL',
      side: position.side,
      size: position.size,
      price,
      reason,
      balanceBefore,
      balanceAfter: this.balance,
    });
    this.trades.push(trade);

    return { success: true, trade };
  }

  /**
   * Settle all open positions at market end.
   * outcome: 'YES' or 'NO'
   * YES shares pay $1 if YES, $0 if NO. NO shares pay $1 if NO, $0 if YES.
   */
  settle(outcome) {
    const results = [];
    const positionsToSettle = [...this.positions];
    this.positions = [];

    for (const pos of positionsToSettle) {
      const payout = (pos.side === outcome) ? pos.size * 1.0 : 0;
      const pnl = payout - pos.cost;

      this.balance += payout;
      this.closedPositions.push({
        ...pos,
        exitPrice: pos.side === outcome ? 1.0 : 0.0,
        exitTick: null,
        exitTimestamp: null,
        proceeds: payout,
        pnl,
        settled: true,
        outcome,
      });

      results.push({ positionId: pos.id, side: pos.side, cost: pos.cost, payout, pnl });
    }

    return results;
  }

  /** Compute unrealized PnL based on current bid/ask */
  unrealizedPnL(currentBid, currentAsk) {
    let total = 0;
    for (const pos of this.positions) {
      const exitPrice = pos.side === 'YES' ? currentBid : currentAsk; // what we'd get selling now
      total += (exitPrice * pos.size) - pos.cost;
    }
    return total;
  }

  /** Total realized PnL from all closed positions */
  get realizedPnL() {
    return this.closedPositions.reduce((sum, p) => sum + p.pnl, 0);
  }

  get totalPnL() {
    return this.balance - this.initialBalance + this.positions.reduce((sum, p) => sum + p.cost, 0) - this.initialBalance;
  }

  /** Read-only snapshot for strategies (no methods that modify state) */
  snapshot(currentBid = 0, currentAsk = 0) {
    return Object.freeze({
      balance: this.balance,
      initialBalance: this.initialBalance,
      positions: Object.freeze(this.positions.map(p => Object.freeze({ ...p }))),
      positionCount: this.positions.length,
      realizedPnL: this.realizedPnL,
      unrealizedPnL: this.unrealizedPnL(currentBid, currentAsk),
      tradeCount: this.trades.length,
    });
  }
}

module.exports = { Portfolio };
