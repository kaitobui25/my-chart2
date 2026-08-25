from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import date, datetime, time as datetime_time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from db import ScannerDB
from eod_data_quality import check_top_volume_coverage
from models import Candle, Instrument, MarketSnapshot

TZ = ZoneInfo('Asia/Ho_Chi_Minh')


def session_datetime(value: date) -> datetime:
    return datetime.combine(value, datetime_time.min, tzinfo=TZ)


class EodDataQualityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp.name) / 'scanner.db'
        self.db = ScannerDB(self.db_path, ROOT / 'migrations')

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_uses_click_date_calendar_and_top_40_volume_symbols(self):
        symbols = [f'A{index:02d}' for index in range(41)]
        instruments = [
            Instrument('vn_eod', symbol, symbol, 'HOSE', 'STOCK', True)
            for symbol in symbols
        ]
        ids = self.db.upsert_instruments('vn_eod', instruments, deactivate_missing=False)

        start = date(2026, 6, 26)
        local_latest = date(2026, 8, 24)
        sessions: list[date] = []
        cursor = start
        while cursor <= local_latest:
            if cursor.weekday() < 5:
                sessions.append(cursor)
            cursor += timedelta(days=1)

        specifically_missing = date(2026, 8, 19)
        for symbol in symbols:
            candles = []
            for session in sessions:
                if symbol == 'A01' and session == specifically_missing:
                    continue
                timestamp = int(session_datetime(session).timestamp())
                candles.append(Candle(timestamp, 10, 11, 9, 10, 1_000_000, True))
            self.db.upsert_candles(ids[symbol], candles, '1d', 1000)

        latest_time = int(session_datetime(local_latest).timestamp())
        self.db.upsert_snapshots('vn_eod', [
            MarketSnapshot(symbol, 10, float(41 - index) * 1_000_000, None, latest_time)
            for index, symbol in enumerate(symbols)
        ])

        check_time = int(datetime(2026, 8, 26, 6, 0, tzinfo=TZ).timestamp())
        result = check_top_volume_coverage(self.db_path, now=check_time)

        by_symbol = {item['symbol']: item for item in result['symbols']}
        expected_latest = int(session_datetime(date(2026, 8, 25)).timestamp())
        missing_19 = int(session_datetime(specifically_missing).timestamp())

        self.assertEqual(result['sampleSize'], 40)
        self.assertEqual(result['expectedSessions'], 43)
        self.assertEqual(result['toTime'], expected_latest)
        self.assertNotIn('A40', by_symbol)
        self.assertEqual(by_symbol['A00']['observedSessions'], 42)
        self.assertEqual(by_symbol['A00']['expectedSessions'], 43)
        self.assertEqual(by_symbol['A00']['missingTimes'], [expected_latest])
        self.assertEqual(by_symbol['A01']['observedSessions'], 41)
        self.assertEqual(by_symbol['A01']['missingTimes'], [missing_19, expected_latest])
        self.assertFalse(result['allPass'])


if __name__ == '__main__':
    unittest.main()
