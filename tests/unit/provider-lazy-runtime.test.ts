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

describe('lazy chart provider lifecycle', () => {
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
    expect(code).toContain('if (!await ensureFiinQuantRuntime()) return null;');
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
});
