export type ScannerSourceId = 'fiinquant' | 'vn_eod' | 'binance_spot' | 'binance_usdm';
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
  refresh_mode: 'network' | 'preloaded';
  universes_are_exchanges: boolean;
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
  breakoutVolume?: {
    enabled: boolean;
    minMedianTradedValue: number;
    minMedianVolume: number;
    minWeeklyChangePct: number;
    minRvol: number;
    strongRvol: number;
  };
}

interface ScannerResultBase {
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
  sourceLastTime: number;
  computedAt: number;
  stale: boolean;
  warnings: string[];
}

export interface HeikinScannerResult extends ScannerResultBase {
  mode: 'heikin_ashi';
  haOpen: number;
  haHigh: number;
  haLow: number;
  haClose: number;
  green: boolean;
  noLowerWick: boolean;
  haCloseChangePct: number | null;
  haBodyPct: number | null;
}

export interface BreakoutScannerResult extends ScannerResultBase {
  mode: 'breakout_volume';
  timeframe: '1w';
  candleKind: 'closed';
  price: number;
  volume: number;
  weeklyChangePct: number;
  rvol: number;
  breakoutLevel: number;
  tradedValue: number;
  medianTradedValue: number;
  medianVolume: number;
  strong: boolean;
  signalState: 'NEW' | 'FOLLOW_UP';
  nextWeekTime: number | null;
  nextWeekVolume: number | null;
  nextWeekRvol: number | null;
  nextWeekClose: number | null;
  nextWeekHoldsBreakout: boolean | null;
}

export type ScannerResult = HeikinScannerResult | BreakoutScannerResult;

export interface ScannerRun {
  runId: number;
  provider: ScannerSourceId;
  status: 'running' | 'complete' | 'error';
  progressPct: number;
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

export interface CafeFEodImportAudit {
  id: number;
  provider: string;
  source: string;
  mode: 'eod' | 'upto' | string;
  adjusted: number;
  trade_date: number | null;
  source_url: string | null;
  source_sha256: string | null;
  started_at: number;
  finished_at: number | null;
  member_count: number;
  row_count: number;
  symbol_count: number;
  inserted_candle_count: number;
  status: string;
  error: string | null;
}

export interface CafeFEodStatus {
  provider: 'vn_eod';
  updating: boolean;
  latestTradeDate: number | null;
  activeSymbols: number;
  snapshotSymbols: number;
  retentionBars: number;
  activeMaxAgeDays: number;
  latestImport: CafeFEodImportAudit | null;
  lastError: string | null;
}

export interface CafeFEodUpdateResult {
  ok: boolean;
  importId: number;
  mode: string;
  tradeDate: number;
  members: number;
  rows: number;
  symbols: number;
  activeSymbols: number;
  assetTypes: Record<string, number>;
  candles: number;
  sha256: string;
  source: string | null;
}

export interface CafeFEodUpdateResponse {
  ok: true;
  result: CafeFEodUpdateResult;
  status: CafeFEodStatus;
}

declare global {
  interface Window {
    __L2CHART_SCANNER_BRIDGE__?: Readonly<{
      getProvider(): string;
      openSymbol(symbol: string): void;
    }>;
  }
}
