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

describe('Binance multi-chart tile defaults', () => {
  it('does not seed an added Binance tile from stale Vietnam slot symbols', async () => {
    const code = await transformedWorkstation();
    const start = code.indexOf('function createTileForSlot(index: number, template?: TileTemplate): Tile {');
    const end = code.indexOf('function applyTemplateSnapshots(', start);
    const block = code.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('const providerDefaults = defaultSymbolsForProvider(activeProvider);');
    expect(block).toContain('const savedSymbol = isBinanceProvider(activeProvider) && index > 0');
    expect(block).toContain('    ? undefined');
    expect(block).toContain('const symbol = template?.symbol?.trim().toUpperCase()');
    expect(block).toContain('    || providerDefaults[index % providerDefaults.length];');
    expect(block).not.toContain('DEFAULT_SYMBOLS[index % DEFAULT_SYMBOLS.length]');
  });
});
