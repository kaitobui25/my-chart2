import type { Plugin } from 'vite';
import { scannerIntegration as binanceMultiChartScannerIntegration } from './vite-plugin-v8';

function lines(...values: string[]): string {
  return values.join('\n');
}

function patchProviderAwareTileDefaults(code: string): string {
  const needle = lines(
    'function createTileForSlot(index: number, template?: TileTemplate): Tile {',
    '  const savedSymbol = uiPreferences.symbols[index]?.trim().toUpperCase();',
    '  const symbol = template?.symbol?.trim().toUpperCase()',
    '    || savedSymbol',
    '    || defaultSymbolsForProvider(activeProvider)[index % defaultSymbolsForProvider(activeProvider).length];',
  );
  const replacement = lines(
    'function createTileForSlot(index: number, template?: TileTemplate): Tile {',
    '  const providerDefaults = defaultSymbolsForProvider(activeProvider);',
    '  // Extra Binance slots can contain stale Vietnam symbols preserved from a',
    '  // previous one-chart workspace. Explicit template/autosave symbols still win.',
    '  const savedSymbol = isCryptoProvider(activeProvider) && index > 0',
    '    ? undefined',
    '    : uiPreferences.symbols[index]?.trim().toUpperCase();',
    '  const symbol = template?.symbol?.trim().toUpperCase()',
    '    || savedSymbol',
    '    || providerDefaults[index % providerDefaults.length];',
  );
  if (!code.includes(needle)) {
    throw new Error(`Provider-aware tile default marker is missing: ${needle.slice(0, 120)}`);
  }
  return code.replace(needle, replacement);
}

function runBinanceMultiChartTransform(
  previous: Plugin,
  context: unknown,
  code: string,
  id: string,
): any {
  const hook = previous.transform as unknown as ((this: unknown, source: string, moduleId: string) => unknown) | undefined;
  if (!hook) return null;
  const result = hook.call(context, code, id) as string | { code: string; map?: unknown } | null;
  if (!result) return null;
  if (typeof result === 'string') return patchProviderAwareTileDefaults(result);
  return { ...result, code: patchProviderAwareTileDefaults(result.code) };
}

export function scannerIntegration(): Plugin {
  const previous = binanceMultiChartScannerIntegration();
  return {
    ...previous,
    name: 'l2chart-scanner-provider-aware-tile-defaults',
    transform(code, id) {
      return runBinanceMultiChartTransform(previous, this, code, id);
    },
  };
}
