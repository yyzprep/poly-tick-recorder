"""
Polymarket Multi-Asset Tick Data Recorder
=========================================
Captures every websocket event from Polymarket 5-min crypto prediction markets
(BTC, ETH, SOL, XRP) plus Binance reference prices. Optimized for storage and
designed for exact tick-by-tick replay.

Deploy to Railway for 24/7 recording, with S3 sync for local data access.

Usage:
    python tick_recorder.py                    # normal recording
    python tick_recorder.py --migrate          # import collected_sessions.db into tick_data.db
    python tick_recorder.py --sync             # pull Parquet from S3 into local tick_data.db
"""

import asyncio
import threading
import time
import signal
import sys
import os
import struct
import logging
import argparse
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from zlib import crc32

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

import websockets
import aiohttp
import orjson
import msgpack
import zstandard as zstd

try:
    import pyarrow as pa
    import pyarrow.parquet as pq
    HAS_PARQUET = True
except ImportError:
    HAS_PARQUET = False

try:
    import boto3
    HAS_S3 = True
except ImportError:
    HAS_S3 = False

try:
    import uvloop
    HAS_UVLOOP = True
except ImportError:
    HAS_UVLOOP = False

from rich.console import Console
from rich.live import Live
from rich.text import Text

# ==========================================
# CONFIGURATION (env vars for Railway)
# ==========================================
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "tick_data"))
DB_NAME = os.environ.get("DB_NAME", "tick_data.db")
DB_PATH = os.path.join(DATA_DIR, DB_NAME)
ASSET_LIST = os.environ.get("ASSETS", "BTC,ETH,SOL,XRP").split(",")
ARCHIVAL_INTERVAL = int(os.environ.get("ARCHIVAL_INTERVAL", "1800"))
ARCHIVAL_AGE = int(os.environ.get("ARCHIVAL_AGE", "3600"))

# S3 config (optional)
S3_BUCKET = os.environ.get("S3_BUCKET", "")
S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "")
S3_ACCESS_KEY = os.environ.get("S3_ACCESS_KEY", "")
S3_SECRET_KEY = os.environ.get("S3_SECRET_KEY", "")
S3_PREFIX = os.environ.get("S3_PREFIX", "polymarket-ticks/")

