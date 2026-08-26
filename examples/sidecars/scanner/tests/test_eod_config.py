from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from eod_config import EodUpdateConfig, load_eod_update_config


class EodUpdateConfigTests(unittest.TestCase):
    def test_reads_lookback_and_timeout_from_yaml(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'eod-update.yaml'
            path.write_text(
                'eod_update:\n'
                '  lookback_days: 90\n'
                '  timeout_seconds: 300\n',
                encoding='utf-8',
            )

            config = load_eod_update_config(path)

        self.assertEqual(config, EodUpdateConfig(lookback_days=90, timeout_seconds=300))

    def test_rejects_non_positive_values(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'eod-update.yaml'
            path.write_text('eod_update:\n  lookback_days: 0\n', encoding='utf-8')
            with self.assertRaises(ValueError):
                load_eod_update_config(path)


if __name__ == '__main__':
    unittest.main()
