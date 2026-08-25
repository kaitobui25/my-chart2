import type { Plugin } from 'vite';
import { scannerIntegration as candleLoadIsolationScannerIntegration } from './vite-plugin-v7';

function patchWorkstationBinanceAdapter(code: string): string {
  const needle = "import { BinanceDatafeed } from '../providers/binance';";
  const replacement = "import { BinanceDatafeed } from '../providers/binance-workstation';";
  if (!code.includes(needle)) {
    throw new Error(`Workstation Binance adapter marker is missing: ${needle}`);
  }
  return code.replace(needle, replacement);
}

function runCandleLoadIsolationTransform(
  previous: Plugin,
  context: unknown,
  code: string,
  id: string,
): any {
  const hook = previous.transform as unknown as ((this: unknown, source: string, moduleId: string) => unknown) | undefined;
  if (!hook) return null;
  const result = hook.call(context, code, id) as string | { code: string; map?: unknown } | null;
  if (!result) return null;
  if (typeof result === 'string') return patchWorkstationBinanceAdapter(result);
  return { ...result, code: patchWorkstationBinanceAdapter(result.code) };
}

export function scannerIntegration(): Plugin {
  const previous = candleLoadIsolationScannerIntegration();
  return {
    ...previous,
    name: 'l2chart-scanner-binance-multichart-isolation',
    transform(code, id) {
      return runCandleLoadIsolationTransform(previous, this, code, id);
    },
  };
}
