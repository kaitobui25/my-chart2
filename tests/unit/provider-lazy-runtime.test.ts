import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scannerIntegration } from '../../examples/workstation/scanner/vite-plugin';
import { hasCurrentFiinQuantRuntime } from '../../examples/workstation/provider-runtime/vite-plugin';

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

describe('lazy chart provider lifecycle', () => {
  it('rejects an already-running FiinQuant sidecar with a stale dependency stack', () => {
    expect(hasCurrentFiinQuantRuntime({
      fiinquantx: '0.1.67',
      signalrcore: '0.9.71',
      msgpack: '1.2.1',
    })).toBe(true);
    expect(hasCurrentFiinQuantRuntime({
      fiinquantx: '0.1.67',
      signalrcore: '1.0.2',
      msgpack: '1.1.2',
    })).toBe(false);
    expect(hasCurrentFiinQuantRuntime(undefined)).toBe(false);
  });

  it('keeps Vnstock idle until explicitly used', async () => {
    const code = await transformedWorkstation();
    expect(code).toContain("type VnstockConnectionState = 'idle' | 'checking' | 'connected' | 'offline';");
    expect(code).toContain("let vnstockConnectionState: VnstockConnectionState = 'idle';");
    expect(code).toContain("if (await reportVnstockHealth()) setActiveProvider('vnstock');");
    expect(code).not.toContain('refreshProviderUi();\nvoid reportVnstockHealth(false);');
  });

  it('starts FiinQuant runtime from the browser use flow', async () => {
    const code = await transformedWorkstation();
    expect(code).toContain("fetch('/provider-runtime/fiinquant/ensure'");
    expect(code).toContain('if (!await waitForFiinQuantRuntime()) return null;');
    expect(code).toContain("FiinQuant chưa kết nối. Bấm Dùng để khởi động sidecar.");
  });

  it('restores only the provider persisted by the workstation', async () => {
    const main = readFileSync(path.resolve('examples/workstation/main.ts'), 'utf8');
    const code = await transformedWorkstation();
    expect(main).toContain("const ACTIVE_PROVIDER_KEY = 'l2chart.priceProvider';");
    expect(main).toContain('localStorage.setItem(ACTIVE_PROVIDER_KEY, provider);');
    expect(code).toContain("if (activeProvider === 'fiinquant') {");
    expect(code).toContain("} else if (activeProvider === 'vnstock') {");
  });

  it('opens scanner results without loading hidden or stale symbols', async () => {
    const code = await transformedWorkstation();
    expect(code).toContain('for (const tile of visibleTilesForLayout(activeLayout)) void tile.load();');
    expect(code).not.toContain('for (const tile of tiles) void tile.load();');
    expect(code).toContain('function setActiveProvider(provider: PriceProviderId, preserveActiveSymbol = false): void {');
    expect(code).toContain('if (activeSymbolBeforeProviderSwitch) activeTile?.setSymbol(activeSymbolBeforeProviderSwitch, false);');

    const stageSymbol = code.indexOf('activeTile?.setSymbol(nextSymbol, false);');
    const switchProvider = code.indexOf('setActiveProvider(targetProvider, true);');
    expect(stageSymbol).toBeGreaterThan(-1);
    expect(switchProvider).toBeGreaterThan(stageSymbol);
  });

  it('gates persisted FiinQuant startup before chart and watchlist data requests', async () => {
    const code = await transformedWorkstation();
    expect(code).toContain('let fiinQuantRuntimeGate: Promise<boolean> | null = null;');
    expect(code).toContain("if (providerAtLoadStart === 'fiinquant' && !(await waitForFiinQuantRuntime())) return;");
    expect(code).toContain("if (activeProvider === 'fiinquant' && !fiinQuantRuntimeReadyForData) {");
    expect(code).toContain('if (!fiinQuantRuntimeReadyForData && !(await waitForFiinQuantRuntime())) return;');
    expect(code).toContain("if (targetProvider === 'fiinquant' && !(await waitForFiinQuantRuntime())) return;");
    expect(code).not.toContain('void ensureFiinQuantRuntime().then((ready) => {');

    const restoreStart = code.indexOf("if (activeProvider === 'fiinquant') {");
    const restoreEnd = code.indexOf("} else if (activeProvider === 'vnstock') {", restoreStart);
    const restoreBlock = code.slice(restoreStart, restoreEnd);
    expect(restoreBlock).toContain('void waitForFiinQuantRuntime().then((ready) => {');
    expect(restoreBlock).not.toContain('reloadAllTiles();');
  });

  it('offers direct FiinQuant symbols when TickerList autocomplete omits them', async () => {
    const code = await transformedWorkstation();
    expect(code).toContain("const directSymbol = query.trim().toUpperCase();");
    expect(code).toContain("activeProvider === 'fiinquant'");
    expect(code).toContain("? { symbol: directSymbol, name: 'Direct symbol', exchange: 'FiinQuant' } satisfies SymbolSearchResult");
    expect(code).toContain("const directSymbol = command.value.trim().toUpperCase();");
    expect(code).toContain("const message = `không có dữ liệu ${this.symbol}`;");
  });

  it('does not spend FiinQuant ticker quota on background watchlist feeds', async () => {
    const code = await transformedWorkstation();
    const watchlistStart = code.indexOf('function syncWatchlistFeeds(seedSymbols: string[] = []): void {');
    expect(watchlistStart).toBeGreaterThan(-1);
    const watchlistBlock = code.slice(watchlistStart, watchlistStart + 4000);
    const clearSubscriptions = watchlistBlock.indexOf('watchlistUnsubscribers = [];');
    const fiinQuantReturn = watchlistBlock.indexOf("if (activeProvider === 'fiinquant') return;");
    const providerLookup = watchlistBlock.indexOf('const provider = currentFeed();');
    const bulkSubscription = watchlistBlock.indexOf('provider.feed.subscribeMany');
    expect(clearSubscriptions).toBeGreaterThan(-1);
    expect(fiinQuantReturn).toBeGreaterThan(clearSubscriptions);
    expect(providerLookup).toBeGreaterThan(fiinQuantReturn);
    expect(bulkSubscription).toBeGreaterThan(providerLookup);
  });

  it('upgrades a stale managed FiinQuant environment to the pinned provider stack', () => {
    const baseRequirements = readFileSync(
      path.resolve('examples/sidecars/fiinquant/requirements.txt'),
      'utf8',
    );
    const providerRequirements = readFileSync(
      path.resolve('examples/sidecars/fiinquant/requirements-provider.txt'),
      'utf8',
    );
    const runtime = readFileSync(
      path.resolve('examples/workstation/provider-runtime/vite-plugin.ts'),
      'utf8',
    );

    expect(baseRequirements).toContain('msgpack==1.2.1');
    expect(providerRequirements).toContain('fiinquantx==0.1.67');
    expect(providerRequirements).toContain('signalrcore==0.9.71');
    expect(runtime).toContain("const FIINQUANT_REQUIRED_VERSION = providerRequirementVersion('fiinquantx');");
    expect(runtime).toContain("const SIGNALRCORE_REQUIRED_VERSION = providerRequirementVersion('signalrcore');");
    expect(runtime).toContain("const MSGPACK_REQUIRED_VERSION = pinnedRequirementVersion(FIINQUANT_REQUIREMENTS_PATH, 'msgpack');");
    expect(runtime).toContain('function hasCurrentFiinQuantDependencies(spec: CommandSpec): boolean {');
    expect(runtime).toContain('Updating local Python environment to FiinQuantX ${FIINQUANT_REQUIRED_VERSION}');
    expect(runtime).toContain("'--no-deps', `msgpack==${MSGPACK_REQUIRED_VERSION}`");
    expect(runtime).toContain("middlewares.use('/fiinquant-api'");
    expect(runtime).toContain('await startup;');
    expect(runtime).not.toContain("'-m', 'pip', 'check'");
  });
});
