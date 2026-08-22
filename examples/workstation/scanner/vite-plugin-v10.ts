import type { Plugin } from 'vite';
import { scannerIntegration as providerAwareTileScannerIntegration } from './vite-plugin-v9';

function lines(...values: string[]): string {
  return values.join('\n');
}

function patchOlderHistoryPriority(code: string): string {
  const needle = lines(
    '    ) return;',
    '',
    '    const providerId = activeProvider;',
    '    const provider = currentFeed();',
    '    if (!provider.feed) return;',
    '    const loadToken = this.loadToken;',
    '    const oldestTime = this.history[0].time;',
  );
  const replacement = lines(
    '    ) return;',
    '',
    '    // Older-history pagination is background work. Let foreground symbol/',
    '    // timeframe loads settle first so a second chart never competes with',
    '    // automatic backfill for the same Binance browser/network budget.',
    '    await candleDataCoordinator.waitUntilIdle();',
    '    if (',
    '      this.loading',
    '      || this.realtimeGapLoading',
    '      || this.historyPageLoading',
    '      || this.historyPageExhausted',
    '      || this.historyRange',
    '      || this.replayActive',
    '      || this.history.length === 0',
    '      || Date.now() < this.historyPageRetryAfter',
    '      || tiles.some((tile) => tile !== this && tile.loading)',
    '    ) return;',
    '',
    '    const providerId = activeProvider;',
    '    const provider = currentFeed();',
    '    if (!provider.feed) return;',
    '    const loadToken = this.loadToken;',
    '    const oldestTime = this.history[0].time;',
  );
  if (!code.includes(needle)) {
    throw new Error(`Older-history priority marker is missing: ${needle.slice(0, 120)}`);
  }
  return code.replace(needle, replacement);
}

function runProviderAwareTileTransform(
  previous: Plugin,
  context: unknown,
  code: string,
  id: string,
): any {
  const hook = previous.transform as unknown as ((this: unknown, source: string, moduleId: string) => unknown) | undefined;
  if (!hook) return null;
  const result = hook.call(context, code, id) as string | { code: string; map?: unknown } | null;
  if (!result) return null;
  if (typeof result === 'string') return patchOlderHistoryPriority(result);
  return { ...result, code: patchOlderHistoryPriority(result.code) };
}

export function scannerIntegration(): Plugin {
  const previous = providerAwareTileScannerIntegration();
  return {
    ...previous,
    name: 'l2chart-scanner-history-priority',
    transform(code, id) {
      return runProviderAwareTileTransform(previous, this, code, id);
    },
  };
}
