/**
 * TickCursor — Anti-lookahead tick iterator.
 * Wraps a tick array and only exposes data up to the current position.
 * Uses Object.freeze and Proxy to guarantee no future data access.
 */
class LookaheadViolation extends Error {
  constructor(requestedIndex, currentIndex) {
    super(`Lookahead violation: tried to access tick[${requestedIndex}] but cursor is at ${currentIndex}`);
    this.name = 'LookaheadViolation';
    this.requestedIndex = requestedIndex;
    this.currentIndex = currentIndex;
  }
}

class TickCursor {
  constructor(ticks) {
    this._ticks = ticks;
    this._index = -1; // before first tick
    this._violations = [];
  }

  get length() {
    // Only expose how many ticks we've seen so far, not total
    return this._index + 1;
  }

  get totalLength() {
    // Internal use only — never exposed to strategies
    return this._ticks.length;
  }

  get index() {
    return this._index;
  }

  get done() {
    return this._index >= this._ticks.length - 1;
  }

  get violations() {
    return [...this._violations];
  }

  get tainted() {
    return this._violations.length > 0;
  }

  /** Advance to next tick. Returns false if at end. */
  advance() {
    if (this._index >= this._ticks.length - 1) return false;
    this._index++;
    return true;
  }

  /** Get current tick (frozen copy) */
  current() {
    if (this._index < 0) return null;
    return Object.freeze({ ...this._ticks[this._index] });
  }

  /** Get frozen history array — all ticks from 0 to current index (inclusive) */
  history() {
    if (this._index < 0) return Object.freeze([]);
    const slice = this._ticks.slice(0, this._index + 1).map(t => Object.freeze({ ...t }));
    return Object.freeze(slice);
  }

  /**
   * Create a guarded proxy of the tick array that throws on future access.
   * This is given to strategies instead of the raw array.
   */
  guardedProxy() {
    const cursor = this;
    return new Proxy([], {
      get(target, prop, receiver) {
        if (prop === 'length') return cursor._index + 1;
        if (prop === Symbol.iterator) {
          return function* () {
            for (let i = 0; i <= cursor._index; i++) {
              yield Object.freeze({ ...cursor._ticks[i] });
            }
          };
        }
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const idx = parseInt(prop, 10);
          if (idx > cursor._index) {
            const v = new LookaheadViolation(idx, cursor._index);
            cursor._violations.push(v);
            throw v;
          }
          if (idx < 0 || idx >= cursor._ticks.length) return undefined;
          return Object.freeze({ ...cursor._ticks[idx] });
        }
        // Allow safe array methods on the visible slice
        if (prop === 'slice' || prop === 'map' || prop === 'filter' || prop === 'reduce' ||
            prop === 'forEach' || prop === 'find' || prop === 'findIndex' || prop === 'some' ||
            prop === 'every' || prop === 'indexOf' || prop === 'includes') {
          const visible = cursor._ticks.slice(0, cursor._index + 1).map(t => Object.freeze({ ...t }));
          return visible[prop].bind(visible);
        }
        return Reflect.get(target, prop, receiver);
      },
      has(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          return parseInt(prop, 10) <= cursor._index;
        }
        return Reflect.has(target, prop);
      },
      ownKeys() {
        const keys = [];
        for (let i = 0; i <= cursor._index; i++) keys.push(String(i));
        keys.push('length');
        return keys;
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop === 'length') {
          return { value: cursor._index + 1, writable: false, enumerable: false, configurable: false };
        }
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const idx = parseInt(prop, 10);
          if (idx <= cursor._index) {
            return { value: Object.freeze({ ...cursor._ticks[idx] }), writable: false, enumerable: true, configurable: true };
          }
        }
        return undefined;
      }
    });
  }
}

module.exports = { TickCursor, LookaheadViolation };
