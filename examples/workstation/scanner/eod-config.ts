import rawConfig from '../../../eod-update.yaml?raw';

export type EodUpdateConfig = Readonly<{
  lookbackDays: number;
  timeoutMs: number;
}>;

const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_TIMEOUT_SECONDS = 300;

function positiveInt(key: string, fallback: number): number {
  const pattern = new RegExp(`^\\s*${key}\\s*:\\s*(\\d+)\\s*(?:#.*)?$`, 'm');
  const match = rawConfig.match(pattern);
  if (!match) return fallback;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const EOD_UPDATE_CONFIG: EodUpdateConfig = Object.freeze({
  lookbackDays: positiveInt('lookback_days', DEFAULT_LOOKBACK_DAYS),
  timeoutMs: positiveInt('timeout_seconds', DEFAULT_TIMEOUT_SECONDS) * 1000,
});
