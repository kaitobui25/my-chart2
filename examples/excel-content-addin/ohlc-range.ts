import type { Candle } from '../../src/library';

export interface ExcelRangeSnapshot {
  values: unknown[][];
  text: string[][];
}

export interface OhlcvColumnMap {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type NumericTimeFormat = 'auto' | 'excel-serial' | 'unix-seconds' | 'unix-milliseconds';

export interface CandleRangeOptions {
  columns?: Readonly<OhlcvColumnMap>;
  numericTimeFormat?: NumericTimeFormat;
}

export const DEFAULT_OHLC_COLUMNS: Readonly<OhlcvColumnMap> = Object.freeze({
  time: 0,
  open: 1,
  high: 2,
  low: 3,
  close: 4,
  volume: 5,
});

const EXCEL_UNIX_EPOCH_OFFSET_DAYS = 25_569;
const SECONDS_PER_DAY = 86_400;
/** Excel's documented upper serial-date range ends at 9999-12-31. */
const MAX_EXCEL_SERIAL = 2_958_465;
/** Values beyond the practical Unix-seconds range are treated as milliseconds in auto mode. */
const AUTO_UNIX_MILLISECONDS_MIN = 10_000_000_000;

export function candlesFromRange(
  snapshot: ExcelRangeSnapshot,
  options: CandleRangeOptions = {},
): Candle[] {
  const columns = options.columns ?? DEFAULT_OHLC_COLUMNS;
  const numericTimeFormat = options.numericTimeFormat ?? 'auto';
  const candles: Candle[] = [];
  const requiredColumnCount = 1 + Math.max(
    columns.time,
    columns.open,
    columns.high,
    columns.low,
    columns.close,
  );

  snapshot.values.forEach((values, rowIndex) => {
    if (values.length < requiredColumnCount) return;
    const text = snapshot.text[rowIndex] ?? [];
    const time = parseExcelTime(values[columns.time], text[columns.time], numericTimeFormat);
    const open = parseNumber(values[columns.open], text[columns.open]);
    const high = parseNumber(values[columns.high], text[columns.high]);
    const low = parseNumber(values[columns.low], text[columns.low]);
    const close = parseNumber(values[columns.close], text[columns.close]);
    const volume = columns.volume !== undefined && values.length > columns.volume
      ? parseNumber(values[columns.volume], text[columns.volume])
      : null;

    if (time === null || open === null || high === null || low === null || close === null) return;
    if (!isValidOhlc(open, high, low, close)) return;

    candles.push({
      time,
      open,
      high,
      low,
      close,
      ...(volume !== null ? { volume } : {}),
    });
  });

  candles.sort((a, b) => a.time - b.time);
  return dedupeByTime(candles);
}

export function inferCandleIntervalSeconds(
  candles: readonly Candle[],
  fallbackSeconds = 60,
): number {
  const diffs: number[] = [];
  for (let index = 1; index < Math.min(candles.length, 20); index += 1) {
    const diff = candles[index].time - candles[index - 1].time;
    if (Number.isFinite(diff) && diff > 0) diffs.push(diff);
  }
  if (diffs.length === 0) return Math.max(1, Math.floor(fallbackSeconds));
  diffs.sort((left, right) => left - right);
  return diffs[Math.floor(diffs.length / 2)];
}

export function parseNumber(raw: unknown, fallbackText?: string): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const source = String(raw ?? fallbackText ?? '').trim();
  if (!source) return null;

  const compact = source.replace(/\s/g, '');
  const normalized = normalizeDecimalSeparators(compact);
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseExcelTime(
  raw: unknown,
  fallbackText?: string,
  numericFormat: NumericTimeFormat = 'auto',
): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (numericFormat === 'unix-milliseconds') return Math.floor(raw / 1_000);
    if (numericFormat === 'unix-seconds') return Math.floor(raw);
    if (numericFormat === 'excel-serial') return excelSerialToUnixSeconds(raw);

    if (Math.abs(raw) >= AUTO_UNIX_MILLISECONDS_MIN) return Math.floor(raw / 1_000);
    if (raw > MAX_EXCEL_SERIAL || raw < 0) return Math.floor(raw);
    return excelSerialToUnixSeconds(raw);
  }

  const source = String(raw ?? fallbackText ?? '').trim();
  if (!source) return null;
  const parsed = Date.parse(source);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : null;
}

function excelSerialToUnixSeconds(serial: number): number {
  return Math.floor((serial - EXCEL_UNIX_EPOCH_OFFSET_DAYS) * SECONDS_PER_DAY);
}

function isValidOhlc(open: number, high: number, low: number, close: number): boolean {
  return high >= low
    && high >= open
    && high >= close
    && low <= open
    && low <= close;
}

function dedupeByTime(candles: Candle[]): Candle[] {
  const deduped: Candle[] = [];
  for (const candle of candles) {
    if (deduped[deduped.length - 1]?.time === candle.time) {
      deduped[deduped.length - 1] = candle;
    } else {
      deduped.push(candle);
    }
  }
  return deduped;
}

function normalizeDecimalSeparators(value: string): string {
  const comma = value.lastIndexOf(',');
  const dot = value.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    return comma > dot
      ? value.replace(/\./g, '').replace(',', '.')
      : value.replace(/,/g, '');
  }
  if (comma < 0) return value;
  if (/^[+-]?\d{1,3}(,\d{3})+$/.test(value)) return value.replace(/,/g, '');
  return value.replace(',', '.');
}
