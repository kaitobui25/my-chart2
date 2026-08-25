import type { Plugin } from 'vite';
import { scannerIntegration as providerWatchlistScannerIntegration } from './vite-plugin-v6';

function lines(...values: string[]): string {
  return values.join('\n');
}

function replaceRequired(code: string, needle: string, replacement: string): string {
  if (!code.includes(needle)) {
    throw new Error(`Candle load isolation marker is missing: ${needle.slice(0, 100)}`);
  }
  return code.replace(needle, replacement);
}

function patchCandleLoadIsolation(original: string): string {
  let code = original;

  // AbortError is used both for browser/provider cancellation and request
  // timeout paths. It is a load-local interruption, not evidence that the
  // selected provider should be globally disabled.
  code = replaceRequired(
    code,
    lines(
      'function pricePrecisionForSymbol(symbol: string): number | null {',
      '  return /^VN30F/i.test(symbol.trim()) ? 1 : null;',
      '}',
      '',
      'function mergeRealtimeCandle(base: Candle, update: Candle): Candle {',
    ),
    lines(
      'function pricePrecisionForSymbol(symbol: string): number | null {',
      '  return /^VN30F/i.test(symbol.trim()) ? 1 : null;',
      '}',
      '',
      'function isAbortError(error: unknown): boolean {',
      "  return typeof error === 'object'",
      '    && error !== null',
      "    && 'name' in error",
      "    && (error as { name?: unknown }).name === 'AbortError';",
      '}',
      '',
      'function mergeRealtimeCandle(base: Candle, update: Candle): Candle {',
    ),
  );

  // Keep the identity of the dataset currently held by Tile.history. A symbol,
  // timeframe, or provider switch must never let candles from the previous
  // dataset count as renderable data for the new load.
  code = replaceRequired(
    code,
    lines(
      '  private history: Candle[] = [];',
      '  private replayActive = false;',
    ),
    lines(
      '  private history: Candle[] = [];',
      '  private historyDatasetKey: string | null = null;',
      '  private replayActive = false;',
    ),
  );

  code = replaceRequired(
    code,
    '    let hadRenderableData = this.history.length > 0;',
    '    let hadRenderableData = false;',
  );

  code = replaceRequired(
    code,
    lines(
      '    const providerId = activeProvider;',
      '    const provider = currentFeed();',
      '    this.chart.setLegendTitle(`${symbol} · ${intervalLabel(interval)}`);',
    ),
    lines(
      '    const providerId = activeProvider;',
      '    const provider = currentFeed();',
      '    const datasetKey = candleDatasetKey(providerId, symbol, interval);',
      '    if (this.historyDatasetKey !== datasetKey) {',
      '      this.history = [];',
      '      this.historyDatasetKey = null;',
      '      this.chart.setData([]);',
      '    }',
      '    hadRenderableData = this.history.length > 0;',
      '    this.chart.setLegendTitle(`${symbol} · ${intervalLabel(interval)}`);',
    ),
  );

  code = replaceRequired(
    code,
    lines(
      '    if (!provider.feed) {',
      '      this.history = [];',
      '      this.chart.setData([]);',
    ),
    lines(
      '    if (!provider.feed) {',
      '      this.history = [];',
      '      this.historyDatasetKey = null;',
      '      this.chart.setData([]);',
    ),
  );

  code = replaceRequired(
    code,
    lines(
      '        this.chart.setIntervalSec(step);',
      '        this.history = candles.map((candle) => ({ ...candle }));',
      '        this.chart.setData(this.history.map((candle) => ({ ...candle })));',
    ),
    lines(
      '        this.chart.setIntervalSec(step);',
      '        this.history = candles.map((candle) => ({ ...candle }));',
      '        this.historyDatasetKey = datasetKey;',
      '        this.chart.setData(this.history.map((candle) => ({ ...candle })));',
    ),
  );

  code = replaceRequired(
    code,
    lines(
      '        if (renderedCachedHistory) return;',
      '        if (!hadRenderableData) this.history = [];',
      '        const message = `không có dữ liệu ${symbol}`;',
    ),
    lines(
      '        if (renderedCachedHistory) return;',
      '        if (!hadRenderableData) {',
      '          this.history = [];',
      '          this.historyDatasetKey = null;',
      '          this.chart.setData([]);',
      '        }',
      '        const message = `không có dữ liệu ${symbol}`;',
    ),
  );

  code = replaceRequired(
    code,
    lines(
      '    } catch (err) {',
      '      if (token !== this.loadToken) return;',
      '      console.error(err);',
      '      if (renderedCachedHistory) {',
      '        this.setLoadState(null);',
      '        this.setFeedStatus(\'sample\', `${provider.label} · ${cachedSource}`);',
      '        return;',
      '      }',
      '      if (!hadRenderableData) {',
      '        this.history = [];',
      '        this.chart.setData([]);',
      '      }',
      "      const message = err instanceof Error ? err.message : 'lỗi nguồn giá';",
      '      reportProviderLoadFailure(providerId, message);',
      "      this.setFeedStatus('error', message);",
      "      this.setLoadState('error', message);",
    ),
    lines(
      '    } catch (err) {',
      '      if (token !== this.loadToken) return;',
      '      if (renderedCachedHistory) {',
      '        this.setLoadState(null);',
      '        this.setFeedStatus(\'sample\', `${provider.label} · ${cachedSource}`);',
      '        return;',
      '      }',
      '      if (isAbortError(err)) {',
      '        console.warn(`${provider.label} ${symbol} ${interval} load interrupted`, err);',
      '        if (hadRenderableData) {',
      '          this.setLoadState(null);',
      "          this.setFeedStatus('sample', `${provider.label} · giữ dữ liệu hiện tại`);",
      '          return;',
      '        }',
      '        this.history = [];',
      '        this.historyDatasetKey = null;',
      '        this.chart.setData([]);',
      "        const message = getLocale() === 'vi'",
      "          ? 'yêu cầu dữ liệu bị gián đoạn; thử lại'",
      "          : 'data request interrupted; try again';",
      "        this.setFeedStatus('error', message);",
      "        this.setLoadState('error', message);",
      '        return;',
      '      }',
      '      console.error(err);',
      '      if (!hadRenderableData) {',
      '        this.history = [];',
      '        this.historyDatasetKey = null;',
      '        this.chart.setData([]);',
      '      }',
      "      const message = err instanceof Error ? err.message : 'lỗi nguồn giá';",
      '      reportProviderLoadFailure(providerId, message);',
      "      this.setFeedStatus('error', message);",
      "      this.setLoadState('error', message);",
    ),
  );

  return code;
}

function runProviderWatchlistTransform(
  previous: Plugin,
  context: unknown,
  code: string,
  id: string,
): any {
  const hook = previous.transform as unknown as ((this: unknown, source: string, moduleId: string) => unknown) | undefined;
  if (!hook) return null;
  const result = hook.call(context, code, id) as string | { code: string; map?: unknown } | null;
  if (!result) return null;
  if (typeof result === 'string') return patchCandleLoadIsolation(result);
  return { ...result, code: patchCandleLoadIsolation(result.code) };
}

export function scannerIntegration(): Plugin {
  const previous = providerWatchlistScannerIntegration();
  return {
    ...previous,
    name: 'l2chart-scanner-candle-load-isolation',
    transform(code, id) {
      return runProviderWatchlistTransform(previous, this, code, id);
    },
  };
}
