import type { Plugin } from 'vite';
import { scannerIntegration as directSymbolScannerIntegration } from './vite-plugin-v5';

function lines(...values: string[]): string {
  return values.join('\n');
}

function replaceRequired(code: string, needle: string, replacement: string): string {
  if (!code.includes(needle)) {
    throw new Error(`FiinQuant watchlist quota marker is missing: ${needle.slice(0, 100)}`);
  }
  return code.replace(needle, replacement);
}

function patchFiinQuantWatchlistQuota(original: string): string {
  let code = original;

  // FiinQuant accounts can cap the number of stock codes accessible in one
  // session. The workstation watchlist previously seeded every symbol with a
  // history request and then subscribed the full list through subscribeMany(),
  // consuming that quota before the user opened a chart. For FiinQuant, keep
  // the watchlist passive: visible chart tiles still publish their own candles
  // into MarketHub, but background watchlist history/realtime requests are not
  // allowed to allocate additional FiinQuant symbols.
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
  if (typeof result === 'string') return patchFiinQuantWatchlistQuota(result);
  return { ...result, code: patchFiinQuantWatchlistQuota(result.code) };
}

export function scannerIntegration(): Plugin {
  const previous = directSymbolScannerIntegration();
  return {
    ...previous,
    name: 'l2chart-scanner-fiinquant-watchlist-quota',
    transform(code, id) {
      return runDirectSymbolTransform(previous, this, code, id);
    },
  };
}
