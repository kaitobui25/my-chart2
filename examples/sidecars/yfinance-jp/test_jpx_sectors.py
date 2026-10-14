import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import Mock
from jpx_sectors import FIELDS, JpxSectorRepository, parse_jpx_workbook


def workbook(rows):
    output = io.BytesIO()
    xml = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    for index, row in enumerate(rows, 1):
        xml += f'<row r="{index}">'
        for col, value in enumerate(row):
            xml += f'<c r="{chr(65 + col)}{index}" t="inlineStr"><is><t>{value}</t></is></c>'
        xml += '</row>'
    xml += '</sheetData></worksheet>'
    with zipfile.ZipFile(output, 'w') as book:
        book.writestr('xl/worksheets/sheet1.xml', xml)
    return output.getvalue()


class JpxSectorsTests(unittest.TestCase):
    def test_codes_names_and_unclassified_funds(self):
        data = parse_jpx_workbook(workbook([
            FIELDS, ['130A', 'Example', '50', '水産・農林業', '1', '食品', '20260930'],
            ['1320', 'ETF', '-', '-', '-', '-', '20260930'],
        ]))
        self.assertEqual(data['asOf'], '2026-09-30')
        self.assertEqual(data['records']['130A.T']['sector33Code'], '0050')
        self.assertEqual(data['records']['130A.T']['sector17Code'], '01')
        self.assertNotIn('1320.T', data['records'])

    def test_rejects_changed_schema(self):
        with self.assertRaises(ValueError):
            parse_jpx_workbook(workbook([['Unexpected']]))

    def test_keeps_last_good_snapshot_when_refresh_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'catalog.json'
            saved = {'asOf': '2020-01-31', 'records': {'7203.T': {}}, 'sourceUrl': 'JPX'}
            path.write_text(json.dumps(saved), encoding='utf-8')
            download = Mock(side_effect=OSError('offline'))
            repo = JpxSectorRepository(path, download)
            self.assertEqual(repo.get(), saved)
            self.assertEqual(repo.get(), saved)
            download.assert_called_once()
