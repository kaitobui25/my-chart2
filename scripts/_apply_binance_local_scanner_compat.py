#!/usr/bin/env python3
"""Temporary one-shot compatibility patch for scanner/Vnstock source transforms.

The workstation scanner uses exact source markers. Binance Local adds a provider to
those same lines, so this patch teaches the existing transforms to preserve the new
independent provider without changing Binance Spot/USD-M behavior.
"""
from pathlib import Path


def patch_file(path: str, replacements: list[tuple[str, str]]) -> None:
    file_path = Path(path)
    text = file_path.read_text(encoding="utf-8")
    for old, new in replacements:
        if new in text:
            continue
        count = text.count(old)
        if count != 1:
            raise SystemExit(f"expected exactly one match in {path}, got {count}: {old[:120]!r}")
        text = text.replace(old, new, 1)
    file_path.write_text(text, encoding="utf-8")
    print(f"patched {path}")


patch_file(
    "examples/workstation/scanner/vite-plugin-base.ts",
    [
        (
            "    \"type PriceProviderId = 'demo' | 'dnse' | 'fiinquant' | 'binance-spot' | 'binance-usdm';\",\n"
            "    \"type PriceProviderId = 'demo' | 'dnse' | 'fiinquant' | 'vnstock' | 'binance-spot' | 'binance-usdm';\",",
            "    \"type PriceProviderId = 'demo' | 'dnse' | 'fiinquant' | 'binance-local' | 'binance-spot' | 'binance-usdm';\",\n"
            "    \"type PriceProviderId = 'demo' | 'dnse' | 'fiinquant' | 'vnstock' | 'binance-local' | 'binance-spot' | 'binance-usdm';\",",
        ),
        (
            r'''    "    || stored === 'fiinquant'\n    || stored === 'binance-spot'",
    "    || stored === 'fiinquant'\n    || stored === 'vnstock'\n    || stored === 'binance-spot'",''',
            r'''    "    || stored === 'fiinquant'\n    || stored === 'binance-local'\n    || stored === 'binance-spot'",
    "    || stored === 'fiinquant'\n    || stored === 'vnstock'\n    || stored === 'binance-local'\n    || stored === 'binance-spot'",''',
        ),
        (
            r'''    "const demoFeed = new SampleDatafeed();\nconst binanceSpotFeed = new BinanceDatafeed({ market: 'spot' });",
    "const demoFeed = new SampleDatafeed();\nconst vnstockFeed = new VnstockDatafeed();\nconst binanceSpotFeed = new BinanceDatafeed({ market: 'spot' });",''',
            r'''    "const demoFeed = new SampleDatafeed();\nconst binanceLocalFeed = new BinanceLocalDatafeed();\nconst binanceSpotFeed = new BinanceDatafeed({ market: 'spot' });",
    "const demoFeed = new SampleDatafeed();\nconst vnstockFeed = new VnstockDatafeed();\nconst binanceLocalFeed = new BinanceLocalDatafeed();\nconst binanceSpotFeed = new BinanceDatafeed({ market: 'spot' });",''',
        ),
        (
            r'''    "    fiinquant: 'FiinQuant',\n    'binance-spot': 'Binance Spot',",
    "    fiinquant: 'FiinQuant',\n    vnstock: 'Vnstock',\n    'binance-spot': 'Binance Spot',",''',
            r'''    "    fiinquant: 'FiinQuant',\n    'binance-local': 'Binance Local Archive',\n    'binance-spot': 'Binance Spot',",
    "    fiinquant: 'FiinQuant',\n    vnstock: 'Vnstock',\n    'binance-local': 'Binance Local Archive',\n    'binance-spot': 'Binance Spot',",''',
        ),
        (
            "    \"for (const provider of ['demo', 'binance-spot', 'binance-usdm', 'dnse', 'fiinquant'] as PriceProviderId[]) {\",\n"
            "    \"for (const provider of ['demo', 'binance-spot', 'binance-usdm', 'dnse', 'vnstock', 'fiinquant'] as PriceProviderId[]) {\",",
            "    \"for (const provider of ['demo', 'binance-local', 'binance-spot', 'binance-usdm', 'dnse', 'fiinquant'] as PriceProviderId[]) {\",\n"
            "    \"for (const provider of ['demo', 'binance-local', 'binance-spot', 'binance-usdm', 'dnse', 'vnstock', 'fiinquant'] as PriceProviderId[]) {\",",
        ),
        (
            r'''    "  if (provider === 'fiinquant') return 'FiinQuant';\n  return provider === 'binance-spot' ? 'Binance Spot' : 'Binance Futures';",
    "  if (provider === 'fiinquant') return 'FiinQuant';\n  if (provider === 'vnstock') return 'Vnstock';\n  return provider === 'binance-spot' ? 'Binance Spot' : 'Binance Futures';",''',
            r'''    "  if (provider === 'fiinquant') return 'FiinQuant';\n  if (provider === 'binance-local') return 'Binance Local Archive';\n  return provider === 'binance-spot' ? 'Binance Spot' : 'Binance Futures';",
    "  if (provider === 'fiinquant') return 'FiinQuant';\n  if (provider === 'vnstock') return 'Vnstock';\n  if (provider === 'binance-local') return 'Binance Local Archive';\n  return provider === 'binance-spot' ? 'Binance Spot' : 'Binance Futures';",''',
        ),
        (
            r'''    "      : activeProvider === 'fiinquant'\n        ? fiinState\n        : activeProvider === 'binance-spot'",
    "      : activeProvider === 'fiinquant'\n        ? fiinState\n        : activeProvider === 'vnstock'\n          ? vnstockConnectionState === 'connected' ? 'REST polling' : vnstockConnectionState === 'checking' ? tr('đang kiểm tra') : tr('ngoại tuyến')\n        : activeProvider === 'binance-spot'",''',
            r'''    "      : activeProvider === 'fiinquant'\n        ? fiinState\n        : activeProvider === 'binance-local'\n          ? 'SQLite · 30m+'\n          : activeProvider === 'binance-spot'",
    "      : activeProvider === 'fiinquant'\n        ? fiinState\n        : activeProvider === 'binance-local'\n          ? 'SQLite · 30m+'\n          : activeProvider === 'vnstock'\n            ? vnstockConnectionState === 'connected' ? 'REST polling' : vnstockConnectionState === 'checking' ? tr('đang kiểm tra') : tr('ngoại tuyến')\n          : activeProvider === 'binance-spot'",''',
        ),
        (
            r'''    "    isBinanceProvider(activeProvider)\n      || (activeProvider === 'fiinquant' && fiinQuantConnectionState === 'connected')",
    "    isBinanceProvider(activeProvider)\n      || (activeProvider === 'vnstock' && vnstockConnectionState === 'connected')\n      || (activeProvider === 'fiinquant' && fiinQuantConnectionState === 'connected')",''',
            r'''    "    activeProvider === 'binance-local'\n      || isBinanceProvider(activeProvider)\n      || (activeProvider === 'fiinquant' && fiinQuantConnectionState === 'connected')",
    "    activeProvider === 'binance-local'\n      || isBinanceProvider(activeProvider)\n      || (activeProvider === 'vnstock' && vnstockConnectionState === 'connected')\n      || (activeProvider === 'fiinquant' && fiinQuantConnectionState === 'connected')",''',
        ),
    ],
)

patch_file(
    "examples/workstation/scanner/vite-plugin-v9.ts",
    [
        (
            "    '    || DEFAULT_SYMBOLS[index % DEFAULT_SYMBOLS.length];',",
            "    '    || defaultSymbolsForProvider(activeProvider)[index % defaultSymbolsForProvider(activeProvider).length];',",
        ),
        (
            "    '  const savedSymbol = isBinanceProvider(activeProvider) && index > 0',",
            "    '  const savedSymbol = isCryptoProvider(activeProvider) && index > 0',",
        ),
    ],
)
