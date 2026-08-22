#!/usr/bin/env python3
"""Local Binance Spot archive service.

Only 30-minute candles are stored in SQLite. Larger chart intervals are derived
from those local candles on read. Binance is contacted only by explicit import
or refresh commands.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Iterable

ARCHIVE_BASE = "https://data.binance.vision/"
BASE_INTERVAL = "30m"
SUPPORTED_INTERVALS = {"30m", "1h", "2h", "4h", "1d", "1w", "1M"}
FIXED_INTERVAL_SECONDS = {
    "30m": 30 * 60,
    "1h": 60 * 60,
    "2h": 2 * 60 * 60,
    "4h": 4 * 60 * 60,
    "1d": 24 * 60 * 60,
}
APPROX_RAW_BARS = {
    "30m": 1,
    "1h": 2,
    "2h": 4,
    "4h": 8,
    "1d": 48,
    "1w": 7 * 48,
    "1M": 31 * 48,
}
ARCHIVE_START = date(2017, 8, 1)
REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data" / "binance-archive"
DB_PATH = DATA_DIR / "binance.sqlite3"
USER_AGENT = "L2Chart-BinanceLocal/1.0"
SYMBOL_RE = re.compile(r"^[A-Z0-9]{5,20}$")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def normalize_symbol(value: str) -> str:
    symbol = str(value or "").strip().upper()
    for separator in ("/", "-", "_"):
        symbol = symbol.replace(separator, "")
    symbol = "".join(symbol.split())
    if not SYMBOL_RE.fullmatch(symbol):
        raise ApiError(400, "INVALID_SYMBOL", "Invalid Binance symbol")
    return symbol


def normalize_archive_timestamp(value: object) -> int:
    number = int(str(value))
    magnitude = abs(number)
    if magnitude >= 100_000_000_000_000:  # microseconds
        return number // 1_000_000
    if magnitude >= 100_000_000_000:  # milliseconds
        return number // 1_000
    return number


def bucket_start(timestamp: int, interval: str) -> int:
    if interval in FIXED_INTERVAL_SECONDS:
        step = FIXED_INTERVAL_SECONDS[interval]
        return timestamp - (timestamp % step)
    dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
    if interval == "1w":
        start = datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc) - timedelta(days=dt.weekday())
        return int(start.timestamp())
    if interval == "1M":
        return int(datetime(dt.year, dt.month, 1, tzinfo=timezone.utc).timestamp())
    raise ApiError(400, "UNSUPPORTED_INTERVAL", f"Unsupported interval: {interval}")


def aggregate_rows(rows: Iterable[tuple], interval: str) -> list[dict]:
    if interval not in SUPPORTED_INTERVALS:
        raise ApiError(400, "UNSUPPORTED_INTERVAL", "Binance Local supports 30m and above")

    candles: list[dict] = []
    current: dict | None = None
    current_bucket: int | None = None
    for row in rows:
        open_time, open_, high, low, close, volume = row
        start = bucket_start(int(open_time), interval)
        if current is None or start != current_bucket:
            if current is not None:
                candles.append(current)
            current_bucket = start
            current = {
                "time": start,
                "open": float(open_),
                "high": float(high),
                "low": float(low),
                "close": float(close),
                "volume": float(volume),
            }
            continue
        current["high"] = max(current["high"], float(high))
        current["low"] = min(current["low"], float(low))
        current["close"] = float(close)
        current["volume"] += float(volume)
    if current is not None:
        candles.append(current)
    return candles


def connect_db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=30)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS symbols (
            symbol TEXT PRIMARY KEY,
            first_time INTEGER NOT NULL,
            last_time INTEGER NOT NULL,
            last_import_at INTEGER NOT NULL,
            last_refresh_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS candles_30m (
            symbol TEXT NOT NULL,
            open_time INTEGER NOT NULL,
            open REAL NOT NULL,
            high REAL NOT NULL,
            low REAL NOT NULL,
            close REAL NOT NULL,
            volume REAL NOT NULL,
            PRIMARY KEY (symbol, open_time)
        ) WITHOUT ROWID;

        CREATE TABLE IF NOT EXISTS archive_imports (
            symbol TEXT NOT NULL,
            archive_path TEXT NOT NULL,
            sha256 TEXT,
            row_count INTEGER NOT NULL,
            imported_at INTEGER NOT NULL,
            PRIMARY KEY (symbol, archive_path)
        ) WITHOUT ROWID;
        """
    )
    return connection


