"""FiinQuant sidecar facade with stock-valuation support.

The established history/realtime implementation stays in ``fiinquant_sidecar_core``.
This thin facade extends the same authenticated SDK session with the official
``MarketDepth().get_stock_valuation()`` endpoint used by the P/E indicator.
"""

from __future__ import annotations

import asyncio
import math
import os
import threading
from datetime import date, datetime
from typing import Any

from aiohttp import web

import fiinquant_sidecar_core as core
from fiinquant_sidecar_core import *  # noqa: F403


_ACTIVE_GATEWAY: "FiinQuantGateway | None" = None


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _records(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if hasattr(value, "to_dict"):
        try:
            rows = value.to_dict("records")
            if isinstance(rows, list):
                return [row for row in rows if isinstance(row, dict)]
        except Exception:
            pass
    if isinstance(value, dict):
        return [value]
    if isinstance(value, (list, tuple)):
        return [row for row in value if isinstance(row, dict)]
    return []


def _valuation_time(value: Any) -> int | None:
    if value is None:
        return None
    numeric = _finite(value)
    if numeric is not None and numeric >= 1_000_000_000:
        timestamp = numeric / 1000 if numeric > 1e12 else numeric
        local = datetime.fromtimestamp(timestamp, core.VN_TZ)
        return int(local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = datetime(value.year, value.month, value.day)
    else:
        text = str(value).strip()
        if not text:
            return None
        parsed = None
        normalized = text.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            pass
        if parsed is None:
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y"):
                try:
                    parsed = datetime.strptime(text, fmt)
                    break
                except ValueError:
                    continue
        if parsed is None:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=core.VN_TZ)
    else:
        parsed = parsed.astimezone(core.VN_TZ)
    return int(parsed.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())


def normalize_stock_valuation(value: Any, symbol: str) -> list[dict[str, float | int | None]]:
    normalized_symbol = symbol.strip().upper()
    by_time: dict[int, dict[str, float | int | None]] = {}
    for row in _records(value):
        row_symbol = str(
            row.get("ticker") or row.get("Ticker") or row.get("symbol") or row.get("Symbol") or normalized_symbol
        ).strip().upper()
        if row_symbol and row_symbol != normalized_symbol:
            continue
        timestamp = _valuation_time(
            row.get("timestamp") or row.get("Timestamp") or row.get("date") or row.get("Date")
        )
        pe = _finite(row.get("pe") if "pe" in row else row.get("PE"))
        pb = _finite(row.get("pb") if "pb" in row else row.get("PB"))
        if timestamp is None or (pe is None and pb is None):
            continue
        by_time[timestamp] = {"time": timestamp, "pe": pe, "pb": pb}
    return [by_time[key] for key in sorted(by_time)]


class FiinQuantGateway(core.FiinQuantGateway):
    """Extend the existing session owner with historical stock valuation."""

    def __init__(self, username: str, password: str) -> None:
        super().__init__(username, password)
        self._valuation_slot = threading.BoundedSemaphore(1)
        global _ACTIVE_GATEWAY
        _ACTIVE_GATEWAY = self

    def fetch_stock_valuation(self, symbol: str, from_time: int, to_time: int) -> list[dict]:
        normalized = symbol.strip().upper()
        if not normalized:
            return []
        start = min(from_time, to_time)
        end = max(from_time, to_time)
        client = self._ensure_client()
        with self._valuation_slot, self._history_slots:
            raw = client.MarketDepth().get_stock_valuation(
                tickers=[normalized],
                from_date=datetime.fromtimestamp(start, core.VN_TZ).strftime("%Y-%m-%d"),
                to_date=datetime.fromtimestamp(end, core.VN_TZ).strftime("%Y-%m-%d"),
            )
        return normalize_stock_valuation(raw, normalized)


# The core session endpoint resolves FiinQuantGateway from its module globals at
# request time. Replacing it here ensures browser logins also create the extended
# gateway and update _ACTIVE_GATEWAY without duplicating authentication state.
core.FiinQuantGateway = FiinQuantGateway


def build_app(gateway: FiinQuantGateway | None) -> web.Application:
    global _ACTIVE_GATEWAY
    if isinstance(gateway, FiinQuantGateway):
        _ACTIVE_GATEWAY = gateway
    app = core.build_app(gateway)

    async def stock_valuation(request: web.Request) -> web.Response:
        if not core.check_token(request):
            return web.json_response({"message": "invalid sidecar token"}, status=401)
        current_gateway = _ACTIVE_GATEWAY
        if current_gateway is None:
            return web.json_response({"message": "FiinQuant session is not configured"}, status=503)
        symbol = request.query.get("symbol", "").strip().upper()
        if not symbol:
            return web.json_response({"message": "symbol is required"}, status=400)
        try:
            from_time = int(request.query.get("from", ""))
            to_time = int(request.query.get("to", ""))
        except ValueError:
            return web.json_response({"message": "from/to must be unix timestamps"}, status=400)
        if from_time <= 0 or to_time <= 0:
            return web.json_response({"message": "from/to are required"}, status=400)
        try:
            points = await asyncio.get_running_loop().run_in_executor(
                None,
                current_gateway.fetch_stock_valuation,
                symbol,
                from_time,
                to_time,
            )
        except Exception as exc:  # noqa: BLE001
            return web.json_response({"message": str(exc)[:300]}, status=502)
        return web.json_response({
            "symbol": symbol,
            "source": "fiinquant-stock-valuation",
            "cadence": "1d",
            "points": points,
        })

    app.router.add_get("/valuation/stock", stock_valuation)
    return app


def main() -> None:
    core.load_env()
    username = os.environ.get("FIINQUANT_USERNAME", "")
    password = os.environ.get("FIINQUANT_PASSWORD", "")
    gateway = FiinQuantGateway(username, password) if username and password else None
    if gateway is None:
        print("[warning] FIINQUANT_USERNAME/PASSWORD are not configured; /history and /valuation/stock return 503")
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8720"))
    print(f"FiinQuant sidecar listening on http://{host}:{port}")
    web.run_app(build_app(gateway), host=host, port=port, print=None)


if __name__ == "__main__":
    main()
