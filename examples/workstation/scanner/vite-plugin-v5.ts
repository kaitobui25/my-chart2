import type { Plugin } from 'vite';
import { scannerIntegration as startupSafeScannerIntegration } from './vite-plugin-v4';

function lines(...values: string[]): string {
  return values.join('\n');
}

function replaceRequired(code: string, needle: string, replacement: string): string {
  if (!code.includes(needle)) {
    throw new Error(`FiinQuant direct-symbol marker is missing: ${needle.slice(0, 100)}`);
  }
  return code.replace(needle, replacement);
}

function patchFiinQuantDirectSymbols(original: string): string {
  let code = original;

  // FiinQuant's TickerList metadata is not authoritative: valid history symbols
  // such as PGI/HII can be absent even though Fetch_Trading_Data returns candles.
  // Keep TickerList-backed autocomplete results, but if an exact-looking symbol
  // is absent, expose it as a Direct symbol. Selecting it follows the normal
  // Tile.load() path, so history remains the final validity check.
  code = replaceRequired(
    code,
    lines(
      '        const merged = new Map<string, SymbolSearchResult>();',
      '        for (const item of [...localMatches, ...remoteMatches]) {',
      '          if (!merged.has(item.symbol)) merged.set(item.symbol, item);',
      '        }',
      '        renderMatches([...merged.values()].slice(0, 30));',
    ),
    lines(
      '        const merged = new Map<string, SymbolSearchResult>();',
      '        for (const item of [...localMatches, ...remoteMatches]) {',
      '          if (!merged.has(item.symbol)) merged.set(item.symbol, item);',
      '        }',
      '        const directSymbol = query.trim().toUpperCase();',
      '        const directMatch = activeProvider === \'fiinquant\'',
      '          && /^[A-Z0-9]{2,32}$/.test(directSymbol)',
      '          && !merged.has(directSymbol)',
      "          ? { symbol: directSymbol, name: 'Direct symbol', exchange: 'FiinQuant' } satisfies SymbolSearchResult",
      '          : null;',
      '        renderMatches([...(directMatch ? [directMatch] : []), ...merged.values()].slice(0, 30));',
    ),
  );

  // Keep the command palette consistent with the main symbol autocomplete.
  code = replaceRequired(
    code,
    lines(
      '      const merged = new Map<string, SymbolSearchResult>();',
      '      for (const item of [...localItems, ...remoteItems]) {',
      '        if (!merged.has(item.symbol)) merged.set(item.symbol, item);',
      '      }',
      '      renderCmdSuggestions([...merged.values()].slice(0, 100));',
    ),
    lines(
      '      const merged = new Map<string, SymbolSearchResult>();',
      '      for (const item of [...localItems, ...remoteItems]) {',
      '        if (!merged.has(item.symbol)) merged.set(item.symbol, item);',
      '      }',
      '      const directSymbol = command.value.trim().toUpperCase();',
      '      const directMatch = activeProvider === \'fiinquant\'',
      '        && /^[A-Z0-9]{2,32}$/.test(directSymbol)',
      '        && !merged.has(directSymbol)',
      "        ? { symbol: directSymbol, name: 'Direct symbol', exchange: 'FiinQuant' } satisfies SymbolSearchResult",
      '        : null;',
      '      renderCmdSuggestions([...(directMatch ? [directMatch] : []), ...merged.values()].slice(0, 100));',
    ),
  );

  return code;
}

function runStartupSafeTransform(
  previous: Plugin,
  context: unknown,
  code: string,
  id: string,
): any {
  const hook = previous.transform as unknown as ((this: unknown, source: string, moduleId: string) => unknown) | undefined;
  if (!hook) return null;
  const result = hook.call(context, code, id) as string | { code: string; map?: unknown } | null;
  if (!result) return null;
  if (typeof result === 'string') return patchFiinQuantDirectSymbols(result);
  return { ...result, code: patchFiinQuantDirectSymbols(result.code) };
}

export function scannerIntegration(): Plugin {
  const previous = startupSafeScannerIntegration();
  return {
    ...previous,
    name: 'l2chart-scanner-fiinquant-direct-symbols',
    transform(code, id) {
      return runStartupSafeTransform(previous, this, code, id);
    },
  };
}
