import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scannerIntegration } from '../../examples/workstation/scanner/vite-plugin';

async function transformedWorkstation(): Promise<string> {
  const sourcePath = path.resolve('examples/workstation/main.ts');
  const source = readFileSync(sourcePath, 'utf8');
  const plugin = scannerIntegration();
  const hook = plugin.transform;
  if (typeof hook !== 'function') throw new Error('scanner transform hook is unavailable');
  const result = await hook.call({} as never, source, sourcePath, { moduleType: 'js' } as never);
  if (!result) throw new Error('scanner transform returned no workstation code');
  return typeof result === 'string' ? result : String(result.code ?? '');
}

describe('candle load isolation', () => {
  it('drops history from a previous provider/symbol/timeframe before classifying current data', async () => {
    const code = await transformedWorkstation();
    const loadStart = code.indexOf('  async load(): Promise<void> {');
    const loadEnd = code.indexOf('  private async loadOlderHistory(): Promise<void> {', loadStart);
    const load = code.slice(loadStart, loadEnd);

    expect(code).toContain('private historyDatasetKey: string | null = null;');
    expect(load).toContain('const datasetKey = candleDatasetKey(providerId, symbol, interval);');

    const identityGuard = load.indexOf('if (this.historyDatasetKey !== datasetKey) {');
    const clearChart = load.indexOf('this.chart.setData([]);', identityGuard);
    const renderableCheck = load.indexOf('hadRenderableData = this.history.length > 0;', identityGuard);
    expect(identityGuard).toBeGreaterThan(-1);
    expect(clearChart).toBeGreaterThan(identityGuard);
    expect(renderableCheck).toBeGreaterThan(clearChart);

    const renderHistory = load.indexOf('this.historyDatasetKey = datasetKey;');
    expect(renderHistory).toBeGreaterThan(renderableCheck);
  });

  it('keeps AbortError local to the tile instead of disabling the active provider', async () => {
    const code = await transformedWorkstation();
    expect(code).toContain("(error as { name?: unknown }).name === 'AbortError';");

    const abortStart = code.indexOf('if (isAbortError(err)) {');
    const genericError = code.indexOf('console.error(err);', abortStart);
    const abortBlock = code.slice(abortStart, genericError);
    expect(abortStart).toBeGreaterThan(-1);
    expect(genericError).toBeGreaterThan(abortStart);
    expect(abortBlock).toContain('this.historyDatasetKey = null;');
    expect(abortBlock).toContain("this.setFeedStatus('error', message);");
    expect(abortBlock).not.toContain('reportProviderLoadFailure');

    const providerFailure = code.indexOf('reportProviderLoadFailure(providerId, message);', genericError);
    expect(providerFailure).toBeGreaterThan(genericError);
  });
});
