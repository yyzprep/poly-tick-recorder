/**
 * TradeLog — Immutable append-only trade log for audit purposes.
 */
class TradeLog {
  constructor() {
    this._entries = [];
    this._sealed = false;
  }

  append(entry) {
    if (this._sealed) throw new Error('TradeLog is sealed — cannot append after finalization');
    const frozen = Object.freeze({
      seq: this._entries.length,
      ...entry,
      loggedAt: Date.now(),
    });
    this._entries.push(frozen);
    return frozen;
  }

  seal() {
    this._sealed = true;
    Object.freeze(this._entries);
  }

  get entries() {
    return [...this._entries];
  }

  get length() {
    return this._entries.length;
  }

  toJSON() {
    return this._entries.map(e => ({ ...e }));
  }
}

module.exports = { TradeLog };