def symbol_status(connection: sqlite3.Connection, symbol: str) -> dict:
    row = connection.execute(
        "SELECT first_time, last_time, last_import_at, last_refresh_at FROM symbols WHERE symbol = ?",
        (symbol,),
    ).fetchone()
    if not row:
        return {"symbol": symbol, "installed": False}
    count = connection.execute(
        "SELECT COUNT(*) FROM candles_30m WHERE symbol = ?", (symbol,)
    ).fetchone()[0]
    return {
        "symbol": symbol,
        "installed": True,
        "interval": BASE_INTERVAL,
        "firstTime": int(row[0]),
        "lastTime": int(row[1]),
        "lastImportAt": int(row[2]),
        "lastRefreshAt": int(row[3]) if row[3] is not None else None,
        "rows": int(count),
    }


def list_symbols(connection: sqlite3.Connection, query: str, limit: int) -> list[dict]:
    pattern = f"%{normalize_query(query)}%"
    rows = connection.execute(
        "SELECT symbol, first_time, last_time FROM symbols WHERE symbol LIKE ? ORDER BY symbol LIMIT ?",
        (pattern, max(1, min(limit, 200))),
    ).fetchall()
    return [
        {
            "symbol": row[0],
            "name": row[0],
            "exchange": "Binance Local",
            "firstTime": int(row[1]),
            "lastTime": int(row[2]),
        }
        for row in rows
    ]


def normalize_query(value: str) -> str:
    query = str(value or "").strip().upper()
    for separator in ("/", "-", "_"):
        query = query.replace(separator, "")
    return "".join(query.split())


def _query_raw_rows(
    connection: sqlite3.Connection,
    symbol: str,
    interval: str,
    limit: int,
    from_time: int | None,
    to_time: int | None,
) -> list[tuple]:
    if from_time is not None or to_time is not None:
        where = ["symbol = ?"]
        values: list[object] = [symbol]
        if from_time is not None:
            raw_from = bucket_start(from_time, interval)
            where.append("open_time >= ?")
            values.append(raw_from)
        if to_time is not None:
            where.append("open_time <= ?")
            values.append(to_time)
        sql = (
            "SELECT open_time, open, high, low, close, volume FROM candles_30m WHERE "
            + " AND ".join(where)
            + " ORDER BY open_time"
        )
        return connection.execute(sql, tuple(values)).fetchall()

    raw_limit = max(1, min(1_000_000, limit * APPROX_RAW_BARS[interval] + APPROX_RAW_BARS[interval] * 2))
    rows = connection.execute(
        """
        SELECT open_time, open, high, low, close, volume
        FROM candles_30m
        WHERE symbol = ?
        ORDER BY open_time DESC
        LIMIT ?
        """,
        (symbol, raw_limit),
    ).fetchall()
    rows.reverse()
    return rows


def read_history(
    connection: sqlite3.Connection,
    symbol: str,
    interval: str,
    limit: int,
    from_time: int | None,
    to_time: int | None,
) -> list[dict]:
    if interval not in SUPPORTED_INTERVALS:
        raise ApiError(400, "UNSUPPORTED_INTERVAL", "Binance Local supports 30m and above")
    if not symbol_status(connection, symbol)["installed"]:
        raise ApiError(404, "SYMBOL_NOT_INSTALLED", f"{symbol} is not downloaded yet")
    rows = _query_raw_rows(connection, symbol, interval, limit, from_time, to_time)
    candles = aggregate_rows(rows, interval)
    if from_time is not None:
        candles = [candle for candle in candles if candle["time"] >= from_time]
    if to_time is not None:
        candles = [candle for candle in candles if candle["time"] <= to_time]
    if limit > 0 and len(candles) > limit:
        candles = candles[-limit:]
    return candles


def _month_floor(value: date) -> date:
    return date(value.year, value.month, 1)


def _next_month(value: date) -> date:
    if value.month == 12:
        return date(value.year + 1, 1, 1)
    return date(value.year, value.month + 1, 1)


def _iter_months(start: date, end_exclusive: date):
    current = _month_floor(start)
    while current < end_exclusive:
        yield current
        current = _next_month(current)


