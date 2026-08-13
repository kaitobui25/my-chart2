import type { Plugin } from 'vite';
import { scannerIntegration as directSymbolScannerIntegration } from './vite-plugin-v5';

function lines(...values: string[]): string {
  return values.join('\n');
}

function replaceRequired(code: string, needle: string, replacement: string): string {
  if (!code.includes(needle)) {
    throw new Error(`Provider routing marker is missing: ${needle.slice(0, 100)}`);
  }
  return code.replace(needle, replacement);
}

function patchProviderWatchlistRouting(original: string): string {
  let code = original;

  // The base Vnstock integration injects the raw datafeed import. Route the
  // workstation through the guarded adapter so stale workspace/watchlist state
  // can never send obvious crypto pairs to the Vietnam-market sidecar.
  code = replaceRequired(
    code,
    "import { VnstockDatafeed, type VnstockHealth } from '../providers/vnstock';",
    "import { VnstockDatafeed, isVnstockRoutableSymbol, type VnstockHealth } from '../providers/vnstock-routed';",
  );

  // FiinQuant accounts can cap the number of stock codes accessible in one
  // session. Keep that provider chart-first: background watchlist rows must not
  // allocate additional FiinQuant symbols.
  code = replaceRequired(
    code,
    lines(
      '  for (const unsubscribe of watchlistUnsubscribers) unsubscribe();',
      '  watchlistUnsubscribers = [];',
      '',
      '  const provider = currentFeed();',
    ),
    lines(
      '  for (const unsubscribe of watchlistUnsubscribers) unsubscribe();',
      '  watchlistUnsubscribers = [];',
      "  if (activeProvider === 'fiinquant') return;",
      '',
      '  const provider = currentFeed();',
    ),
  );

  // Provider watchlists are persisted separately, but old autosave/localStorage
  // can still contain symbols from another market. Filter before subscription
  // as the first guard; VnstockDatafeed repeats the same guard at its network
  // boundary so a future caller cannot bypass it.
  code = replaceRequired(
    code,
    lines(
      '  for (const rawSymbol of tradingWorkspace.getWatchlist()) {',
      '    const symbol = rawSymbol.trim().toUpperCase();',
      "    const feedSymbol = activeProvider === 'dnse' ? normalizeDnseSymbol(symbol) : symbol;",
      '    if (!feedSymbol) continue;',
    ),
    lines(
      '  for (const rawSymbol of tradingWorkspace.getWatchlist()) {',
      '    const symbol = rawSymbol.trim().toUpperCase();',
      "    if (activeProvider === 'vnstock' && !isVnstockRoutableSymbol(symbol)) continue;",
      "    const feedSymbol = activeProvider === 'dnse' ? normalizeDnseSymbol(symbol) : symbol;",
      '    if (!feedSymbol) continue;',
    ),
  );

  return code;
}

function runDirectSymbolTransform(
  previous: Plugin,
  context: unknown,
  code: string,
  id: string,
): any {
  const hook = previous.transform as unknown as ((this: unknown, source: string, moduleId: string) => unknown) | undefined;
  if (!hook) return null;
  const result = hook.call(context, code, id) as string | { code: string; map?: unknown } | null;
  if (!result) return null;
  if (typeof result === 'string') return patchProviderWatchlistRouting(result);
  return { ...result, code: patchProviderWatchlistRouting(result.code) };
}

export function scannerIntegration(): Plugin {
  const previous = directSymbolScannerIntegration();
  return {
    ...previous,
    name: 'l2chart-scanner-provider-watchlist-routing',
    transform(code, id) {
      return runDirectSymbolTransform(previous, this, code, id);
    },
  };
}
