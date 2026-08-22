#!/usr/bin/env python3
"""One-shot source patch used by CI to integrate the independent Binance Local provider.

This file is removed after the generated source commit is verified.
"""
from pathlib import Path

PATH = Path("examples/workstation/main.ts")
text = PATH.read_text(encoding="utf-8")


def replace_once(old: str, new: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match, got {count}: {old[:100]!r}")
    text = text.replace(old, new, 1)


replace_once(
    "import { BinanceDatafeed } from '../providers/binance';\n",
    "import { BinanceDatafeed } from '../providers/binance';\n"
    "import { BINANCE_LOCAL_INTERVALS, BinanceLocalDatafeed } from '../providers/binance-local';\n",
)

replace_once(
    "type PriceProviderId = 'demo' | 'dnse' | 'fiinquant' | 'binance-spot' | 'binance-usdm';",
    "type PriceProviderId = 'demo' | 'dnse' | 'fiinquant' | 'binance-local' | 'binance-spot' | 'binance-usdm';",
)

replace_once(
    "const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];\n",
    "const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'];\n"
    "const BINANCE_LOCAL_INTERVAL_SET = new Set<string>(BINANCE_LOCAL_INTERVALS);\n\n"
    "function intervalAllowedForProvider(provider: PriceProviderId, interval: string): boolean {\n"
    "  return provider !== 'binance-local' || BINANCE_LOCAL_INTERVAL_SET.has(interval);\n"
    "}\n",
)

replace_once(
    "const validProviders = ['demo', 'dnse', 'fiinquant', 'vnstock', 'binance-spot', 'binance-usdm'];",
    "const validProviders = ['demo', 'dnse', 'fiinquant', 'vnstock', 'binance-local', 'binance-spot', 'binance-usdm'];",
)

replace_once(
    "    || stored === 'fiinquant'\n    || stored === 'binance-spot'",
    "    || stored === 'fiinquant'\n    || stored === 'binance-local'\n    || stored === 'binance-spot'",
)

replace_once(
    "const demoFeed = new SampleDatafeed();\nconst binanceSpotFeed = new BinanceDatafeed({ market: 'spot' });",
    "const demoFeed = new SampleDatafeed();\n"
    "const binanceLocalFeed = new BinanceLocalDatafeed();\n"
    "const binanceSpotFeed = new BinanceDatafeed({ market: 'spot' });",
)

replace_once(
    "function isBinanceProvider(provider: PriceProviderId): provider is 'binance-spot' | 'binance-usdm' {\n"
    "  return provider === 'binance-spot' || provider === 'binance-usdm';\n"
    "}\n\n"
    "function providerFamily(provider: PriceProviderId): 'vietnam' | 'binance' {\n"
    "  return isBinanceProvider(provider) ? 'binance' : 'vietnam';\n"
    "}\n\n"
    "function providerWatchlistKey(provider: PriceProviderId): string {\n"
    "  return isBinanceProvider(provider) ? provider : 'vietnam';\n"
    "}\n\n"
    "function defaultSymbolsForProvider(provider: PriceProviderId): string[] {\n"
    "  return isBinanceProvider(provider) ? BINANCE_DEFAULT_SYMBOLS : DEFAULT_SYMBOLS;\n"
    "}",
    "function isBinanceProvider(provider: PriceProviderId): provider is 'binance-spot' | 'binance-usdm' {\n"
    "  return provider === 'binance-spot' || provider === 'binance-usdm';\n"
    "}\n\n"
    "function isCryptoProvider(provider: PriceProviderId): boolean {\n"
    "  return provider === 'binance-local' || isBinanceProvider(provider);\n"
    "}\n\n"
    "function providerFamily(provider: PriceProviderId): 'vietnam' | 'binance' {\n"
    "  return isCryptoProvider(provider) ? 'binance' : 'vietnam';\n"
    "}\n\n"
    "function providerWatchlistKey(provider: PriceProviderId): string {\n"
    "  if (provider === 'binance-local') return provider;\n"
    "  return isBinanceProvider(provider) ? provider : 'vietnam';\n"
    "}\n\n"
    "function defaultSymbolsForProvider(provider: PriceProviderId): string[] {\n"
    "  return isCryptoProvider(provider) ? BINANCE_DEFAULT_SYMBOLS : DEFAULT_SYMBOLS;\n"
    "}",
)

replace_once(
    "  localStorage.setItem(ACTIVE_PROVIDER_KEY, provider);\n  localStorage.setItem(PROVIDER_ENABLED_KEY, 'true');\n\n  if (providerFamily(previousProvider) !== providerFamily(provider)) {",
    "  localStorage.setItem(ACTIVE_PROVIDER_KEY, provider);\n  localStorage.setItem(PROVIDER_ENABLED_KEY, 'true');\n\n"
    "  for (const tile of tiles) {\n"
    "    tile.syncIntervalOptions(provider);\n"
    "    if (!intervalAllowedForProvider(provider, tile.interval)) tile.setIntervalCode('30m', false);\n"
    "  }\n\n"
    "  if (providerFamily(previousProvider) !== providerFamily(provider)) {",
)

replace_once(
    "  if (activeProvider === 'binance-spot') {\n    return { feed: binanceSpotFeed, label: 'Binance Spot', unavailable: null };\n  }",
    "  if (activeProvider === 'binance-local') {\n"
    "    return { feed: binanceLocalFeed, label: 'Binance Local Archive', unavailable: null };\n"
    "  }\n"
    "  if (activeProvider === 'binance-spot') {\n"
    "    return { feed: binanceSpotFeed, label: 'Binance Spot', unavailable: null };\n"
    "  }",
)

replace_once(
    "    this.interval = INTERVALS.includes(initialPreferences.interval) ? initialPreferences.interval : '1d';\n    this.mode = initialPreferences.mode;",
    "    this.interval = INTERVALS.includes(initialPreferences.interval) ? initialPreferences.interval : '1d';\n"
    "    if (!intervalAllowedForProvider(activeProvider, this.interval)) this.interval = '30m';\n"
    "    this.mode = initialPreferences.mode;",
)

replace_once(
    "      option.textContent = intervalLabel(iv);\n      option.classList.toggle('active', iv === this.interval);",
    "      option.textContent = intervalLabel(iv);\n"
    "      option.hidden = !intervalAllowedForProvider(activeProvider, iv);\n"
    "      option.classList.toggle('active', iv === this.interval);",
)

replace_once(
    "  setIntervalCode(iv: string, reload = true): boolean {\n    if (!INTERVALS.includes(iv)) return false;",
    "  setIntervalCode(iv: string, reload = true): boolean {\n"
    "    if (!INTERVALS.includes(iv) || !intervalAllowedForProvider(activeProvider, iv)) return false;",
)

replace_once(
    "    if (reload) void this.load();\n    return true;\n  }\n\n  getTemplateSnapshot(): TileTemplate {",
    "    if (reload) void this.load();\n"
    "    return true;\n"
    "  }\n\n"
    "  syncIntervalOptions(provider: PriceProviderId = activeProvider): void {\n"
    "    for (const [value, button] of this.intervalButtons) {\n"
    "      button.hidden = !intervalAllowedForProvider(provider, value);\n"
    "    }\n"
    "  }\n\n"
    "  getTemplateSnapshot(): TileTemplate {",
)

replace_once(
    "    this.interval = INTERVALS.includes(template.interval) ? template.interval : this.interval;\n    this.intervalValueEl.textContent = intervalLabel(this.interval);",
    "    const requestedInterval = INTERVALS.includes(template.interval) ? template.interval : this.interval;\n"
    "    this.interval = intervalAllowedForProvider(activeProvider, requestedInterval) ? requestedInterval : '30m';\n"
    "    this.syncIntervalOptions();\n"
    "    this.intervalValueEl.textContent = intervalLabel(this.interval);",
)

replace_once(
    "    const providerId = activeProvider;\n    const provider = currentFeed();\n    if (!provider.feed) return;\n    if (provider.feed.name === 'Vnstock') return;",
    "    const providerId = activeProvider;\n"
    "    if (providerId === 'binance-local') return;\n"
    "    const provider = currentFeed();\n"
    "    if (!provider.feed) return;\n"
    "    if (provider.feed.name === 'Vnstock') return;",
)

replace_once(
    "    let cachedSource = 'IndexedDB';",
    "    let cachedSource = activeProvider === 'binance-local' ? 'SQLite' : 'IndexedDB';",
)

replace_once(
    "    try {\n      const step = intervalApproxSeconds(interval);",
    "    try {\n"
    "      if (providerId === 'binance-local') {\n"
    "        this.setFeedStatus('loading', 'đang kiểm tra SQLite...');\n"
    "        await binanceLocalFeed.ensureSymbol(symbol);\n"
    "        if (token !== this.loadToken || providerId !== activeProvider) return;\n"
    "      }\n\n"
    "      const step = intervalApproxSeconds(interval);",
)

replace_once(
    "      renderHistory(candles, !renderedCachedHistory);\n      if (range) {",
    "      renderHistory(candles, !renderedCachedHistory);\n"
    "      if (providerId === 'binance-local') {\n"
    "        this.setFeedStatus('sample', `${provider.label} · SQLite`);\n"
    "        if (activeTile === this) syncRangeUi();\n"
    "        return;\n"
    "      }\n"
    "      if (range) {",
)

replace_once(
    "    || DEFAULT_SYMBOLS[index % DEFAULT_SYMBOLS.length];",
    "    || defaultSymbolsForProvider(activeProvider)[index % defaultSymbolsForProvider(activeProvider).length];",
)

replace_once(
    "  tradingWorkspace?.refreshObjects();\n  refreshDrawingHistoryButtons();\n}",
    "  tradingWorkspace?.refreshObjects();\n"
    "  refreshDrawingHistoryButtons();\n"
    "  renderBinanceLocalControls();\n"
    "}",
)

replace_once(
    "  if (days >= 90) return '1h';\n  if (days >= 30) return '15m';",
    "  if (days >= 90) return '1h';\n"
    "  if (days >= 30) return activeProvider === 'binance-local' ? '30m' : '15m';",
)

replace_once(
    "let selectedProviderPanel: PriceProviderId = activeProvider;\nlet pendingProvider: PriceProviderId | null = null;",
    "let selectedProviderPanel: PriceProviderId = activeProvider;\n"
    "let pendingProvider: PriceProviderId | null = null;\n"
    "const binanceLocalUpdateButton = document.createElement('button');\n"
    "binanceLocalUpdateButton.type = 'button';\n"
    "binanceLocalUpdateButton.hidden = true;\n"
    "document.querySelector<HTMLElement>('#provider-box .provider-footer')?.prepend(binanceLocalUpdateButton);\n\n"
    "function renderBinanceLocalControls(): void {\n"
    "  const symbol = activeTile?.symbol ?? '';\n"
    "  const visible = providerEnabled && activeProvider === 'binance-local' && selectedProviderPanel === 'binance-local';\n"
    "  binanceLocalUpdateButton.hidden = !visible;\n"
    "  binanceLocalUpdateButton.disabled = !visible || !symbol;\n"
    "  binanceLocalUpdateButton.textContent = symbol ? `Update Data · ${symbol}` : 'Update Data';\n"
    "}",
)

replace_once(
    "function renderBinanceProviderStatus(provider: 'binance-spot' | 'binance-usdm'): void {",
    "function renderBinanceLocalProviderStatus(): void {\n"
    "  providerStatus.dataset.tone = 'success';\n"
    "  providerStatus.textContent = 'Binance Local Archive · SQLite trong project · 30m+ · không realtime · không tự cập nhật.';\n"
    "}\n\n"
    "function renderBinanceProviderStatus(provider: 'binance-spot' | 'binance-usdm'): void {",
)

replace_once(
    "    fiinquant: 'FiinQuant',\n    'binance-spot': 'Binance Spot',",
    "    fiinquant: 'FiinQuant',\n"
    "    'binance-local': 'Binance Local Archive',\n"
    "    'binance-spot': 'Binance Spot',",
)

replace_once(
    "  for (const provider of ['demo', 'binance-spot', 'binance-usdm', 'dnse', 'fiinquant'] as PriceProviderId[]) {",
    "  for (const provider of ['demo', 'binance-local', 'binance-spot', 'binance-usdm', 'dnse', 'fiinquant'] as PriceProviderId[]) {",
)

replace_once(
    "  if (provider === 'fiinquant') return 'FiinQuant';\n  return provider === 'binance-spot' ? 'Binance Spot' : 'Binance Futures';",
    "  if (provider === 'fiinquant') return 'FiinQuant';\n"
    "  if (provider === 'binance-local') return 'Binance Local Archive';\n"
    "  return provider === 'binance-spot' ? 'Binance Spot' : 'Binance Futures';",
)

replace_once(
    "      : activeProvider === 'fiinquant'\n        ? fiinState\n        : activeProvider === 'binance-spot'",
    "      : activeProvider === 'fiinquant'\n"
    "        ? fiinState\n"
    "        : activeProvider === 'binance-local'\n"
    "          ? 'SQLite · 30m+'\n"
    "          : activeProvider === 'binance-spot'",
)

replace_once(
    "    isBinanceProvider(activeProvider)\n      || (activeProvider === 'fiinquant'",
    "    activeProvider === 'binance-local'\n"
    "      || isBinanceProvider(activeProvider)\n"
    "      || (activeProvider === 'fiinquant'",
)

replace_once(
    "  } else if (activeProvider === 'dnse') {\n    renderDnseProviderStatus();\n  } else if (isBinanceProvider(activeProvider)) {",
    "  } else if (activeProvider === 'dnse') {\n"
    "    renderDnseProviderStatus();\n"
    "  } else if (activeProvider === 'binance-local') {\n"
    "    renderBinanceLocalProviderStatus();\n"
    "  } else if (isBinanceProvider(activeProvider)) {",
)

replace_once(
    "function setProviderPanel(provider: PriceProviderId): void {\n  selectedProviderPanel = provider;\n  delete providerStatus.dataset.tone;",
    "function setProviderPanel(provider: PriceProviderId): void {\n"
    "  selectedProviderPanel = provider;\n"
    "  delete providerStatus.dataset.tone;\n"
    "  providerStatus.hidden = provider !== 'binance-local';",
)

replace_once(
    "  } else if (provider === 'dnse') {\n    renderDnseProviderStatus();\n  } else if (isBinanceProvider(provider)) {",
    "  } else if (provider === 'dnse') {\n"
    "    renderDnseProviderStatus();\n"
    "  } else if (provider === 'binance-local') {\n"
    "    renderBinanceLocalProviderStatus();\n"
    "  } else if (isBinanceProvider(provider)) {",
)

replace_once(
    "  renderProviderConnectionSummary();\n}\n\nfunction openProviderDialog",
    "  renderProviderConnectionSummary();\n"
    "  renderBinanceLocalControls();\n"
    "}\n\n"
    "function openProviderDialog",
)

replace_once(
    "  if (isBinanceProvider(provider)) {\n    setActiveProvider(provider);\n    return;\n  }",
    "  if (provider === 'binance-local') {\n"
    "    setActiveProvider(provider);\n"
    "    return;\n"
    "  }\n"
    "  if (isBinanceProvider(provider)) {\n"
    "    setActiveProvider(provider);\n"
    "    return;\n"
    "  }",
)

replace_once(
    "      || value === 'dnse'\n      || value === 'binance-spot'",
    "      || value === 'dnse'\n"
    "      || value === 'binance-local'\n"
    "      || value === 'binance-spot'",
)

replace_once(
    "document.getElementById('binance-usdm-use')!.addEventListener('click', () => setActiveProvider('binance-usdm'));\n",
    "document.getElementById('binance-usdm-use')!.addEventListener('click', () => setActiveProvider('binance-usdm'));\n"
    "binanceLocalUpdateButton.addEventListener('click', () => {\n"
    "  if (!providerEnabled || activeProvider !== 'binance-local' || !activeTile) return;\n"
    "  const symbol = activeTile.symbol;\n"
    "  binanceLocalUpdateButton.disabled = true;\n"
    "  providerStatus.hidden = false;\n"
    "  delete providerStatus.dataset.tone;\n"
    "  providerStatus.textContent = `Đang cập nhật ${symbol} từ Binance Public Data Archive...`;\n"
    "  void binanceLocalFeed.refreshSymbol(symbol).then((status) => {\n"
    "    providerStatus.dataset.tone = 'success';\n"
    "    const last = status.lastTime ? new Date(status.lastTime * 1000).toLocaleString() : '--';\n"
    "    providerStatus.textContent = `${symbol} đã cập nhật local tới ${last}.`;\n"
    "    reloadAllTiles();\n"
    "  }).catch((error) => {\n"
    "    providerStatus.dataset.tone = 'error';\n"
    "    providerStatus.textContent = `Update thất bại, dữ liệu local cũ vẫn giữ nguyên: ${error instanceof Error ? error.message : String(error)}`;\n"
    "  }).finally(() => {\n"
    "    renderBinanceLocalControls();\n"
    "  });\n"
    "});\n",
)

replace_once(
    "      '15': '15m',\n      '60': '1h',",
    "      '15': '15m',\n"
    "      '30': '30m',\n"
    "      '60': '1h',",
)

PATH.write_text(text, encoding="utf-8")
print(f"patched {PATH}")
