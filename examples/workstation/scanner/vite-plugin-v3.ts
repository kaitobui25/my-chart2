import type { Plugin } from 'vite';
import { scannerIntegration as lazyScannerIntegration } from './vite-plugin-v2';

function lines(...values: string[]): string {
  return values.join('\n');
}

function replaceRequired(code: string, needle: string, replacement: string): string {
  if (!code.includes(needle)) {
    throw new Error(`Scanner chart reload marker is missing: ${needle.slice(0, 100)}`);
  }
  return code.replace(needle, replacement);
}

function patchScannerChartReload(original: string): string {
  let code = original;

  // A tile remains in the workstation tile array after switching back to a
  // smaller layout. Reloading the entire array therefore spends provider
  // quota on hidden/stale symbols. Only charts visible in the active layout
  // should participate in a provider reload.
  code = replaceRequired(
    code,
    lines(
      'function reloadAllTiles(): void {',
      '  replaySession?.stop(false);',
      '  for (const tile of tiles) void tile.load();',
      '}',
    ),
    lines(
      'function reloadAllTiles(): void {',
      '  replaySession?.stop(false);',
      '  for (const tile of visibleTilesForLayout(activeLayout)) void tile.load();',
      '}',
    ),
  );

  // Scanner navigation stages the requested symbol before switching the
  // provider. Preserve that active symbol if the switch also crosses the
  // Vietnam/Binance provider-family boundary, where setActiveProvider normally
  // resets every tile to a provider default.
  code = replaceRequired(
    code,
    'function setActiveProvider(provider: PriceProviderId): void {',
    lines(
      'function setActiveProvider(provider: PriceProviderId, preserveActiveSymbol = false): void {',
      '  const activeSymbolBeforeProviderSwitch = preserveActiveSymbol ? activeTile?.symbol ?? null : null;',
    ),
  );

  code = replaceRequired(
    code,
    lines(
      '  if (providerFamily(previousProvider) !== providerFamily(provider)) {',
      '    const defaultSymbol = defaultSymbolsForProvider(provider)[0];',
      '    for (const tile of tiles) tile.setSymbol(defaultSymbol, false);',
      '  }',
    ),
    lines(
      '  if (providerFamily(previousProvider) !== providerFamily(provider)) {',
      '    const defaultSymbol = defaultSymbolsForProvider(provider)[0];',
      '    for (const tile of tiles) tile.setSymbol(defaultSymbol, false);',
      '    if (activeSymbolBeforeProviderSwitch) activeTile?.setSymbol(activeSymbolBeforeProviderSwitch, false);',
      '  }',
    ),
  );

  // The lazy-provider wrapper currently switches provider first. That invokes
  // reloadAllTiles with the old active symbol, then setSymbol loads the clicked
  // scanner symbol a second time. Stage the symbol without loading, then let
  // the provider switch perform the one intended visible-chart reload.
  code = replaceRequired(
    code,
    lines(
      '  async openSymbol(symbol) {',
      '    const providerMap = {',
      "      fiinquant: 'fiinquant',",
      "      vn_eod: 'fiinquant',",
      "      vnstock: 'vnstock',",
      "      binance_spot: 'binance-spot',",
      "      binance_usdm: 'binance-usdm',",
      '    };',
      "    const scannerSource = document.getElementById('scanner-source')?.value ?? '';",
      '    const targetProvider = providerMap[String(scannerSource)];',
      "    if (targetProvider === 'fiinquant' && !(await ensureFiinQuantRuntime())) return;",
      "    if (targetProvider === 'vnstock' && !(await reportVnstockHealth(false))) return;",
      '    if (targetProvider && activeProvider !== targetProvider) setActiveProvider(targetProvider);',
      "    activeTile?.setSymbol(String(symbol ?? ''));",
      '  },',
    ),
    lines(
      '  async openSymbol(symbol) {',
      '    const providerMap = {',
      "      fiinquant: 'fiinquant',",
      "      vn_eod: 'fiinquant',",
      "      vnstock: 'vnstock',",
      "      binance_spot: 'binance-spot',",
      "      binance_usdm: 'binance-usdm',",
      '    };',
      "    const scannerSource = document.getElementById('scanner-source')?.value ?? '';",
      '    const targetProvider = providerMap[String(scannerSource)];',
      "    if (targetProvider === 'fiinquant' && !(await ensureFiinQuantRuntime())) return;",
      "    if (targetProvider === 'vnstock' && !(await reportVnstockHealth(false))) return;",
      "    const nextSymbol = String(symbol ?? '');",
      '    if (targetProvider && activeProvider !== targetProvider) {',
      '      activeTile?.setSymbol(nextSymbol, false);',
      '      setActiveProvider(targetProvider, true);',
      '    } else {',
      '      activeTile?.setSymbol(nextSymbol);',
      '    }',
      '  },',
    ),
  );

  return code;
}

function runLazyTransform(
  lazy: Plugin,
  context: unknown,
  code: string,
  id: string,
): any {
  const hook = lazy.transform as unknown as ((this: unknown, source: string, moduleId: string) => unknown) | undefined;
  if (!hook) return null;
  const result = hook.call(context, code, id) as string | { code: string; map?: unknown } | null;
  if (!result) return null;
  if (typeof result === 'string') return patchScannerChartReload(result);
  return { ...result, code: patchScannerChartReload(result.code) };
}

export function scannerIntegration(): Plugin {
  const lazy = lazyScannerIntegration();
  return {
    ...lazy,
    name: 'l2chart-scanner-visible-provider-integration',
    transform(code, id) {
      return runLazyTransform(lazy, this, code, id);
    },
  };
}
