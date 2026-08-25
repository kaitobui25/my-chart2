import importlib.util
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("binance_local_sidecar.py")
spec = importlib.util.spec_from_file_location("binance_local_sidecar", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)


class BinanceLocalCoreTest(unittest.TestCase):
    def test_archive_timestamp_normalization(self):
        self.assertEqual(module.normalize_archive_timestamp(1_704_067_200_000), 1_704_067_200)
        self.assertEqual(module.normalize_archive_timestamp(1_735_689_600_000_000), 1_735_689_600)
        self.assertEqual(module.normalize_archive_timestamp(1_735_689_600), 1_735_689_600)

    def test_fixed_interval_aggregation(self):
        start = int(datetime(2026, 8, 1, tzinfo=timezone.utc).timestamp())
        rows = [
            (start, 10.0, 12.0, 9.0, 11.0, 2.0),
            (start + 1800, 11.0, 14.0, 10.0, 13.0, 3.0),
            (start + 3600, 13.0, 15.0, 12.0, 14.0, 4.0),
            (start + 5400, 14.0, 16.0, 13.0, 15.0, 5.0),
        ]
        candles = module.aggregate_rows(rows, "1h")
        self.assertEqual(len(candles), 2)
        self.assertEqual(candles[0]["open"], 10.0)
        self.assertEqual(candles[0]["high"], 14.0)
        self.assertEqual(candles[0]["low"], 9.0)
        self.assertEqual(candles[0]["close"], 13.0)
        self.assertEqual(candles[0]["volume"], 5.0)

    def test_week_starts_monday_utc(self):
        sunday = int(datetime(2026, 8, 23, 12, tzinfo=timezone.utc).timestamp())
        monday = int(datetime(2026, 8, 17, 0, tzinfo=timezone.utc).timestamp())
        self.assertEqual(module.bucket_start(sunday, "1w"), monday)

    def test_month_uses_calendar_boundary(self):
        value = int(datetime(2026, 8, 31, 23, 59, tzinfo=timezone.utc).timestamp())
        expected = int(datetime(2026, 8, 1, tzinfo=timezone.utc).timestamp())
        self.assertEqual(module.bucket_start(value, "1M"), expected)

    def test_read_history_uses_sqlite_only(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            original_dir = module.DATA_DIR
            original_db = module.DB_PATH
            module.DATA_DIR = Path(temp_dir)
            module.DB_PATH = Path(temp_dir) / "test.sqlite3"
            try:
                connection = module.connect_db()
                start = int(datetime(2026, 8, 1, tzinfo=timezone.utc).timestamp())
                rows = [
                    ("BTCUSDT", start, 10.0, 12.0, 9.0, 11.0, 2.0),
                    ("BTCUSDT", start + 1800, 11.0, 13.0, 10.0, 12.0, 3.0),
                ]
                with connection:
                    connection.executemany(
                        "INSERT INTO candles_30m(symbol, open_time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        rows,
                    )
                    connection.execute(
                        "INSERT INTO symbols(symbol, first_time, last_time, last_import_at) VALUES (?, ?, ?, ?)",
                        ("BTCUSDT", start, start + 1800, start),
                    )

                old_download = module._download
                module._download = lambda *args, **kwargs: self.fail("local history must not use network")
                try:
                    candles = module.read_history(connection, "BTCUSDT", "1h", 500, None, None)
                finally:
                    module._download = old_download
                    connection.close()

                self.assertEqual(len(candles), 1)
                self.assertEqual(candles[0]["close"], 12.0)
            finally:
                module.DATA_DIR = original_dir
                module.DB_PATH = original_db


if __name__ == "__main__":
    unittest.main()
