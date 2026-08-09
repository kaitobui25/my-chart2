import type { Plugin } from 'vite';
import { scannerIntegration as quotaSafeScannerIntegration } from './vite-plugin-v3';

function lines(...values: string[]): string {
  return values.join('\n');
}

function replaceRequired(code: string, needle: string, replacement: string): string {
  if (!code.includes(needle)) {
    throw new Error(`FiinQuant startup gate marker is missing: ${needle.slice(0, 100)}`);
  }
  return code.replace(needle, replacement);
}

function patchFiinQuantStartupGate(original: string): string {
  let code = original;

  // Share one browser-side startup promise across chart loads, watchlist loads,
  // health checks, and scanner navigation. The server-side ensure route already
  // waits for sidecar health + auto-login; data requests may proceed only after
  // that route has completed successfully.
  code = replaceRequired(
    code,
    lines(
      'async function getAuthorizedFiinQuantHealth(): Promise<FiinQuantHealth | null> {',
      '  if (!await ensureFiinQuantRuntime()) return null;',
      '  fiinQuantHealthRequest += 1;',
    ),
    lines(
      'let fiinQuantRuntimeReadyForData = false;',
      'let fiinQuantRuntimeGate: Promise<boolean> | null = null;',
      '',
      'async function waitForFiinQuantRuntime(): Promise<boolean> {',
      '  if (fiinQuantRuntimeReadyForData) return true;',
      '  if (!fiinQuantRuntimeGate) {',
      '    fiinQuantRuntimeGate = ensureFiinQuantRuntime()',
      '      .then((ready) => {',
      '        if (ready) fiinQuantRuntimeReadyForData = true;',
      '        return ready;',
      '      })',
      '      .finally(() => {',
      '        if (!fiinQuantRuntimeReadyForData) fiinQuantRuntimeGate = null;',
      '      });',
      '  }',
      '  return fiinQuantRuntimeGate;',
      '}',
      '',
      'async function getAuthorizedFiinQuantHealth(): Promise<FiinQuantHealth | null> {',
      '  if (!await waitForFiinQuantRuntime()) return null;',
      '  fiinQuantHealthRequest += 1;',
    ),
  );

  // Any health check must also respect the gate. This covers startup refreshes
  // and user actions that happen while the Python process is still booting.
  code = replaceRequired(
    code,
    lines(
      'async function reportFiinQuantHealth(showChecking = true): Promise<void> {',
      '  const request = ++fiinQuantHealthRequest;',
    ),
    lines(
      'async function reportFiinQuantHealth(showChecking = true): Promise<void> {',
      '  if (!fiinQuantRuntimeReadyForData && !(await waitForFiinQuantRuntime())) return;',
      '  const request = ++fiinQuantHealthRequest;',
    ),
  );

  // Tile constructors call load() immediately. When FiinQuant was restored
  // from localStorage this used to race port 8720 before the lazy runtime had
  // started. Gate the load before it mutates loading state or opens realtime.
  code = replaceRequired(
    code,
    lines(
      '  async load(): Promise<void> {',
      '    if (this.replayActive) return;',
      '    const token = ++this.loadToken;',
    ),
    lines(
      '  async load(): Promise<void> {',
      '    if (this.replayActive) return;',
      '    const providerAtLoadStart = activeProvider;',
      "    if (providerAtLoadStart === 'fiinquant' && !(await waitForFiinQuantRuntime())) return;",
      '    if (providerAtLoadStart !== activeProvider) return;',
      '    const token = ++this.loadToken;',
    ),
  );

  // Watchlist startup can otherwise issue many history/subscription requests in
  // parallel with the chart. Queue only the latest requested watchlist sync and
  // resume it once FiinQuant is authenticated.
  code = replaceRequired(
    code,
    lines(
      'let watchlistGeneration = 0;',
      'let watchlistUnsubscribers: Array<() => void> = [];',
      '',
      'function syncWatchlistFeeds(seedSymbols: string[] = []): void {',
      '  watchlistGeneration += 1;',
    ),
    lines(
      'let watchlistGeneration = 0;',
      'let watchlistUnsubscribers: Array<() => void> = [];',
      'let fiinQuantWatchlistGateToken = 0;',
      '',
      'function syncWatchlistFeeds(seedSymbols: string[] = []): void {',
      "  if (activeProvider === 'fiinquant' && !fiinQuantRuntimeReadyForData) {",
      '    const gateToken = ++fiinQuantWatchlistGateToken;',
      '    void waitForFiinQuantRuntime().then((ready) => {',
      "      if (!ready || gateToken !== fiinQuantWatchlistGateToken || activeProvider !== 'fiinquant') return;",
      '      syncWatchlistFeeds(seedSymbols);',
      '    });',
      '    return;',
      '  }',
      '  fiinQuantWatchlistGateToken += 1;',
      '  watchlistGeneration += 1;',
    ),
  );

  // While a persisted FiinQuant session is restoring, render the startup state
  // instead of probing /fiinquant-api/health before port 8720 exists.
  code = replaceRequired(
    code,
    lines(
      '  } else if (isBinanceProvider(activeProvider)) {',
      '    renderBinanceProviderStatus(activeProvider);',
      '  } else {',
      '    void reportFiinQuantHealth();',
      '  }',
    ),
    lines(
      '  } else if (isBinanceProvider(activeProvider)) {',
      '    renderBinanceProviderStatus(activeProvider);',
      '  } else {',
      '    if (fiinQuantRuntimeReadyForData) void reportFiinQuantHealth();',
      "    else providerStatus.textContent = tr('Đang khởi động FiinQuant sidecar...');",
      '  }',
    ),
  );

  // Scanner navigation should share the same client-side gate instead of
  // creating another ensure request while startup is already in flight.
  code = replaceRequired(
    code,
    "    if (targetProvider === 'fiinquant' && !(await ensureFiinQuantRuntime())) return;",
    "    if (targetProvider === 'fiinquant' && !(await waitForFiinQuantRuntime())) return;",
  );

  // The original restore block reloaded every visible chart after ensure().
  // Tile.load() now waits on the same gate and resumes itself, so that reload
  // would duplicate the first history request. Keep only the health refresh.
  code = replaceRequired(
    code,
    lines(
      "if (activeProvider === 'fiinquant') {",
      '  void ensureFiinQuantRuntime().then((ready) => {',
      '    if (!ready) return;',
      '    void reportFiinQuantHealth(false);',
      '    reloadAllTiles();',
      '  });',
    ),
    lines(
      "if (activeProvider === 'fiinquant') {",
      '  void waitForFiinQuantRuntime().then((ready) => {',
      '    if (!ready) return;',
      '    void reportFiinQuantHealth(false);',
      '  });',
    ),
  );

  // If a later request proves that the sidecar disappeared, allow the next
  // data operation to go through the ensure route again instead of trusting a
  // stale ready flag forever.
  code = replaceRequired(
    code,
    lines(
      '  if (/cannot reach|failed to fetch|network|sidecar/i.test(message)) {',
      '    fiinQuantHealthRequest += 1;',
    ),
    lines(
      '  if (/cannot reach|failed to fetch|network|sidecar/i.test(message)) {',
      '    fiinQuantRuntimeReadyForData = false;',
      '    fiinQuantRuntimeGate = null;',
      '    fiinQuantHealthRequest += 1;',
    ),
  );

  return code;
}

function runQuotaSafeTransform(
  previous: Plugin,
  context: unknown,
  code: string,
  id: string,
): any {
  const hook = previous.transform as unknown as ((this: unknown, source: string, moduleId: string) => unknown) | undefined;
  if (!hook) return null;
  const result = hook.call(context, code, id) as string | { code: string; map?: unknown } | null;
  if (!result) return null;
  if (typeof result === 'string') return patchFiinQuantStartupGate(result);
  return { ...result, code: patchFiinQuantStartupGate(result.code) };
}

export function scannerIntegration(): Plugin {
  const previous = quotaSafeScannerIntegration();
  return {
    ...previous,
    name: 'l2chart-scanner-provider-startup-gate',
    transform(code, id) {
      return runQuotaSafeTransform(previous, this, code, id);
    },
  };
}
