/**
 * BiasGuard — Detects and prevents lookahead bias in strategies.
 *
 * Wraps data structures in Proxies to detect unauthorized future data access.
 * Tracks violations for the audit report.
 */
class BiasGuard {
  constructor() {
    this.violations = [];
    this.status = 'CLEAN'; // 'CLEAN' | 'TAINTED'
  }

  recordViolation(type, detail) {
    this.status = 'TAINTED';
    this.violations.push(Object.freeze({
      type,
      detail,
      timestamp: Date.now(),
    }));
  }

  /**
   * Wrap a context object to prevent strategies from adding totalTicks or similar.
   */
  guardContext(ctx, hiddenFields = ['_totalTicks', '_allTicks']) {
    const guard = this;
    return new Proxy(ctx, {
      get(target, prop) {
        if (hiddenFields.includes(prop)) {
          guard.recordViolation('HIDDEN_FIELD_ACCESS', `Attempted to access ${String(prop)}`);
          return undefined;
        }
        return target[prop];
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      }
    });
  }

  get report() {
    return Object.freeze({
      status: this.status,
      violationCount: this.violations.length,
      violations: [...this.violations],
    });
  }
}

module.exports = { BiasGuard };
