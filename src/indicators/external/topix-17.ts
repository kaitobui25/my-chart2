import { createComparisonOverlay } from './comparison-overlay';
import { getIndicatorChartProvider, getIndicatorChartSymbol, getIndicatorMarketContext } from '../runtime-context';

/** Official JPX classification codes map to NEXT FUNDS TOPIX-17 sector ETFs. */
export const TOPIX_17_ETFS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Array.from({ length: 17 }, (_, i) => [String(i + 1).padStart(2, '0'), `${1617 + i}.T`])),
);
export default createComparisonOverlay({
  id: 'topix-17-sector', name: 'TOPIX-17 · Ngành', withEma: true,
  available(chart) {
    const code = getIndicatorMarketContext(chart)?.sector17Code;
    return getIndicatorChartProvider(chart) === 'yfinance-jp' && getIndicatorChartSymbol(chart).endsWith('.T')
      && !!code && !!TOPIX_17_ETFS[code];
  },
  async resolveSymbol(chart) {
    const symbol = getIndicatorChartSymbol(chart);
    if (!symbol.endsWith('.T')) return null;
    const sector = await getIndicatorMarketContext(chart)?.getSector17?.(symbol);
    const ticker = sector && TOPIX_17_ETFS[sector.code];
    return ticker ? { symbol: ticker, label: `${ticker} · ${sector!.name}` } : null;
  },
});
