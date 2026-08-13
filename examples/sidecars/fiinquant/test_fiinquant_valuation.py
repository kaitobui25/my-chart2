from __future__ import annotations

import os
import unittest
from datetime import datetime

from aiohttp.test_utils import AioHTTPTestCase

from fiinquant_sidecar import FiinQuantGateway, build_app, normalize_stock_valuation
from fiinquant_sidecar_core import VN_TZ


class FakeValuationFrame:
    def to_dict(self, orient: str):
        if orient != "records":
            raise ValueError(orient)
        return [
            {"ticker": "MBB", "timestamp": "2026-08-07", "pe": 6.47, "pb": 1.2},
            {"ticker": "MBB", "timestamp": "2026-08-10", "pe": 6.49, "pb": 1.21},
            {"ticker": "MBB", "timestamp": "2026-08-11", "pe": 6.27, "pb": 1.18},
        ]


class FakeMarketDepth:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def get_stock_valuation(self, **kwargs):
        self.calls.append(kwargs)
        return FakeValuationFrame()


class FakeClient:
    def __init__(self) -> None:
        self.market_depth = FakeMarketDepth()

    def MarketDepth(self):
        return self.market_depth


class ValuationNormalizationTests(unittest.TestCase):
    def test_normalizes_sorts_filters_and_deduplicates(self) -> None:
        rows = [
            {"ticker": "MBB", "timestamp": "2026-08-11", "pe": "6.27", "pb": None},
            {"ticker": "OTHER", "timestamp": "2026-08-10", "pe": 99, "pb": 99},
            {"ticker": "MBB", "timestamp": "2026-08-07", "pe": 6.47, "pb": 1.2},
            {"ticker": "MBB", "timestamp": "2026-08-07", "pe": 6.48, "pb": 1.21},
            {"ticker": "MBB", "timestamp": "bad", "pe": 6.5, "pb": 1.2},
        ]
        points = normalize_stock_valuation(rows, "MBB")
        self.assertEqual(len(points), 2)
        self.assertLess(points[0]["time"], points[1]["time"])
        self.assertEqual(points[0]["pe"], 6.48)
        self.assertEqual(points[1]["pe"], 6.27)

    def test_gateway_uses_official_stock_valuation_call(self) -> None:
        gateway = FiinQuantGateway("user", "pass")
        fake = FakeClient()
        gateway._client = fake
        start = int(datetime(2016, 1, 1, tzinfo=VN_TZ).timestamp())
        end = int(datetime(2026, 8, 12, tzinfo=VN_TZ).timestamp())

        points = gateway.fetch_stock_valuation("mbb", start, end)

        self.assertEqual(len(points), 3)
        self.assertEqual(fake.market_depth.calls, [{
            "tickers": ["MBB"],
            "from_date": "2016-01-01",
            "to_date": "2026-08-12",
        }])


class ValuationEndpointTests(AioHTTPTestCase):
    async def get_application(self):
        self.old_token = os.environ.get("SIDECAR_TOKEN")
        os.environ["SIDECAR_TOKEN"] = "test-token"
        self.gateway = FiinQuantGateway("user", "pass")
        self.fake = FakeClient()
        self.gateway._client = self.fake
        return build_app(self.gateway)

    async def asyncTearDown(self) -> None:
        await super().asyncTearDown()
        if self.old_token is None:
            os.environ.pop("SIDECAR_TOKEN", None)
        else:
            os.environ["SIDECAR_TOKEN"] = self.old_token

    async def test_endpoint_requires_token(self) -> None:
        response = await self.client.get("/valuation/stock?symbol=MBB&from=1700000000&to=1701000000")
        self.assertEqual(response.status, 401)

    async def test_endpoint_returns_normalized_daily_points(self) -> None:
        response = await self.client.get(
            "/valuation/stock?symbol=MBB&from=1700000000&to=1701000000",
            headers={"X-L2Chart-Sidecar-Token": "test-token"},
        )
        self.assertEqual(response.status, 200)
        payload = await response.json()
        self.assertEqual(payload["symbol"], "MBB")
        self.assertEqual(payload["source"], "fiinquant-stock-valuation")
        self.assertEqual(len(payload["points"]), 3)
        self.assertAlmostEqual(payload["points"][-1]["pe"], 6.27)


if __name__ == "__main__":
    unittest.main()
