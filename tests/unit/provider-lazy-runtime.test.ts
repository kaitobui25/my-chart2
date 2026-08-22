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
    expect(code).toContain("showProviderActivationError('vnstock'");
    expect(code).not.toContain('refreshProviderUi();\nvoid reportVnstockHealth(false);');
  });

  it('starts FiinQuant runtime from the browser use flow', async () => {
    const code = await transformedWorkstation();
    expect(code).toContain("fetch('/provider-runtime/fiinquant/ensure'");
    expect(code).toContain('if (!await waitForFiinQuantRuntime()) return null;');
    expect(code).toContain("FiinQuant chưa kết nối. Bấm Dùng để khởi động sidecar.");
  });

  it('restores the provider from auto save before the regular workstation preference', async () => {
    const main = readFileSync(path.resolve('examples/workstation/main.ts'), 'utf8');
    const code = await transformedWorkstation();
    expect(main).toContain("const ACTIVE_PROVIDER_KEY = 'l2chart.priceProvider';");
    expect(main).toContain("const PROVIDER_ENABLED_KEY = 'l2chart.priceProviderEnabled';");
    expect(main).toContain('let providerEnabled = autoSaveWorkspaceAtStartup?.provider.enabled');
    expect(main).toContain('let activeProvider: PriceProviderId = autoSaveWorkspaceAtStartup?.provider.id');
    expect(main).toContain("?? (providerEnabled ? readActiveProvider() : 'demo');");
    expect(main).toContain('localStorage.setItem(ACTIVE_PROVIDER_KEY, provider);');
    expect(code).toContain("if (activeProvider === 'fiinquant') {");
    expect(code).toContain("} else if (activeProvider === 'vnstock') {");
  });

  it('renders provider controls as persistent switches and disables data access when off', async () => {
    const main = readFileSync(path.resolve('examples/workstation/main.ts'), 'utf8');
    const code = await transformedWorkstation();
    expect(main).toContain("action.setAttribute('role', 'switch');");
    expect(main).toContain("action.setAttribute('aria-checked', String(isOn));");
    expect(main).toContain("localStorage.setItem(PROVIDER_ENABLED_KEY, 'false');");
    expect(main).toContain('if (!providerEnabled) {');
    expect(code).toContain("showProviderActivationError('vnstock'");
  });

  it('keeps the compact Auto save row at the top after rebuilding the overflow menu', () => {
    const main = readFileSync(path.resolve('examples/workstation/main.ts'), 'utf8');
    const toolbar = main.slice(
      main.indexOf('function setupToolbarOverflow()'),
      main.indexOf('function defaultPreferences()'),
    );
    const finalMenuReset = toolbar.lastIndexOf('menu.replaceChildren();');
    const autoSaveMount = toolbar.indexOf('menu.appendChild(autoSaveSection);', finalMenuReset);
    const overflowRows = toolbar.indexOf('for (const entry of entries)', finalMenuReset);
    expect(finalMenuReset).toBeGreaterThan(-1);
    expect(autoSaveMount).toBeGreaterThan(finalMenuReset);
    expect(autoSaveMount).toBeLessThan(overflowRows);
    expect(toolbar).not.toContain('toolbar-more-save-button');
  });

  it('keeps replay state out of auto save snapshots and startup restore', () => {
    const main = readFileSync(path.resolve('examples/workstation/main.ts'), 'utf8');
    const snapshotType = main.slice(
      main.indexOf('interface AutoSaveWorkspaceSnapshot'),
      main.indexOf('const marketHub = new MarketHub();'),
    );
    const snapshotWriter = main.slice(
      main.indexOf('function saveAutoSaveWorkspaceSnapshot()'),
      main.indexOf('function configureAutoSaveTimer()'),
    );
    expect(snapshotType).not.toContain('replay:');
    expect(snapshotWriter).not.toContain('replaySession');
    expect(main).not.toContain('autoSaveWorkspaceAtStartup?.replay');
  });

  it('shows replay day labels independently of candle rendering mode', () => {
    const main = readFileSync(path.resolve('examples/workstation/main.ts'), 'utf8');
    const refreshLabels = main.slice(
      main.indexOf('function refreshReplayDayLabels('),
      main.indexOf('function createTileForSlot('),
    );
    expect(refreshLabels).toContain("visible[0].interval === '1M'");
    expect(refreshLabels).toContain("visible[1].interval === '1d'");
    expect(refreshLabels).not.toContain(".mode === 'candles'");
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

  it('opens Vietnamese scanner results with the Vnstock chart provider', async () => {
    const code = await transformedWorkstation();
    expect(code).toContain("fiinquant: 'vnstock'");
    expect(code).toContain("vn_eod: 'vnstock'");
    expect(code).toContain("vnstock: 'vnstock'");
    expect(code).toContain("if (targetProvider === 'vnstock' && !(await reportVnstockHealth(false))) return;");
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
    expect(code).toContain('const symbol = this.symbol;');
    expect(code).toContain('const interval = this.interval;');
    expect(code).toContain("const message = `không có dữ liệu ${symbol}`;");
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

  it('lets Vnstock schedule the watchlist without bulk history seeding', async () => {
    const code = await transformedWorkstation();
    const watchlistStart = code.indexOf('function syncWatchlistFeeds(seedSymbols: string[] = []): void {');
    const watchlistBlock = code.slice(watchlistStart, watchlistStart + 5000);
    const bulkSubscription = watchlistBlock.indexOf('provider.feed.subscribeMany');
    const vnstockReturn = watchlistBlock.indexOf("if (activeProvider === 'vnstock') return;");
    const seedQueue = watchlistBlock.indexOf('const seedQueue =');
    expect(bulkSubscription).toBeGreaterThan(-1);
    expect(vnstockReturn).toBeGreaterThan(bulkSubscription);
    expect(seedQueue).toBeGreaterThan(vnstockReturn);
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
