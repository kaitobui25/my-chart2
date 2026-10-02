from __future__ import annotations

import asyncio
import json
import os
from dataclasses import asdict
from datetime import datetime
from typing import Any

from aiohttp import web

from yfinance_jp_core import (
    SUPPORTED_INTERVALS,
    TOKYO_TZ,
    YFinanceJapanGateway,
    daily_candle_is_closed,
    native_interval,
    normalize_symbol,
    session_metadata,
)


HOST = os.getenv("HOST", "127.0.0.1").strip() or "127.0.0.1"
PORT = int(os.getenv("PORT", "8760"))
GATEWAY = YFinanceJapanGateway()


def _json(payload: Any, status: int = 200) -> web.Response:
    return web.Response(
        status=status,
        text=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        content_type="application/json",
    )


def parse_adjusted(value: str | None) -> bool:
    if value is None or not value.strip():
        return False
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "adjusted"}:
        return True
    if normalized in {"0", "false", "no", "raw", "unadjusted"}:
        return False
    raise ValueError("adjusted must be true or false")


def _parse_limit(value: str | None, default: int) -> int:
    try:
        limit = int(value) if value is not None else default
    except ValueError as exc:
        raise ValueError("limit must be an integer") from exc
    if limit < 1:
        raise ValueError("limit must be at least 1")
    return limit


def _parse_optional_timestamp(value: str | None, name: str) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a Unix timestamp in seconds") from exc


async def health_handler(_: web.Request) -> web.Response:
    payload = await asyncio.to_thread(GATEWAY.health)
    return _json(payload, 200 if payload.get("ok") else 503)


async def symbols_handler(request: web.Request) -> web.Response:
    try:
        query = request.query.get("q", "")
        limit = _parse_limit(request.query.get("limit"), 20)
        items = await asyncio.to_thread(GATEWAY.symbols, query, limit)
        return _json({"source": "yfinance-jp", "symbols": [asdict(item) for item in items]})
    except ValueError as exc:
        return _json({"message": str(exc)}, 400)
    except Exception as exc:
        return _json({"message": str(exc)}, 502)


async def history_handler(request: web.Request) -> web.Response:
    try:
        symbol = request.query.get("symbol", "")
        interval = request.query.get("interval", "1d")
        if interval not in SUPPORTED_INTERVALS:
            raise ValueError(f"unsupported interval: {interval}")
        limit = _parse_limit(request.query.get("limit"), 500)
        from_time = _parse_optional_timestamp(request.query.get("from"), "from")
        to_time = _parse_optional_timestamp(request.query.get("to"), "to")
        adjusted = parse_adjusted(request.query.get("adjusted"))
        candles = await asyncio.to_thread(
            GATEWAY.history,
            symbol,
            interval,
            limit,
            from_time,
            to_time,
            adjusted,
        )
        return _json({
            "symbol": normalize_symbol(symbol),
            "interval": interval,
            "upstreamInterval": native_interval(interval),
            "source": "yfinance-jp",
            "adjusted": adjusted,
            "timezone": "Asia/Tokyo",
            "session": session_metadata(),
            "candles": [asdict(item) for item in candles],
        })
    except ValueError as exc:
        return _json({"message": str(exc)}, 400)
    except Exception as exc:
        return _json({"message": str(exc)}, 502)


async def latest_handler(request: web.Request) -> web.Response:
    try:
        symbols = request.query.get("symbols", "").split(",")
        interval = request.query.get("interval", "1d")
        if interval not in SUPPORTED_INTERVALS:
            raise ValueError(f"unsupported interval: {interval}")
        adjusted = parse_adjusted(request.query.get("adjusted"))
        latest = await asyncio.to_thread(GATEWAY.latest, symbols, interval, adjusted)
        return _json({
            "interval": interval,
            "upstreamInterval": native_interval(interval),
            "source": "yfinance-jp",
            "adjusted": adjusted,
            "timezone": "Asia/Tokyo",
            "session": session_metadata(),
            "candles": {symbol: asdict(candle) for symbol, candle in latest.items()},
        })
    except ValueError as exc:
        return _json({"message": str(exc)}, 400)
    except Exception as exc:
        return _json({"message": str(exc)}, 502)


async def scanner_universe_handler(_: web.Request) -> web.Response:
    try:
        instruments = await asyncio.to_thread(GATEWAY.scanner_universe)
        return _json({
            "source": "yfinance-jp",
            "instruments": [asdict(item) for item in instruments],
        })
    except ValueError as exc:
        return _json({"message": str(exc)}, 400)
    except Exception as exc:
        return _json({"message": str(exc)}, 502)


async def scanner_history_handler(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("request body must be a JSON object")
        raw_symbols = payload.get("symbols")
        if not isinstance(raw_symbols, list):
            raise ValueError("symbols must be an array")
        symbols = [str(item) for item in raw_symbols]
        raw_limit = payload.get("limit")
        limit = _parse_limit(None if raw_limit is None else str(raw_limit), 800)
        raw_since_time = payload.get("sinceTime")
        since_time = _parse_optional_timestamp(
            None if raw_since_time is None else str(raw_since_time),
            "sinceTime",
        )
        history = await asyncio.to_thread(GATEWAY.daily_history, symbols, limit, since_time)
        now = datetime.now(TOKYO_TZ)
        return _json({
            "source": "yfinance-jp",
            "interval": "1d",
            "timezone": "Asia/Tokyo",
            "candles": {
                symbol: [
                    {**asdict(candle), "isClosed": daily_candle_is_closed(candle.time, now)}
                    for candle in candles
                ]
                for symbol, candles in history.items()
            },
        })
    except json.JSONDecodeError:
        return _json({"message": "request body must be valid JSON"}, 400)
    except ValueError as exc:
        return _json({"message": str(exc)}, 400)
    except Exception as exc:
        return _json({"message": str(exc)}, 502)


def create_app() -> web.Application:
    app = web.Application(client_max_size=1024 * 1024)
    app.router.add_get("/health", health_handler)
    app.router.add_get("/symbols", symbols_handler)
    app.router.add_get("/history", history_handler)
    app.router.add_get("/latest", latest_handler)
    app.router.add_get("/scanner/universe", scanner_universe_handler)
    app.router.add_post("/scanner/history", scanner_history_handler)
    return app


if __name__ == "__main__":
    print(f"[yfinance-jp] sidecar listening on http://{HOST}:{PORT}")
    web.run_app(create_app(), host=HOST, port=PORT, print=None)