# Migration source
LEGACY_DB = os.environ.get("LEGACY_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "collected_sessions.db"))

# Intervals
DISCOVERY_INTERVAL = 2.0        # seconds between Gamma API polls
WRITER_INTERVAL = 2.0           # seconds between SQLite drain cycles
PING_INTERVAL = 10              # Polymarket WS ping interval
STATUS_INTERVAL = 30            # console stats interval
WINDOW_SECONDS = 300            # 5-min windows

# URLs
GAMMA_API = "https://gamma-api.polymarket.com/markets"
POLY_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
BINANCE_ENDPOINTS = [
    "wss://stream.binance.com:9443/stream?streams={streams}",
    "wss://stream.binance.us:9443/stream?streams={streams}",
]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-5s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("recorder")

# ==========================================
# ASSET STATE
# ==========================================
SLUG_PREFIX = {
    "BTC": "btc-updown-5m-",
    "ETH": "eth-updown-5m-",
    "SOL": "sol-updown-5m-",
    "XRP": "xrp-updown-5m-",
}
BINANCE_SYMBOL = {
    "BTC": "btcusdt",
    "ETH": "ethusdt",
    "SOL": "solusdt",
    "XRP": "xrpusdt",
}
ASSET_INT = {"BTC": 0, "ETH": 1, "SOL": 2, "XRP": 3}

@dataclass
class AssetState:
    asset: str
    market_id: str = ""
    win_id: int = 0
    title: str = ""
    token_id_up: str = ""
    token_id_down: str = ""
    slug: str = ""
    end_time: float = 0.0
    seconds_remaining: float = 0.0
    # Order book state (live, mutable)
    up_bids: dict = field(default_factory=dict)
    up_asks: dict = field(default_factory=dict)
    down_bids: dict = field(default_factory=dict)
    down_asks: dict = field(default_factory=dict)
    up_best_bid: float = 0.0
    up_best_ask: float = 0.0
    down_best_bid: float = 0.0
    down_best_ask: float = 0.0
    # For book dedup
    _last_up_crc: int = 0
    _last_down_crc: int = 0

# Global asset states
assets: dict[str, AssetState] = {}
# token_id -> (AssetState, "up"|"down") routing table
token_route: dict[str, tuple[AssetState, str]] = {}

# Shared events
resubscribe_event = asyncio.Event()
shutdown_event = threading.Event()

# ==========================================
# ZSTD COMPRESSOR (reusable, thread-safe at level 1)
# ==========================================
_zstd_cctx = zstd.ZstdCompressor(level=1)
_zstd_dctx = zstd.ZstdDecompressor()

def compress_book(bids: dict, asks: dict) -> bytes:
    """Encode order book as msgpack then zstd-compress. Returns bytes."""
    raw = msgpack.packb({
        "b": [[p, s] for p, s in bids.items()],
        "a": [[p, s] for p, s in asks.items()],
    })
    return _zstd_cctx.compress(raw)

def decompress_book(blob: bytes) -> dict:
    """Decompress and decode a book blob."""
    return msgpack.unpackb(_zstd_dctx.decompress(blob, max_output_size=1 << 20), raw=False)

# ==========================================
# TICK DATA RECORDER (double-buffered SQLite writer)
# ==========================================
class TickDataRecorder:
    """Records all market events to SQLite via a background thread.

    The event loop only calls list.append() (nanoseconds).
    A dedicated writer thread wakes every 2s, swaps buffers, and writes to SQLite.
    """

    def __init__(self, db_path: str):
        self._db_path = db_path
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        # Double buffers
        self._lock = threading.Lock()
        self._buf_ticks: list = []
        self._buf_books: list = []
        self._buf_ref: list = []
        self._buf_windows: list = []
        self._buf_sessions: list = []
        self._stop = threading.Event()
        # Stats (atomic-ish via GIL)
        self.total_ticks = 0
        self.total_books = 0
        self.total_ref = 0
        self.total_deduped = 0
        self.buffer_depth = 0
        # Create tables then start writer
        conn = sqlite3.connect(db_path)
        self._setup_pragmas(conn)
        self._create_tables(conn)
        # Win ID allocation: load existing mappings so we resume numbering
        self._win_id_map: dict[str, int] = {}
        self._next_win_id = 1
        for row_id, mid in conn.execute("SELECT id, market_id FROM market_windows"):
            self._win_id_map[mid] = row_id
            self._next_win_id = max(self._next_win_id, row_id + 1)
        conn.close()
        self._thread = threading.Thread(target=self._writer_loop, daemon=True)
        self._thread.start()

    def _setup_pragmas(self, conn):
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA page_size=8192")
        conn.execute("PRAGMA cache_size=-65536")
        conn.execute("PRAGMA mmap_size=268435456")
        conn.execute("PRAGMA temp_store=MEMORY")

    def _migrate_schema(self, conn):
        """Detect old TEXT-based schema and drop/recreate affected tables."""
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='price_ticks'")
        if not cursor.fetchone():
            return  # fresh DB, nothing to migrate
        cols = {row[1] for row in conn.execute("PRAGMA table_info(price_ticks)")}
        if "win_id" in cols:
            return  # already new schema
        log.warning("Old TEXT-based schema detected — dropping tick tables for new integer schema")
        for tbl in ("price_ticks", "book_snapshots", "ref_prices", "recorder_status"):
            conn.execute(f"DROP TABLE IF EXISTS {tbl}")
        # Drop old indexes too
        for idx in ("idx_ticks_asset_ts", "idx_ticks_market_ts", "idx_books_asset_ts", "idx_ref_asset_ts"):
            conn.execute(f"DROP INDEX IF EXISTS {idx}")
        conn.commit()

    def _create_tables(self, conn):
        # Detect old TEXT-based schema and drop/recreate if needed
        self._migrate_schema(conn)
        # market_windows: full metadata (small table, TEXT is fine)
        conn.execute("""CREATE TABLE IF NOT EXISTS market_windows (
            id INTEGER PRIMARY KEY,
            asset TEXT NOT NULL,
            market_id TEXT NOT NULL,
            title TEXT,
            token_id_up TEXT,
            token_id_down TEXT,
            slug TEXT,
            start_time REAL,
            end_time REAL,
            UNIQUE(market_id)
        )""")
        # price_ticks: OPTIMIZED — integers replace repeated TEXT strings
        # win_id  -> market_windows.id (4 bytes vs 66-byte market_id)
        # et      -> 0=price_change, 1=last_trade_price (1 byte vs 12-20 byte TEXT)
        # tk      -> 0=down, 1=up token (1 byte vs 77-byte asset_id)
        # sd      -> 0=BUY, 1=SELL, NULL=trade (1 byte vs 3-4 byte TEXT)
        # ~50 bytes/row instead of ~206 bytes/row (4x smaller)
        conn.execute("""CREATE TABLE IF NOT EXISTS price_ticks (
            id INTEGER PRIMARY KEY,
            ts REAL NOT NULL,
            server_ts REAL,
            win_id INTEGER NOT NULL,
            et INTEGER NOT NULL,
            tk INTEGER NOT NULL,
            sd INTEGER,
            price REAL,
            size REAL,
            best_bid REAL,
            best_ask REAL
        )""")
        # book_snapshots: OPTIMIZED — win_id + tk replace market_id + asset_id
        conn.execute("""CREATE TABLE IF NOT EXISTS book_snapshots (
            id INTEGER PRIMARY KEY,
            ts REAL NOT NULL,
            server_ts REAL,
            win_id INTEGER NOT NULL,
            tk INTEGER NOT NULL,
            data BLOB NOT NULL
        )""")
        # ref_prices: OPTIMIZED — asset as integer (0=BTC,1=ETH,2=SOL,3=XRP)
        conn.execute("""CREATE TABLE IF NOT EXISTS ref_prices (
            id INTEGER PRIMARY KEY,
            ts REAL NOT NULL,
            a INTEGER NOT NULL,
            price REAL NOT NULL,
            qty REAL
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS sessions (
            market_id TEXT PRIMARY KEY,
            asset TEXT,
            slug TEXT,
            title TEXT,
            end_time REAL,
            first_sr REAL,
            last_sr REAL,
            span REAL,
            tick_count INTEGER,
            ticks_json TEXT,
            ticks_blob BLOB,
            collected_at REAL
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS recorder_status (
            ts REAL PRIMARY KEY,
            uptime_s REAL,
            assets_active INTEGER,
            events_per_sec REAL,
            buffer_depth INTEGER,
            ws_reconnects INTEGER,
            last_error TEXT
        )""")
        # Indexes — use integer columns for fast filtering
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ticks_win_ts ON price_ticks(win_id, ts)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_books_win_ts ON book_snapshots(win_id, ts)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ref_a_ts ON ref_prices(a, ts)")
        conn.commit()

    def _writer_loop(self):
        conn = sqlite3.connect(self._db_path)
        self._setup_pragmas(conn)
        while not self._stop.is_set():
            self._stop.wait(timeout=WRITER_INTERVAL)
            self._drain(conn)
        # Final drain on shutdown
        self._drain(conn)
        conn.close()
        log.info("Writer thread stopped cleanly.")

    def _drain(self, conn):
        with self._lock:
            ticks = self._buf_ticks
            books = self._buf_books
            ref = self._buf_ref
            windows = self._buf_windows
            sessions = self._buf_sessions
            self._buf_ticks = []
            self._buf_books = []
            self._buf_ref = []
            self._buf_windows = []
            self._buf_sessions = []
        self.buffer_depth = 0
        if not (ticks or books or ref or windows or sessions):
            return
        try:
            if windows:
                conn.executemany(
                    "INSERT OR IGNORE INTO market_windows (id, asset, market_id, title, token_id_up, token_id_down, slug, start_time, end_time) VALUES (?,?,?,?,?,?,?,?,?)",
                    windows,
                )
            if ticks:
                conn.executemany(
                    "INSERT INTO price_ticks (ts, server_ts, win_id, et, tk, sd, price, size, best_bid, best_ask) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    ticks,
                )
                self.total_ticks += len(ticks)
            if books:
                conn.executemany(
                    "INSERT INTO book_snapshots (ts, server_ts, win_id, tk, data) VALUES (?,?,?,?,?)",
                    books,
                )
                self.total_books += len(books)
            if ref:
                conn.executemany(
                    "INSERT INTO ref_prices (ts, a, price, qty) VALUES (?,?,?,?)",
                    ref,
                )
                self.total_ref += len(ref)
            if sessions:
                conn.executemany(
                    "INSERT OR REPLACE INTO sessions (market_id, asset, slug, title, end_time, first_sr, last_sr, span, tick_count, ticks_json, ticks_blob, collected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    sessions,
                )
            conn.commit()
        except Exception as e:
            log.error(f"SQLite write error: {e}")

    # --- Public API (event loop only — just list.append) ---

    def allocate_win_id(self, market_id: str) -> int:
        """Get or create an integer win_id for a market_id. Thread-safe via GIL."""
        wid = self._win_id_map.get(market_id)
        if wid is None:
            wid = self._next_win_id
            self._next_win_id += 1
            self._win_id_map[market_id] = wid
        return wid

    def record_window(self, win_id, asset, market_id, title, token_up, token_down, slug, start_time, end_time):
        self._buf_windows.append((win_id, asset, market_id, title, token_up, token_down, slug, start_time, end_time))

    def record_tick(self, ts, server_ts, win_id, et, tk, sd, price, size, best_bid, best_ask):
        """et: 0=price_change, 1=last_trade_price. tk: 0=down, 1=up. sd: 0=BUY, 1=SELL, None=trade."""
        self._buf_ticks.append((ts, server_ts, win_id, et, tk, sd, price, size, best_bid, best_ask))
        self.buffer_depth += 1

    def record_book(self, ts, server_ts, win_id, tk, blob):
        self._buf_books.append((ts, server_ts, win_id, tk, blob))
        self.buffer_depth += 1

    def record_ref(self, ts, asset_int, price, qty):
        """asset_int: 0=BTC, 1=ETH, 2=SOL, 3=XRP."""
        self._buf_ref.append((ts, asset_int, price, qty))

    def record_session(self, market_id, asset, slug, title, end_time, first_sr, last_sr, span, tick_count, ticks_blob, collected_at):
        self._buf_sessions.append((market_id, asset, slug, title, end_time, first_sr, last_sr, span, tick_count, None, ticks_blob, collected_at))

    def close(self):
        self._stop.set()
        self._thread.join(timeout=10.0)

    def stats(self):
        return {
            "ticks": self.total_ticks,
            "books": self.total_books,
            "ref": self.total_ref,
            "deduped": self.total_deduped,
            "buf": self.buffer_depth,
        }


# Global recorder instance
recorder: TickDataRecorder | None = None

# ==========================================
# MARKET DISCOVERY
# ==========================================
async def discover_one(session: aiohttp.ClientSession, ast: AssetState, window_start: int):
    """Discover the active market for one asset."""
    slug = f"{SLUG_PREFIX[ast.asset]}{window_start}"
    url = f"{GAMMA_API}?slug={slug}"
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=5)) as resp:
            data = await resp.json()
            market = data[0] if isinstance(data, list) and data else None
            if not market or not market.get("active"):
                return False

            new_id = market["conditionId"]
            tokens = market["clobTokenIds"]
            if isinstance(tokens, str):
                tokens = orjson.loads(tokens)
            outcomes = market.get("outcomes", '["Up","Down"]')
            if isinstance(outcomes, str):
                outcomes = orjson.loads(outcomes)

            up_idx = 0
            for i, name in enumerate(outcomes):
                if name.lower() == "up":
                    up_idx = i
                    break
            down_idx = 1 - up_idx

            end_date_str = market.get("endDate", "")
            if end_date_str:
                end_date = datetime.strptime(end_date_str, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
                end_ts = end_date.timestamp()
            else:
                end_ts = float(window_start + WINDOW_SECONDS)

            changed = ast.market_id != new_id
            if changed:
                ast.market_id = new_id
                ast.title = market.get("question", slug)
                ast.token_id_up = tokens[up_idx]
                ast.token_id_down = tokens[down_idx]
                ast.slug = slug
                ast.end_time = end_ts
                # Clear books
                ast.up_bids.clear()
                ast.up_asks.clear()
                ast.down_bids.clear()
                ast.down_asks.clear()
                ast.up_best_bid = 0.0
                ast.up_best_ask = 0.0
                ast.down_best_bid = 0.0
                ast.down_best_ask = 0.0
                ast._last_up_crc = 0
                ast._last_down_crc = 0
                log.info(f"[{ast.asset}] ROLLOVER -> {ast.title}")

                if recorder:
                    ast.win_id = recorder.allocate_win_id(new_id)
                    recorder.record_window(
                        ast.win_id, ast.asset, new_id, ast.title,
                        ast.token_id_up, ast.token_id_down,
                        slug, float(window_start), end_ts,
                    )

            ast.seconds_remaining = max(end_ts - time.time(), 0)
            return changed
    except Exception as e:
        log.debug(f"[{ast.asset}] Discovery error: {e}")
        return False


async def market_discovery_loop():
    """Polls Gamma API every 2s for all assets concurrently."""
    conn_kwargs = aiohttp.TCPConnector(limit=10, ttl_dns_cache=300)
    async with aiohttp.ClientSession(connector=conn_kwargs) as session:
        while True:
            now_ts = int(time.time())
            window_start = (now_ts // WINDOW_SECONDS) * WINDOW_SECONDS

            results = await asyncio.gather(
                *[discover_one(session, assets[a], window_start) for a in ASSET_LIST],
                return_exceptions=True,
            )

            # Rebuild routing table if any asset changed
            if any(r is True for r in results if not isinstance(r, Exception)):
                token_route.clear()
                for a in ASSET_LIST:
                    ast = assets[a]
                    if ast.token_id_up:
                        token_route[ast.token_id_up] = (ast, "up")
                    if ast.token_id_down:
                        token_route[ast.token_id_down] = (ast, "down")
                resubscribe_event.set()

            # Update seconds_remaining for all assets
            now = time.time()
            for a in ASSET_LIST:
                ast = assets[a]
                if ast.end_time > 0:
                    ast.seconds_remaining = max(ast.end_time - now, 0)

            await asyncio.sleep(DISCOVERY_INTERVAL)

# ==========================================
# POLYMARKET WEBSOCKET WORKER
# ==========================================
_ws_reconnects = 0

async def _ping_loop(ws):
    """Send PING every 10s to keep Polymarket WS alive."""
    try:
        while True:
            await asyncio.sleep(PING_INTERVAL)
            await ws.send("PING")
    except asyncio.CancelledError:
        pass
    except Exception:
        pass


async def polymarket_ws_worker():
    """Streams live Polymarket CLOB data for all assets."""
    global _ws_reconnects

    # Wait for at least one asset to have tokens
    while not any(assets[a].token_id_up for a in ASSET_LIST):
        await asyncio.sleep(0.5)

    while True:
        try:
            # Collect all token IDs
            all_tokens = []
            for a in ASSET_LIST:
                ast = assets[a]
                if ast.token_id_up:
                    all_tokens.append(ast.token_id_up)
                if ast.token_id_down:
                    all_tokens.append(ast.token_id_down)

            if not all_tokens:
                await asyncio.sleep(1)
                continue

            async with websockets.connect(POLY_WS, max_size=10 * 1024 * 1024) as ws:
                sub_msg = {"assets_ids": all_tokens, "type": "market"}
                await ws.send(orjson.dumps(sub_msg).decode("utf-8"))
                log.info(f"Polymarket WS connected. Subscribed to {len(all_tokens)} tokens.")
                _ws_reconnects += 1

                resubscribe_event.clear()
                ping_task = asyncio.create_task(_ping_loop(ws))

                try:
                    async for msg in ws:
                        # Check for resubscribe
                        if resubscribe_event.is_set():
                            log.info("Resubscribe triggered — reconnecting Polymarket WS...")
                            break

                        raw = msg if isinstance(msg, str) else msg.decode("utf-8")
                        if raw.strip().upper() == "PONG":
                            continue

                        now_t = time.time()
                        data = orjson.loads(raw)
                        events = data if isinstance(data, list) else [data]

                        for event in events:
                            _process_poly_event(event, now_t)
                finally:
                    ping_task.cancel()

        except Exception as e:
            log.error(f"Polymarket WS error: {e}")
            await asyncio.sleep(1)


def _process_poly_event(event: dict, now_t: float):
    """Process a single Polymarket CLOB event."""
    etype = event.get("event_type", "")
    server_ts = None
    ts_raw = event.get("timestamp")
    if ts_raw is not None:
        try:
            server_ts = float(ts_raw) / 1000.0  # ms -> seconds
        except (ValueError, TypeError):
            pass

    if etype == "book":
        aid = event.get("asset_id", "")
        route = token_route.get(aid)
        if not route:
            return
        ast, side = route
        if side == "up":
            ast.up_bids.clear()
            ast.up_asks.clear()
            for item in event.get("bids", []):
                ast.up_bids[float(item["price"])] = float(item["size"])
            for item in event.get("asks", []):
                ast.up_asks[float(item["price"])] = float(item["size"])
            if ast.up_bids:
                ast.up_best_bid = max(ast.up_bids.keys())
            if ast.up_asks:
                ast.up_best_ask = min(ast.up_asks.keys())
            # Compress and dedup
            blob = compress_book(ast.up_bids, ast.up_asks)
            blob_crc = crc32(blob)
            if blob_crc != ast._last_up_crc:
                ast._last_up_crc = blob_crc
                if recorder:
                    recorder.record_book(now_t, server_ts, ast.win_id, 1, blob)  # tk=1 (up)
            else:
                if recorder:
                    recorder.total_deduped += 1
        else:
            ast.down_bids.clear()
            ast.down_asks.clear()
            for item in event.get("bids", []):
                ast.down_bids[float(item["price"])] = float(item["size"])
            for item in event.get("asks", []):
                ast.down_asks[float(item["price"])] = float(item["size"])
            if ast.down_bids:
                ast.down_best_bid = max(ast.down_bids.keys())
            if ast.down_asks:
                ast.down_best_ask = min(ast.down_asks.keys())
            blob = compress_book(ast.down_bids, ast.down_asks)
            blob_crc = crc32(blob)
            if blob_crc != ast._last_down_crc:
                ast._last_down_crc = blob_crc
                if recorder:
                    recorder.record_book(now_t, server_ts, ast.win_id, 0, blob)  # tk=0 (down)
            else:
                if recorder:
                    recorder.total_deduped += 1

    elif etype == "price_change":
        for pc in event.get("price_changes", []):
            aid = pc.get("asset_id", "")
            route = token_route.get(aid)
            if not route:
                continue
            ast, side_name = route
            p = float(pc["price"])
            s = float(pc["size"])
            order_side = pc.get("side", "")
            bb = float(pc["best_bid"]) if "best_bid" in pc else None
            ba = float(pc["best_ask"]) if "best_ask" in pc else None

            # Integer encode: tk (0=down,1=up), sd (0=BUY,1=SELL)
            tk = 1 if side_name == "up" else 0
            sd = 0 if order_side == "BUY" else (1 if order_side == "SELL" else None)

            if recorder:
                recorder.record_tick(now_t, server_ts, ast.win_id, 0, tk, sd, p, s, bb, ba)  # et=0 (price_change)

            # Update in-memory book
            if side_name == "up":
                if order_side == "BUY":
                    if s == 0:
                        ast.up_bids.pop(p, None)
                    else:
                        ast.up_bids[p] = s
                elif order_side == "SELL":
                    if s == 0:
                        ast.up_asks.pop(p, None)
                    else:
                        ast.up_asks[p] = s
                if bb is not None:
                    ast.up_best_bid = bb
                if ba is not None:
                    ast.up_best_ask = ba
            else:
                if order_side == "BUY":
                    if s == 0:
                        ast.down_bids.pop(p, None)
                    else:
                        ast.down_bids[p] = s
                elif order_side == "SELL":
                    if s == 0:
                        ast.down_asks.pop(p, None)
                    else:
                        ast.down_asks[p] = s
                if bb is not None:
                    ast.down_best_bid = bb
                if ba is not None:
                    ast.down_best_ask = ba

    elif etype == "last_trade_price":
        aid = event.get("asset_id", "")
        route = token_route.get(aid)
        if not route:
            return
        ast, side_name = route
        trade_price = float(event["price"])
        tk = 1 if side_name == "up" else 0
        if recorder:
            recorder.record_tick(now_t, server_ts, ast.win_id, 1, tk, None, trade_price, None, None, None)  # et=1 (last_trade_price)

# ==========================================
# BINANCE WEBSOCKET WORKER
# ==========================================
BINANCE_ASSET_MAP = {}  # built in main()

async def binance_ws_worker():
    """Streams reference prices from Binance combined aggTrade stream.
    Tries global Binance first, falls back to Binance US if geo-blocked (HTTP 451).
    """
    streams = "/".join(f"{BINANCE_SYMBOL[a]}@aggTrade" for a in ASSET_LIST if a in BINANCE_SYMBOL)
    endpoint_idx = 0  # start with global

    while True:
        uri = BINANCE_ENDPOINTS[endpoint_idx].format(streams=streams)
        try:
            async with websockets.connect(uri, max_size=1024 * 1024) as ws:
                label = "Binance.com" if endpoint_idx == 0 else "Binance.us"
                log.info(f"{label} WS connected. Streams: {streams}")
                async for msg in ws:
                    data = orjson.loads(msg)
                    stream = data.get("stream", "")
                    payload = data.get("data", {})
                    asset = BINANCE_ASSET_MAP.get(stream.split("@")[0])
                    if not asset:
                        continue
                    price = float(payload["p"])
                    qty = float(payload["q"])
                    ts = float(payload["T"]) / 1000.0
                    if recorder:
                        recorder.record_ref(ts, ASSET_INT[asset], price, qty)
        except Exception as e:
            err_str = str(e)
            if "451" in err_str and endpoint_idx == 0:
                log.warning("Binance.com geo-blocked (HTTP 451), switching to Binance.us")
                endpoint_idx = 1
                continue
            log.error(f"Binance WS error: {e}")
            await asyncio.sleep(1)

# ==========================================
# SESSION BUILDER (backward compat with collected_sessions.db)
# ==========================================
_completed_markets: set = set()

async def session_builder_loop():
    """After each 5-min window ends, build a sessions row from granular data."""
    while True:
        await asyncio.sleep(10)
        now = time.time()
        for a in ASSET_LIST:
            ast = assets[a]
            # Check if this market has ended and we haven't built its session yet
            if ast.market_id and ast.end_time > 0 and now > ast.end_time + 5:
                if ast.market_id not in _completed_markets:
                    _completed_markets.add(ast.market_id)
                    try:
                        _build_session(ast)
                    except Exception as e:
                        log.error(f"[{ast.asset}] Session build error: {e}")

        # Prune old entries to prevent memory growth
        if len(_completed_markets) > 10000:
            _completed_markets.clear()


def _build_session(ast: AssetState):
    """Build a backward-compatible session row from granular tick data."""
    conn = sqlite3.connect(DB_PATH)
    try:
        # Get all price_ticks for this market window, ordered by time
        rows = conn.execute(
            "SELECT ts, et, tk, sd, price, size, best_bid, best_ask "
            "FROM price_ticks WHERE win_id = ? ORDER BY ts",
            (ast.win_id,)
        ).fetchall()

        if not rows:
            return

        # Get ref prices for this time range
        ts_min = rows[0][0]
        ts_max = rows[-1][0]
        asset_int = ASSET_INT[ast.asset]
        ref_rows = conn.execute(
            "SELECT ts, price FROM ref_prices WHERE a = ? AND ts BETWEEN ? AND ? ORDER BY ts",
            (asset_int, ts_min - 1, ts_max + 1)
        ).fetchall()

        # Build tick array: [ts, sr, up_mid, down_mid, up_ask, up_bid, down_ask, down_bid]
        ticks = []
        # Track current best bid/ask for each side
        cur_up_bid = 0.0
        cur_up_ask = 0.0
        cur_down_bid = 0.0
        cur_down_ask = 0.0
        ref_idx = 0

        for ts, et, tk, sd, price, size, bb, ba in rows:
            if et == 0:  # price_change
                is_up = (tk == 1)
                if is_up:
                    if bb is not None:
                        cur_up_bid = bb
                    if ba is not None:
                        cur_up_ask = ba
                else:
                    if bb is not None:
                        cur_down_bid = bb
                    if ba is not None:
                        cur_down_ask = ba

            # Find closest ref price
            sr = 0.0
            while ref_idx < len(ref_rows) - 1 and ref_rows[ref_idx + 1][0] <= ts:
                ref_idx += 1
            if ref_rows:
                sr = ref_rows[min(ref_idx, len(ref_rows) - 1)][1]

            # Compute midpoints
            up_mid = (cur_up_bid + cur_up_ask) / 2 if cur_up_bid and cur_up_ask else cur_up_bid or cur_up_ask
            down_mid = (cur_down_bid + cur_down_ask) / 2 if cur_down_bid and cur_down_ask else cur_down_bid or cur_down_ask

            ticks.append([ts, sr, up_mid, down_mid, cur_up_ask, cur_up_bid, cur_down_ask, cur_down_bid])

        if not ticks:
            return

        # Compute session metadata
        srs = [t[1] for t in ticks if t[1] != 0]
        first_sr = srs[0] if srs else 0.0
        last_sr = srs[-1] if srs else 0.0
        span = abs(first_sr - last_sr) if srs else 0.0

        # Compress ticks
        ticks_blob = _zstd_cctx.compress(msgpack.packb(ticks))

        if recorder:
            recorder.record_session(
                ast.market_id, ast.asset, ast.slug, ast.title,
                ast.end_time, first_sr, last_sr, span,
                len(ticks), ticks_blob, time.time(),
            )
            log.info(f"[{ast.asset}] Session built: {ast.slug} ({len(ticks)} ticks, {len(ticks_blob)} bytes)")
    finally:
        conn.close()

# ==========================================
# ARCHIVAL (Parquet export + S3 upload)
# ==========================================
_s3_client = None

def _get_s3_client():
    global _s3_client
    if _s3_client is None and S3_BUCKET and HAS_S3:
        kwargs = {}
        if S3_ENDPOINT:
            kwargs["endpoint_url"] = S3_ENDPOINT
        if S3_ACCESS_KEY:
            kwargs["aws_access_key_id"] = S3_ACCESS_KEY
            kwargs["aws_secret_access_key"] = S3_SECRET_KEY
        _s3_client = boto3.client("s3", **kwargs)
    return _s3_client


def _upload_to_s3(local_path: str, s3_key: str):
    client = _get_s3_client()
    if not client:
        return
    try:
        client.upload_file(local_path, S3_BUCKET, s3_key)
        log.info(f"S3 uploaded: {s3_key}")
    except Exception as e:
        log.error(f"S3 upload error: {e}")


async def archival_loop():
    """Periodically export old data to Parquet and optionally upload to S3."""
    if not HAS_PARQUET:
        log.warning("pyarrow not installed — Parquet archival disabled.")
        return

    while True:
        await asyncio.sleep(ARCHIVAL_INTERVAL)
        try:
            await asyncio.get_event_loop().run_in_executor(None, _do_archival)
        except Exception as e:
            log.error(f"Archival error: {e}")


def _do_archival():
    """Run in thread: export old SQLite data to Parquet, prune, optionally upload to S3."""
    cutoff = time.time() - ARCHIVAL_AGE
    date_str = datetime.fromtimestamp(cutoff, tz=timezone.utc).strftime("%Y-%m-%d")
    day_dir = os.path.join(DATA_DIR, date_str)
    os.makedirs(day_dir, exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")

    _archive_table(conn, day_dir, date_str, "price_ticks", cutoff,
        "SELECT ts, server_ts, win_id, et, tk, sd, price, size, best_bid, best_ask FROM price_ticks WHERE ts <= ?",
        {
            "ts": pa.float64(), "server_ts": pa.float64(), "win_id": pa.int64(),
            "et": pa.int8(), "tk": pa.int8(), "sd": pa.int8(),
            "price": pa.float64(), "size": pa.float64(),
            "best_bid": pa.float64(), "best_ask": pa.float64(),
        },
        "DELETE FROM price_ticks WHERE ts <= ?",
    )

    _archive_table(conn, day_dir, date_str, "book_snapshots", cutoff,
        "SELECT ts, server_ts, win_id, tk, data FROM book_snapshots WHERE ts <= ?",
        {
            "ts": pa.float64(), "server_ts": pa.float64(), "win_id": pa.int64(),
            "tk": pa.int8(), "data": pa.binary(),
        },
        "DELETE FROM book_snapshots WHERE ts <= ?",
    )

    _archive_table(conn, day_dir, date_str, "ref_prices", cutoff,
        "SELECT ts, a, price, qty FROM ref_prices WHERE ts <= ?",
        {
            "ts": pa.float64(), "a": pa.int8(),
            "price": pa.float64(), "qty": pa.float64(),
        },
        "DELETE FROM ref_prices WHERE ts <= ?",
    )

    # Market windows: export all (no delete — they're small and useful for joining win_id)
    rows = conn.execute(
        "SELECT id, asset, market_id, title, token_id_up, token_id_down, slug, start_time, end_time FROM market_windows"
    ).fetchall()
    if rows:
        table = pa.table({
            "id": pa.array([r[0] for r in rows], type=pa.int64()),
            "asset": pa.array([r[1] for r in rows], type=pa.string()),
            "market_id": pa.array([r[2] for r in rows], type=pa.string()),
            "title": pa.array([r[3] for r in rows], type=pa.string()),
            "token_id_up": pa.array([r[4] for r in rows], type=pa.string()),
            "token_id_down": pa.array([r[5] for r in rows], type=pa.string()),
            "slug": pa.array([r[6] for r in rows], type=pa.string()),
            "start_time": pa.array([r[7] for r in rows], type=pa.float64()),
            "end_time": pa.array([r[8] for r in rows], type=pa.float64()),
        })
        out = os.path.join(day_dir, "market_windows.parquet")
        pq.write_table(table, out, compression="snappy")
        _upload_to_s3(out, f"{S3_PREFIX}{date_str}/market_windows.parquet")

    conn.commit()
    conn.close()


def _archive_table(conn, day_dir, date_str, table_name, cutoff, select_sql, schema, delete_sql):
    """Export rows from a table to Parquet, delete from SQLite, upload to S3."""
    rows = conn.execute(select_sql, (cutoff,)).fetchall()
    if not rows:
        return

    cols = list(schema.keys())
    arrays = {}
    for i, col in enumerate(cols):
        dtype = schema[col]
        values = [r[i] for r in rows]
        arrays[col] = pa.array(values, type=dtype)

    table = pa.table(arrays)
    out_path = os.path.join(day_dir, f"{table_name}.parquet")

    # Append to existing if present
    if os.path.exists(out_path):
        existing = pq.read_table(out_path)
        table = pa.concat_tables([existing, table])

    pq.write_table(table, out_path, compression="snappy")
    conn.execute(delete_sql, (cutoff,))
    conn.commit()
    log.info(f"Archived {len(rows):,} rows from {table_name} to {out_path}")

    _upload_to_s3(out_path, f"{S3_PREFIX}{date_str}/{table_name}.parquet")

# ==========================================
# STATUS LOOP
# ==========================================
_start_time = time.time()
_rich_live: Live | None = None

def _build_display() -> Text:
    """Build Rich console display."""
    out = Text()
    uptime = time.time() - _start_time
    h, m = divmod(int(uptime), 3600)
    m, s = divmod(m, 60)

    st = recorder.stats() if recorder else {}
    out.append(f"TICK RECORDER | Up {h}h{m:02d}m{s:02d}s", style="bold cyan")
    out.append(f" | Ticks: {st.get('ticks', 0):,} | Books: {st.get('books', 0):,} | Ref: {st.get('ref', 0):,} | Deduped: {st.get('deduped', 0):,} | Buf: {st.get('buf', 0)}", style="cyan")
    out.append(f" | Reconns: {_ws_reconnects}\n", style="cyan")
    out.append("-" * 100 + "\n", style="dim")

    for a in ASSET_LIST:
        ast = assets.get(a)
        if not ast:
            continue
        if ast.market_id:
            up_mid = (ast.up_best_bid + ast.up_best_ask) / 2 if ast.up_best_bid and ast.up_best_ask else 0
            down_mid = (ast.down_best_bid + ast.down_best_ask) / 2 if ast.down_best_bid and ast.down_best_ask else 0
            up_s = f"{up_mid:.2f}" if up_mid else "-.--"
            dn_s = f"{down_mid:.2f}" if down_mid else "-.--"
            out.append(f"  {ast.asset:4s} | UP: {up_s} | DOWN: {dn_s} | T-{ast.seconds_remaining:.0f}s | {ast.slug}\n")
        else:
            out.append(f"  {ast.asset:4s} | waiting for market...\n", style="dim")

    return out


async def status_loop():
    """Periodically refresh display and log recorder health."""
    while True:
        if _rich_live:
            _rich_live.update(_build_display())

        # Record health to DB
        if recorder:
            st = recorder.stats()
            uptime = time.time() - _start_time
            eps = st.get("ticks", 0) / max(uptime, 1)
            active = sum(1 for a in ASSET_LIST if assets.get(a) and assets[a].market_id)
            try:
                conn = sqlite3.connect(DB_PATH)
                conn.execute(
                    "INSERT OR REPLACE INTO recorder_status (ts, uptime_s, assets_active, events_per_sec, buffer_depth, ws_reconnects, last_error) VALUES (?,?,?,?,?,?,?)",
                    (time.time(), uptime, active, eps, st.get("buf", 0), _ws_reconnects, None),
                )
                conn.commit()
                conn.close()
            except Exception:
                pass

        await asyncio.sleep(STATUS_INTERVAL)

# ==========================================
# MIGRATION from collected_sessions.db
# ==========================================
def migrate_legacy():
    """Import all sessions from collected_sessions.db into tick_data.db."""
    if not os.path.exists(LEGACY_DB):
        log.error(f"Legacy DB not found: {LEGACY_DB}")
        return

    src = sqlite3.connect(LEGACY_DB)
    os.makedirs(DATA_DIR, exist_ok=True)
    dst = sqlite3.connect(DB_PATH)

    # Ensure destination tables exist
    rec = TickDataRecorder.__new__(TickDataRecorder)
    rec._db_path = DB_PATH
    rec._setup_pragmas(dst)
    rec._create_tables(dst)

    # Count source rows
    total = src.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    log.info(f"Migrating {total:,} sessions from {LEGACY_DB} -> {DB_PATH}")

    batch = []
    for i, row in enumerate(src.execute(
        "SELECT market_id, asset, slug, title, end_time, first_sr, last_sr, span, tick_count, ticks_json, ticks_blob, collected_at FROM sessions"
    )):
        batch.append(row)
        if len(batch) >= 500:
            dst.executemany(
                "INSERT OR IGNORE INTO sessions (market_id, asset, slug, title, end_time, first_sr, last_sr, span, tick_count, ticks_json, ticks_blob, collected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                batch,
            )
            dst.commit()
            log.info(f"  Migrated {i + 1:,}/{total:,}...")
            batch = []

    if batch:
        dst.executemany(
            "INSERT OR IGNORE INTO sessions (market_id, asset, slug, title, end_time, first_sr, last_sr, span, tick_count, ticks_json, ticks_blob, collected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            batch,
        )
        dst.commit()

    src.close()
    dst.close()
    log.info(f"Migration complete. {total:,} sessions imported.")

# ==========================================
# S3 SYNC (pull Parquet from S3 → local SQLite)
# ==========================================
INT_TO_ASSET = {v: k for k, v in ASSET_INT.items()}
ET_TO_STR = {0: "price_change", 1: "last_trade_price"}
TK_TO_STR = {0: "down", 1: "up"}
SD_TO_STR = {0: "BUY", 1: "SELL"}

def sync_from_s3():
    """Download Parquet files from S3 and import into local tick_data.db."""
    if not HAS_S3:
        log.error("boto3 not installed — cannot sync from S3.")
        return
    if not S3_BUCKET:
        log.error("S3_BUCKET not set. Configure .env or environment.")
        return
    if not HAS_PARQUET:
        log.error("pyarrow not installed — cannot read Parquet.")
        return

    client = _get_s3_client()
    if not client:
        log.error("Failed to create S3 client.")
        return

    os.makedirs(DATA_DIR, exist_ok=True)

    # List all date prefixes under S3_PREFIX
    paginator = client.get_paginator("list_objects_v2")
    prefix = S3_PREFIX
    parquet_keys = []
    for page in paginator.paginate(Bucket=S3_BUCKET, Prefix=prefix):
        for obj in page.get("Contents", []):
            if obj["Key"].endswith(".parquet"):
                parquet_keys.append(obj["Key"])

    if not parquet_keys:
        log.info("No Parquet files found in S3.")
        return

    log.info(f"Found {len(parquet_keys)} Parquet files in s3://{S3_BUCKET}/{prefix}")

    # Download to local DATA_DIR preserving directory structure
    local_files = []
    for key in parquet_keys:
        # key like: polymarket-ticks/2026-03-02/price_ticks.parquet
        rel = key[len(prefix):]  # 2026-03-02/price_ticks.parquet
        local_path = os.path.join(DATA_DIR, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        log.info(f"  Downloading {key} -> {local_path}")
        client.download_file(S3_BUCKET, key, local_path)
        local_files.append(local_path)

    # Now import Parquet files into SQLite
    conn = sqlite3.connect(DB_PATH)
    rec = TickDataRecorder.__new__(TickDataRecorder)
    rec._db_path = DB_PATH
    rec._setup_pragmas(conn)
    rec._create_tables(conn)

    total_imported = {"market_windows": 0, "price_ticks": 0, "book_snapshots": 0, "ref_prices": 0}

    for fpath in sorted(local_files):
        fname = os.path.basename(fpath)
        table_name = fname.replace(".parquet", "")

        if table_name not in total_imported:
            continue

        table = pq.read_table(fpath)
        df_len = table.num_rows
        if df_len == 0:
            continue

        col_names = set(table.column_names)

        if table_name == "market_windows":
            has_id = "id" in col_names
            # Get next available ID if old schema (no id column)
            if not has_id:
                max_id = conn.execute("SELECT COALESCE(MAX(id), 0) FROM market_windows").fetchone()[0]
            rows = []
            for i in range(df_len):
                wid = table.column("id")[i].as_py() if has_id else (max_id + i + 1)
                rows.append((
                    wid,
                    table.column("asset")[i].as_py(),
                    table.column("market_id")[i].as_py(),
                    table.column("title")[i].as_py(),
                    table.column("token_id_up")[i].as_py(),
                    table.column("token_id_down")[i].as_py(),
                    table.column("slug")[i].as_py(),
                    table.column("start_time")[i].as_py(),
                    table.column("end_time")[i].as_py(),
                ))
            conn.executemany(
                "INSERT OR IGNORE INTO market_windows (id, asset, market_id, title, token_id_up, token_id_down, slug, start_time, end_time) VALUES (?,?,?,?,?,?,?,?,?)",
                rows,
            )

        elif table_name == "price_ticks":
            if "win_id" not in col_names:
                log.warning(f"  Skipping {fname} (old TEXT schema)")
                continue
            rows = []
            for i in range(df_len):
                rows.append((
                    table.column("ts")[i].as_py(),
                    table.column("server_ts")[i].as_py(),
                    table.column("win_id")[i].as_py(),
                    table.column("et")[i].as_py(),
                    table.column("tk")[i].as_py(),
                    table.column("sd")[i].as_py(),
                    table.column("price")[i].as_py(),
                    table.column("size")[i].as_py(),
                    table.column("best_bid")[i].as_py(),
                    table.column("best_ask")[i].as_py(),
                ))
            conn.executemany(
                "INSERT INTO price_ticks (ts, server_ts, win_id, et, tk, sd, price, size, best_bid, best_ask) VALUES (?,?,?,?,?,?,?,?,?,?)",
                rows,
            )

        elif table_name == "book_snapshots":
            if "win_id" not in col_names:
                log.warning(f"  Skipping {fname} (old TEXT schema)")
                continue
            rows = []
            for i in range(df_len):
                rows.append((
                    table.column("ts")[i].as_py(),
                    table.column("server_ts")[i].as_py(),
                    table.column("win_id")[i].as_py(),
                    table.column("tk")[i].as_py(),
                    table.column("data")[i].as_py(),
                ))
            conn.executemany(
                "INSERT INTO book_snapshots (ts, server_ts, win_id, tk, data) VALUES (?,?,?,?,?)",
                rows,
            )

        elif table_name == "ref_prices":
            if "a" not in col_names:
                log.warning(f"  Skipping {fname} (old TEXT schema)")
                continue
            rows = []
            for i in range(df_len):
                rows.append((
                    table.column("ts")[i].as_py(),
                    table.column("a")[i].as_py(),
                    table.column("price")[i].as_py(),
                    table.column("qty")[i].as_py(),
                ))
            conn.executemany(
                "INSERT INTO ref_prices (ts, a, price, qty) VALUES (?,?,?,?)",
                rows,
            )

        conn.commit()
        total_imported[table_name] += df_len
        log.info(f"  Imported {df_len:,} rows from {fname}")

    conn.close()
    log.info(f"Sync complete: {total_imported}")

# ==========================================
# GRACEFUL SHUTDOWN
# ==========================================
def _signal_handler(sig, frame):
    log.info(f"Received signal {sig}, shutting down...")
    shutdown_event.set()
    if recorder:
        recorder.close()
    sys.exit(0)

# ==========================================
# MAIN
# ==========================================
async def main():
    global recorder, _rich_live, BINANCE_ASSET_MAP

    os.makedirs(DATA_DIR, exist_ok=True)

    # Build Binance reverse lookup: "btcusdt" -> "BTC"
    BINANCE_ASSET_MAP = {BINANCE_SYMBOL[a]: a for a in ASSET_LIST if a in BINANCE_SYMBOL}

    # Initialize asset states
    for a in ASSET_LIST:
        assets[a] = AssetState(asset=a)

    # Initialize recorder
    recorder = TickDataRecorder(DB_PATH)
    log.info(f"Tick Data Recorder started. DB: {DB_PATH}")
    log.info(f"Assets: {', '.join(ASSET_LIST)} | Archival: every {ARCHIVAL_INTERVAL}s")
    if S3_BUCKET:
        log.info(f"S3: {S3_BUCKET}/{S3_PREFIX} via {S3_ENDPOINT or 'AWS default'}")
    else:
        log.info("S3: disabled (set S3_BUCKET to enable)")

    console = Console()
    with Live(Text("Starting..."), console=console, refresh_per_second=2, vertical_overflow="crop") as live:
        _rich_live = live
        tasks = [
            market_discovery_loop(),
            polymarket_ws_worker(),
            binance_ws_worker(),
            session_builder_loop(),
            status_loop(),
            archival_loop(),
        ]
        await asyncio.gather(*tasks)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Polymarket Multi-Asset Tick Data Recorder")
    parser.add_argument("--migrate", action="store_true", help="Import collected_sessions.db into tick_data.db")
    parser.add_argument("--sync", action="store_true", help="Pull Parquet files from S3 into local tick_data.db")
    args = parser.parse_args()

    if args.migrate:
        migrate_legacy()
        sys.exit(0)
    if args.sync:
        sync_from_s3()
        sys.exit(0)

    # Signal handlers for graceful shutdown
    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    # Use uvloop on Linux for 2-4x faster event loop
    if HAS_UVLOOP:
        uvloop.install()
        log.info("Using uvloop (C-accelerated event loop)")

    asyncio.run(main())
