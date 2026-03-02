const { v4: uuidv4 } = require('uuid');

/**
 * Immutable trade record.
 */
class Trade {
  constructor({ tickIndex, timestamp, action, side, size, price, reason, balanceBefore, balanceAfter }) {
    this.id = uuidv4();
    this.tickIndex = tickIndex;
    this.timestamp = timestamp;
    this.action = action;       // 'BUY' | 'SELL'
    this.side = side;           // 'YES' | 'NO'
    this.size = size;           // number of shares
    this.price = price;         // price per share (0-1)
    this.cost = price * size;   // total cost
    this.reason = reason || '';
    this.balanceBefore = balanceBefore;
    this.balanceAfter = balanceAfter;
    this.settledAt = null;      // filled on settlement
    this.settledPnL = null;     // filled on settlement

    Object.freeze(this);
  }

  toJSON() {
    return {
      id: this.id,
      tickIndex: this.tickIndex,
      timestamp: this.timestamp,
      action: this.action,
      side: this.side,
      size: this.size,
      price: this.price,
      cost: this.cost,
      reason: this.reason,
      balanceBefore: this.balanceBefore,
      balanceAfter: this.balanceAfter,
      settledAt: this.settledAt,
      settledPnL: this.settledPnL,
    };
  }
}

module.exports = { Trade };
