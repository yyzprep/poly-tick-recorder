const path = require('path');
const Database = require('better-sqlite3');
const { decodeTicks } = require('./tickDecoder');

const DB_PATH = path.join(__dirname, '..', '..', 'collected_sessions.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');
  }
  return db;
}

/** List sessions with filtering and pagination */
function listSessions({ asset, search, startDate, endDate, page = 1, limit = 50, sortBy = 'end_time', sortDir = 'DESC' } = {}) {
  const conditions = [];
  const params = {};

  if (asset) {
    conditions.push('asset = @asset');
    params.asset = asset;
  }
  if (search) {
    conditions.push('title LIKE @search');
    params.search = `%${search}%`;
  }
  if (startDate) {
    conditions.push('end_time >= @startDate');
    params.startDate = startDate;
  }
  if (endDate) {
    conditions.push('end_time <= @endDate');
    params.endDate = endDate;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const allowedSorts = ['end_time', 'asset', 'tick_count', 'span', 'title'];
  const col = allowedSorts.includes(sortBy) ? sortBy : 'end_time';
  const dir = sortDir === 'ASC' ? 'ASC' : 'DESC';

  const countRow = getDb()
    .prepare(`SELECT COUNT(*) as total FROM sessions ${where}`)
    .get(params);

  const offset = (page - 1) * limit;
  params.limit = limit;
  params.offset = offset;

  const rows = getDb()
    .prepare(`SELECT market_id, asset, slug, title, end_time, first_sr, last_sr, span, tick_count, collected_at FROM sessions ${where} ORDER BY ${col} ${dir} LIMIT @limit OFFSET @offset`)
    .all(params);

  return {
    sessions: rows,
    total: countRow.total,
    page,
    limit,
    totalPages: Math.ceil(countRow.total / limit),
  };
}

/** Get single session metadata (no blob) */
function getSession(marketId) {
  return getDb()
    .prepare('SELECT market_id, asset, slug, title, end_time, first_sr, last_sr, span, tick_count, collected_at FROM sessions WHERE market_id = ?')
    .get(marketId);
}

/** Get decoded ticks for a session */
function getSessionTicks(marketId) {
  const row = getDb()
    .prepare('SELECT ticks_blob, tick_count FROM sessions WHERE market_id = ?')
    .get(marketId);

  if (!row) return null;
  if (!row.ticks_blob) return [];

  const ticks = decodeTicks(row.ticks_blob);

  if (ticks.length !== row.tick_count) {
    console.warn(`Tick count mismatch for ${marketId}: expected ${row.tick_count}, got ${ticks.length}`);
  }

  return ticks;
}

/** Get raw blob for hashing (audit reproducibility) */
function getSessionBlob(marketId) {
  const row = getDb()
    .prepare('SELECT ticks_blob FROM sessions WHERE market_id = ?')
    .get(marketId);
  return row ? row.ticks_blob : null;
}

/** Aggregate stats */
function getSessionStats() {
  const d = getDb();
  const byAsset = d.prepare('SELECT asset, COUNT(*) as count FROM sessions GROUP BY asset ORDER BY count DESC').all();
  const totals = d.prepare('SELECT COUNT(*) as total, MIN(end_time) as earliest, MAX(end_time) as latest, AVG(tick_count) as avgTicks, SUM(tick_count) as totalTicks FROM sessions').get();
  return { byAsset, ...totals };
}

/** Get all distinct assets */
function getAssets() {
  return getDb()
    .prepare('SELECT DISTINCT asset FROM sessions ORDER BY asset')
    .all()
    .map(r => r.asset);
}

module.exports = { listSessions, getSession, getSessionTicks, getSessionBlob, getSessionStats, getAssets };
