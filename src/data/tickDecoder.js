const { decompress } = require('fzstd');
const { decode } = require('@msgpack/msgpack');

/**
 * Decode ticks_blob: Zstandard-compressed MessagePack → array of tick objects.
 * Each raw tick is [timestamp, secondsRemaining, bid, ask, bidDelta, askDelta, bidVega, askVega]
 */
function decodeTicks(blob) {
  if (!blob || !Buffer.isBuffer(blob)) {
    throw new Error('Invalid ticks_blob: expected a Buffer');
  }

  const decompressed = decompress(new Uint8Array(blob));
  const raw = decode(decompressed);

  if (!Array.isArray(raw)) {
    throw new Error('Invalid ticks_blob: decoded data is not an array');
  }

  return raw.map((tick, i) => {
    if (!Array.isArray(tick) || tick.length < 4) {
      throw new Error(`Invalid tick at index ${i}: expected array of at least 4 elements`);
    }
    return {
      t: tick[0],           // unix timestamp (seconds)
      sr: tick[1],          // seconds remaining
      bid: tick[2],         // NO/Down price (0-1)
      ask: tick[3],         // YES/Up price (0-1)
      bidDelta: tick[4] ?? 0,
      askDelta: tick[5] ?? 0,
      bidVega: tick[6] ?? 0,
      askVega: tick[7] ?? 0,
    };
  });
}

module.exports = { decodeTicks };
