from __future__ import annotations

import io
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cafef_eod import discover_latest_url, import_archive, parse_archive
from db import ScannerDB


def make_zip(name: str, text: str) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(name, text)
    return output.getvalue()


class CafeFEodParserTests(unittest.TestCase):
    def test_headered_amibroker_csv_and_exchange_inference(self):
        payload = make_zip(
            'CafeF.HSX.07082026.txt',
            '<Ticker>,<DTYYYYMMDD>,<Open>,<High>,<Low>,<Close>,<Volume>\n'
            'AAA,20260807,10,12,9,11,1000\n',
        )
        parsed = parse_archive(payload)
        self.assertEqual(parsed.member_count, 1)
        self.assertEqual(parsed.row_count, 1)
        self.assertEqual(len(parsed.records), 1)
        record = parsed.records[0]
        self.assertEqual(record.symbol, 'AAA')
        self.assertEqual(record.exchange, 'HOSE')
        self.assertEqual(record.close, 11)
        self.assertEqual(record.volume, 1000)

    def test_headerless_semicolon_duplicate_uses_last_valid_row(self):
        payload = make_zip(
            'HNX-data.dat',
            'BBB;20260806;10;11;9;10.5;100\n'
            'BBB;20260806;10;12;9;11;150\n',
        )
        parsed = parse_archive(payload)
        self.assertEqual(parsed.row_count, 2)
        self.assertEqual(len(parsed.records), 1)
        self.assertEqual(parsed.records[0].exchange, 'HNX')
        self.assertEqual(parsed.records[0].close, 11)
        self.assertEqual(parsed.records[0].volume, 150)

    def test_invalid_ohlc_is_rejected_without_repairing(self):
        payload = make_zip(
            'UPCOM.txt',
            '<Ticker>,<DTYYYYMMDD>,<Open>,<High>,<Low>,<Close>,<Volume>\n'
            'BAD,20260807,10,9,8,11,1000\n'
            'GOOD,20260807,10,12,9,11,1000\n',
        )
        parsed = parse_archive(payload)
        self.assertEqual([record.symbol for record in parsed.records], ['GOOD'])
        self.assertEqual(parsed.records[0].exchange, 'UPCOM')

    def test_discovers_newest_adjusted_package(self):
        html = '''
          <a href="/data/ami_data/20260806/CafeF.SolieuGD.06082026.zip">EOD</a>
          <a href="https://cdn.example/20260807/CafeF.SolieuGD.07082026.zip">EOD latest</a>
          <a href="/data/ami_data/20260806/CafeF.SolieuGD.Upto06082026.zip">Upto</a>
          <a href="/data/ami_data/20260807/CafeF.SolieuGD.Upto07082026.zip">Upto latest</a>
        '''
        self.assertEqual(
            discover_latest_url(html, 'eod', 'https://cafef.vn/du-lieu/du-lieu-download.chn'),
            'https://cdn.example/20260807/CafeF.SolieuGD.07082026.zip',
        )
        self.assertEqual(
            discover_latest_url(html, 'upto', 'https://cafef.vn/du-lieu/du-lieu-download.chn'),
            'https://cafef.vn/data/ami_data/20260807/CafeF.SolieuGD.Upto07082026.zip',
        )


class CafeFEodImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = ScannerDB(Path(self.temp.name) / 'scanner.db', ROOT / 'migrations')

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_import_populates_instruments_snapshots_candles_and_audit(self):
        payload = make_zip(
            'CafeF.HOSE.txt',
            '<Ticker>,<DTYYYYMMDD>,<Open>,<High>,<Low>,<Close>,<Volume>\n'
            'AAA,20260806,10,12,9,11,1000\n'
            'AAA,20260807,11,13,10,12,1200\n'
            'CCC,20260807,20,23,19,22,500\n',
        )
        result = import_archive(
            self.db,
            payload,
            mode='upto',
            source_url='file:///tmp/CafeF.SolieuGD.Upto07082026.zip',
        )
        self.assertTrue(result['ok'])
        self.assertEqual(result['symbols'], 2)
        self.assertEqual(result['candles'], 3)
        self.assertEqual(self.db.list_active_symbols('vn_eod'), ['AAA', 'CCC'])
        coverage = self.db.snapshot_coverage('vn_eod')
        self.assertEqual(coverage['active_count'], 2)
        self.assertEqual(coverage['snapshot_count'], 2)
        instrument_id = self.db.instrument_ids('vn_eod', ['AAA'])['AAA']
        candles = self.db.read_candles(instrument_id)
        self.assertEqual([candle.close for candle in candles], [11, 12])
        audit = self.db.latest_successful_import('vn_eod')
        self.assertIsNotNone(audit)
        assert audit is not None
        self.assertEqual(audit['status'], 'complete')
        self.assertEqual(audit['symbol_count'], 2)
        self.assertEqual(audit['inserted_candle_count'], 3)

    def test_eod_import_does_not_deactivate_symbols_missing_from_daily_file(self):
        bootstrap = make_zip(
            'CafeF.HOSE.txt',
            '<Ticker>,<DTYYYYMMDD>,<Open>,<High>,<Low>,<Close>,<Volume>\n'
            'AAA,20260806,10,12,9,11,1000\n'
            'BBB,20260806,20,22,19,21,1000\n',
        )
        daily = make_zip(
            'CafeF.HOSE.txt',
            '<Ticker>,<DTYYYYMMDD>,<Open>,<High>,<Low>,<Close>,<Volume>\n'
            'AAA,20260807,11,13,10,12,1200\n',
        )
        import_archive(self.db, bootstrap, mode='upto', source_url='bootstrap.zip')
        import_archive(self.db, daily, mode='eod', source_url='daily.zip')
        self.assertEqual(self.db.list_active_symbols('vn_eod'), ['AAA', 'BBB'])


if __name__ == '__main__':
    unittest.main()
