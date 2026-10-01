import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scannerIntegration } from '../../examples/workstation/scanner/vite-plugin';
import { yFinanceJapanIntegration } from '../../examples/workstation/yfinance-jp/vite-plugin';

async function transformedWorkstation(): Promise<string> {
  const sourcePath = path.resolve('examples/workstation/main.ts');
  const source = readFileSync(sourcePath, 'utf8');
  const scanner = scannerIntegration();
  const scannerHook = scanner.transform;
  if (typeof scannerHook !== 'function') throw new Error('scanner transform hook is unavailable');
  const scannerResult = await scannerHook.call({} as never, source, sourcePath, { moduleType: 'js' } as never);
  if (!scannerResult) throw new Error('scanner transform returned no workstation code');
  const scannerCode = typeof scannerResult === 'string' ? scannerResult : String(scannerResult.code ?? '');

  const japan = yFinanceJapanIntegration();
  const japanHook = japan.transform;
  if (typeof japanHook !== 'function') throw new Error('Yahoo Japan transform hook is unavailable');
  const japanResult = await japanHook.call({} as never, scannerCode, sourcePath, { moduleType: 'js' } as never);
  if (!japanResult) throw new Error('Yahoo Japan transform returned no workstation code');
  return typeof japanResult === 'string' ? japanResult : String(japanResult.code ?? '');
}

describe('Yahoo Japan workstation integration', () => {
  it('keeps Japan as an isolated provider family with its own feed and watchlist', async () => {
    const code = await transformedWorkstation();
    expect(code).toContain("'yfinance-jp'");
    expect(code).toContain("if (provider === 'yfinance-jp') return 'japan';");
    expect(code).toContain("if (provider === 'binance-local' || provider === 'yfinance-jp') return provider;");
    expect(code).toContain("if (provider === 'yfinance-jp') return YFINANCE_JP_DEFAULT_SYMBOLS;");
    expect(code).toContain("return { feed: yFinanceJapanFeed, label: 'Yahoo Japan', unavailable: null };");
  });

  it('uses Tokyo calendar time and disables background watchlist requests', async () => {
    const code = await transformedWorkstation();
    expect(code).toContain("if (providerId === 'yfinance-jp') return 9 * 60;");
    expect(code).toContain("if (activeProvider === 'fiinquant' || activeProvider === 'yfinance-jp') return;");
    expect(code).toContain("? 'Yahoo · polling 60s'");
  });

  it('lets the provider module own supported intervals and defaults', async () => {
    const code = await transformedWorkstation();
    expect(code).toContain('YFINANCE_JP_DEFAULT_SYMBOLS');
    expect(code).toContain('YFINANCE_JP_SUPPORTED_INTERVALS');
    expect(code).toContain("if (provider === 'yfinance-jp') return YFINANCE_JP_INTERVAL_SET.has(interval);");
  });
});
