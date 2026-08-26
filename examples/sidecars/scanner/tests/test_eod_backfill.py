from __future__ import annotations

import io
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cafef_eod import import_archive
from db import ScannerDB
from eod_backfill import repair_recent_year


def make_zip(text: str) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('CafeF.HOSE.txt', text)
    return output.getvalue()


HEADER = '<Ticker>,<DTYYYYMMDD>,<Open>,<High>,<Low>,<Close>,<Volume>\n'


class EodBackfillTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = ScannerDB(Path(self.temp.name) / 'scanner.db', ROOT / 'migrations')

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_repairs_missing_daily_rows_from_latest_upto_archive(self):
        local_payload = make_zip(
            HEADER
            + 'AAA,20260824,10,11,9,10,1000\n'
            + 'AAA,20260826,11,12,10,11,1200\n'
            + 'BBB,20260824,20,21,19,20,2000\n'
            + 'BBB,20260826,21,22,20,21,2200\n'
        )
        full_payload = make_zip(
            HEADER
            + 'AAA,20260401,8,9,7,8,800\n'
            + 'AAA,20260824,10,11,9,10,1000\n'
            + 'AAA,20260825,10,12,9,11,1100\n'
            + 'AAA,20260826,11,12,10,11,1200\n'
            + 'BBB,20260824,20,21,19,20,2000\n'
            + 'BBB,20260825,20,22,19,21,2100\n'
            + 'BBB,20260826,21,22,20,21,2200\n'
        )
        import_archive(self.db, local_payload, mode='upto', source_url='local.zip')

        with (
            patch('eod_backfill.fetch_text', return_value='<html></html>'),
            patch(
                'eod_backfill.discover_latest_url',
                return_value='https://cafef.test/CafeF.SolieuGD.Upto26082026.zip',
            ),
            patch('eod_backfill.fetch_bytes', return_value=full_payload),
        ):
            result = repair_recent_year(self.db)

        self.assertEqual(result['backfillLookbackDays'], 90)
        self.assertEqual(result['missingDaysBefore'], 1)
        self.assertEqual(result['missingCandlesBefore'], 2)
        self.assertEqual(result['missingDaysAfter'], 0)
        self.assertEqual(result['missingCandlesAfter'], 0)
        self.assertEqual(result['backfilledCandles'], 2)

        ids = self.db.instrument_ids('vn_eod', ['AAA', 'BBB'])
        self.assertEqual(len(self.db.read_candles(ids['AAA'])), 3)
        self.assertEqual(len(self.db.read_candles(ids['BBB'])), 3)


if __name__ == '__main__':
    unittest.main()
