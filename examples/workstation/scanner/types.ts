export type ScannerSourceId = 'fiinquant' | 'binance_spot' | 'binance_usdm';
export type ScannerTimeframe = '1w' | '1M';
export type ScannerCandleKind = 'current' | 'closed';

export interface ScannerSource {
  id: ScannerSourceId;
  label: string;
  market_cap: boolean;
  bulk_snapshot: boolean;
  bulk_history: boolean;
  universes: string[];
  default_universes: string[];
  timezone: string;
  max_history_concurrency: number;
  continuous_market: boolean;
  snapshot_ttl_seconds: number;
  history_ttl_seconds: number;
  available: boolean;
  detail?: string | null;
}

export interface ScannerRequest {
  source: ScannerSourceId;
  universes: string[];
  filters: {
    priceMin: number | null;
    priceMax: number | null;
    volumeMin: number | null;
    volumeMax: number | null;
    marketCapMin: number | null;
    marketCapMax: number | null;
  };
  heikinAshi: {
    timeframe: ScannerTimeframe;
    green: boolean;
    noLowerWick: boolean;
    closeChangePctMin: number | null;
    candle: ScannerCandleKind;
  };
}

export interface ScannerResult {
  instrumentId: number;
  symbol: string;
  name: string;
  exchange: string;
  price: number | null;
  volume: number | null;
  marketCap: number | null;
  timeframe: ScannerTimeframe;
  candleKind: ScannerCandleKind;
  candleTime: number;
  haOpen: number;
  haHigh: number;
  haLow: number;
  haClose: number;
  green: boolean;
  noLowerWick: boolean;
  haCloseChangePct: number | null;
  haBodyPct: number | null;
  sourceLastTime: number;
  computedAt: number;
  stale: boolean;
  warnings: string[];
}

export interface ScannerRun {
  runId: number;
  provider: ScannerSourceId;
  status: 'running' | 'complete' | 'error';
  started_at: number;
  finished_at?: number | null;
  universe_count: number;
  stage1_count: number;
  history_refresh_count: number;
  stage2_count: number;
  result_count: number;
  error?: string | null;
  warnings: string[];
  results: ScannerResult[];
}

declare global {
  interface Window {
    __L2CHART_SCANNER_BRIDGE__?: Readonly<{
      getProvider(): string;
      openSymbol(symbol: string): void;
    }>;
  }
}
