from __future__ import annotations

import io
import sys
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cafef_eod import _parse_date, parse_archive
from cafef_stream import parse_archive_streaming


def make_zip(members: dict[str, str]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, text in members.items():
            archive.writestr(name, text)
    return output.getvalue()


class CafeFStreamingParserTests(unittest.TestCase):
    def test_streaming_parser_matches_existing_parser(self):
        payload = make_zip({
            'CafeF.HSX.txt': (
                '<Ticker>,<DTYYYYMMDD>,<Open>,<High>,<Low>,<Close>,<Volume>\n'
                'AAA,20260824,10,11,9,10,1000\n'
                'AAA,20260825,10,12,9,11,1100\n'
                'BAD,20260825,10,9,8,11,100\n'
            ),
            'HNX-data.dat': (
                'BBB;20260824;20;21;19;20;2000\n'
                'BBB;20260825;20;22;19;21;2100\n'
                'BBB;20260825;20;23;19;22;2200\n'
            ),
        })

        expected = parse_archive(payload)
        actual = parse_archive_streaming(payload)

        self.assertEqual(actual.member_count, expected.member_count)
        self.assertEqual(actual.row_count, expected.row_count)
        self.assertEqual(actual.records, expected.records)

    def test_streaming_parser_can_skip_rows_before_cutoff(self):
        payload = make_zip({
            'CafeF.HOSE.txt': (
                '<Ticker>,<DTYYYYMMDD>,<Open>,<High>,<Low>,<Close>,<Volume>\n'
                'AAA,20260401,8,9,7,8,800\n'
                'AAA,20260824,10,11,9,10,1000\n'
                'AAA,20260825,10,12,9,11,1100\n'
            ),
        })

        parsed = parse_archive_streaming(payload, min_time=_parse_date('2026-06-01'))

        self.assertEqual(parsed.row_count, 3)
        self.assertEqual(len(parsed.records), 2)
        self.assertEqual([record.time for record in parsed.records], [
            _parse_date('2026-08-24'),
            _parse_date('2026-08-25'),
        ])

    def test_streaming_progress_finishes_at_full_uncompressed_size(self):
        rows = ''.join(
            f'AAA,202608{day:02d},10,12,9,11,{1000 + day}\n'
            for day in range(1, 26)
        )
        payload = make_zip({
            'CafeF.HOSE.txt':
                '<Ticker>,<DTYYYYMMDD>,<Open>,<High>,<Low>,<Close>,<Volume>\n' + rows,
        })
        events: list[tuple[int, int, int, int, int]] = []

        parsed = parse_archive_streaming(payload, progress=lambda *args: events.append(args))

        self.assertEqual(len(parsed.records), 25)
        self.assertTrue(events)
        processed, total, member_index, member_total, row_count = events[-1]
        self.assertEqual(processed, total)
        self.assertGreater(total, 0)
        self.assertEqual(member_index, 1)
        self.assertEqual(member_total, 1)
        self.assertEqual(row_count, 25)


if __name__ == '__main__':
    unittest.main()