def _download(path: str, allow_404: bool = False) -> bytes | None:
    request = urllib.request.Request(
        urllib.parse.urljoin(ARCHIVE_BASE, path),
        headers={"User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if allow_404 and error.code == 404:
            return None
        raise


def _verify_checksum(path: str, payload: bytes) -> str | None:
    checksum_bytes = _download(path + ".CHECKSUM", allow_404=True)
    actual = hashlib.sha256(payload).hexdigest()
    if checksum_bytes is None:
        return actual
    expected = checksum_bytes.decode("utf-8", errors="replace").strip().split()[0].lower()
    if expected and expected != actual:
        raise RuntimeError(f"Checksum mismatch for {path}")
    return actual


def _parse_zip(payload: bytes) -> list[tuple]:
    rows: list[tuple] = []
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        names = [name for name in archive.namelist() if name.lower().endswith(".csv")]
        if len(names) != 1:
            raise RuntimeError("Expected one CSV in Binance archive")
        with archive.open(names[0], "r") as raw:
            text = io.TextIOWrapper(raw, encoding="utf-8", newline="")
            for index, fields in enumerate(csv.reader(text), start=1):
                if len(fields) < 6:
                    raise RuntimeError(f"Malformed CSV row {index}")
                try:
                    open_time = normalize_archive_timestamp(fields[0])
                    open_, high, low, close, volume = (float(fields[i]) for i in range(1, 6))
                except (TypeError, ValueError) as error:
                    raise RuntimeError(f"Invalid numeric CSV row {index}") from error
                numbers = (open_, high, low, close, volume)
                if not all(math.isfinite(value) for value in numbers):
                    raise RuntimeError(f"Non-finite CSV row {index}")
                if high < low or high < max(open_, close) or low > min(open_, close):
                    raise RuntimeError(f"Invalid OHLC CSV row {index}")
                rows.append((open_time, open_, high, low, close, volume))
    return rows


def _archive_done(connection: sqlite3.Connection, symbol: str, path: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM archive_imports WHERE symbol = ? AND archive_path = ?",
        (symbol, path),
    ).fetchone() is not None


def _import_archive(connection: sqlite3.Connection, symbol: str, path: str) -> int:
    if _archive_done(connection, symbol, path):
        return 0
    payload = _download(path, allow_404=True)
    if payload is None:
        return 0
    checksum = _verify_checksum(path, payload)
    rows = _parse_zip(payload)
    if not rows:
        return 0
    imported_at = int(time.time())
    with connection:
        connection.executemany(
            """
            INSERT INTO candles_30m(symbol, open_time, open, high, low, close, volume)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, open_time) DO UPDATE SET
                open = excluded.open,
                high = excluded.high,
                low = excluded.low,
                close = excluded.close,
                volume = excluded.volume
            """,
            [(symbol, *row) for row in rows],
        )
        connection.execute(
            """
            INSERT OR REPLACE INTO archive_imports(symbol, archive_path, sha256, row_count, imported_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (symbol, path, checksum, len(rows), imported_at),
        )
    return len(rows)


def _sync_symbol_metadata(connection: sqlite3.Connection, symbol: str, refresh: bool) -> dict:
    bounds = connection.execute(
        "SELECT MIN(open_time), MAX(open_time) FROM candles_30m WHERE symbol = ?",
        (symbol,),
    ).fetchone()
    if not bounds or bounds[0] is None or bounds[1] is None:
        raise ApiError(404, "ARCHIVE_NOT_FOUND", f"No Binance 30m archive data found for {symbol}")
    now = int(time.time())
    existing = connection.execute(
        "SELECT last_import_at, last_refresh_at FROM symbols WHERE symbol = ?",
        (symbol,),
    ).fetchone()
    first_import = existing[0] if existing else now
    last_refresh = now if refresh else (existing[1] if existing else None)
    with connection:
        connection.execute(
            """
            INSERT INTO symbols(symbol, first_time, last_time, last_import_at, last_refresh_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(symbol) DO UPDATE SET
                first_time = excluded.first_time,
                last_time = excluded.last_time,
                last_import_at = symbols.last_import_at,
                last_refresh_at = excluded.last_refresh_at
            """,
            (symbol, int(bounds[0]), int(bounds[1]), int(first_import), last_refresh),
        )
    return symbol_status(connection, symbol)


def import_or_refresh(connection: sqlite3.Connection, symbol: str, refresh: bool) -> dict:
    symbol = normalize_symbol(symbol)
    status = symbol_status(connection, symbol)
    if refresh and not status["installed"]:
        raise ApiError(404, "SYMBOL_NOT_INSTALLED", f"{symbol} is not downloaded yet")

    today = datetime.now(timezone.utc).date()
    current_month = _month_floor(today)
    if refresh and status["installed"]:
        start = _month_floor(datetime.fromtimestamp(status["lastTime"], timezone.utc).date())
    else:
        start = ARCHIVE_START

    downloaded_rows = 0
    attempted = 0
    for month in _iter_months(start, current_month):
        name = f"{symbol}-{BASE_INTERVAL}-{month.year:04d}-{month.month:02d}.zip"
        path = f"data/spot/monthly/klines/{symbol}/{BASE_INTERVAL}/{name}"
        if _archive_done(connection, symbol, path):
            continue
        attempted += 1
        downloaded_rows += _import_archive(connection, symbol, path)

    # Daily 30m archives fill the current month. Binance publishes daily data the next day.
    day = current_month
    yesterday = today - timedelta(days=1)
    while day <= yesterday:
        name = f"{symbol}-{BASE_INTERVAL}-{day.isoformat()}.zip"
        path = f"data/spot/daily/klines/{symbol}/{BASE_INTERVAL}/{name}"
        if not _archive_done(connection, symbol, path):
            attempted += 1
            downloaded_rows += _import_archive(connection, symbol, path)
        day += timedelta(days=1)

    result = _sync_symbol_metadata(connection, symbol, refresh)
    result.update({"downloadedRows": downloaded_rows, "attemptedArchives": attempted})
    return result


def health_payload(connection: sqlite3.Connection) -> dict:
    count = connection.execute("SELECT COUNT(*) FROM symbols").fetchone()[0]
    size = DB_PATH.stat().st_size if DB_PATH.exists() else 0
    return {
        "ok": True,
        "version": 1,
        "source": "Binance Public Data Archive",
        "baseInterval": BASE_INTERVAL,
        "supportedIntervals": sorted(SUPPORTED_INTERVALS),
        "dbPath": str(DB_PATH),
        "dbBytes": int(size),
        "installedSymbols": int(count),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "L2ChartBinanceLocal/1.0"

    def log_message(self, format: str, *args) -> None:
        print(f"[binance-local] {format % args}")

    def _origin(self) -> str | None:
        origin = self.headers.get("Origin")
        if not origin:
            return None
        try:
            host = urllib.parse.urlparse(origin).hostname
        except ValueError:
            return ""
        return origin if host in {"127.0.0.1", "localhost", "::1"} else ""

    def _headers(self, status: int, content_type: str = "application/json; charset=utf-8") -> bool:
        origin = self._origin()
        if origin == "":
            self.send_response(403)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(b'{"message":"Cross-site requests are not allowed"}')
            return False
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        return True

    def _json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        if self._headers(status):
            self.wfile.write(body)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            value = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as error:
            raise ApiError(400, "INVALID_JSON", "Invalid JSON body") from error
        if not isinstance(value, dict):
            raise ApiError(400, "INVALID_JSON", "JSON body must be an object")
        return value

    def _run(self, action) -> None:
        try:
            with connect_db() as connection:
                action(connection)
        except ApiError as error:
            self._json(error.status, {"ok": False, "code": error.code, "message": error.message})
        except Exception as error:
            print(f"[binance-local] error: {error}", file=sys.stderr)
            self._json(500, {"ok": False, "code": "INTERNAL_ERROR", "message": str(error)})

    def do_OPTIONS(self) -> None:
        origin = self._origin()
        if origin == "":
            self._json(403, {"ok": False, "message": "Cross-site requests are not allowed"})
            return
        self.send_response(204)
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)

        def action(connection: sqlite3.Connection) -> None:
            if parsed.path == "/health":
                self._json(200, health_payload(connection))
                return
            if parsed.path == "/symbols":
                q = query.get("q", [""])[0]
                limit = int(query.get("limit", ["30"])[0])
                self._json(200, {"symbols": list_symbols(connection, q, limit)})
                return
            if parsed.path == "/status":
                symbol = normalize_symbol(query.get("symbol", [""])[0])
                self._json(200, symbol_status(connection, symbol))
                return
            if parsed.path == "/history":
                symbol = normalize_symbol(query.get("symbol", [""])[0])
                interval = query.get("interval", [""])[0]
                limit = max(1, min(int(query.get("limit", ["500"])[0]), 50_000))
                from_time = int(query["from"][0]) if "from" in query else None
                to_time = int(query["to"][0]) if "to" in query else None
                candles = read_history(connection, symbol, interval, limit, from_time, to_time)
                self._json(200, {"symbol": symbol, "interval": interval, "candles": candles})
                return
            raise ApiError(404, "NOT_FOUND", "Not found")

        self._run(action)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)

        def action(connection: sqlite3.Connection) -> None:
            body = self._body()
            symbol = normalize_symbol(body.get("symbol", ""))
            if parsed.path == "/import":
                if symbol_status(connection, symbol)["installed"]:
                    self._json(200, symbol_status(connection, symbol))
                    return
                self._json(200, import_or_refresh(connection, symbol, refresh=False))
                return
            if parsed.path == "/refresh":
                self._json(200, import_or_refresh(connection, symbol, refresh=True))
                return
            raise ApiError(404, "NOT_FOUND", "Not found")

        self._run(action)


def main() -> None:
    port = int(os.environ.get("BINANCE_LOCAL_PORT", os.environ.get("PORT", "8750")))
    connect_db().close()
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"[binance-local] SQLite: {DB_PATH}")
    print(f"[binance-local] Listening on http://127.0.0.1:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
