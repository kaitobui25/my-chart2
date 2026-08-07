export const SUPPORTED_INTERVALS = [
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w', '1M',
] as const;

export type IntervalCode = (typeof SUPPORTED_INTERVALS)[number];

const FIXED_SECONDS: Partial<Record<IntervalCode, number>> = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '4h': 14400,
  '1d': 86400,
};

const WEEK_SECONDS = 7 * 86400;
const MONTH_APPROX_SECONDS = 30 * 86400;

export function isIntervalCode(value: string): value is IntervalCode {
  return (SUPPORTED_INTERVALS as readonly string[]).includes(value);
}

export function isCalendarInterval(interval: string): boolean {
  return interval === '1w' || interval === '1M';
}

/** So giay xap xi chi dung cho layout, limit va lookback; khong dung de chia bucket thang. */
export function intervalApproxSeconds(interval: string): number {
  if (interval === '1w') return WEEK_SECONDS;
  if (interval === '1M') return MONTH_APPROX_SECONDS;
  return FIXED_SECONDS[interval as IntervalCode] ?? 60;
}

function shiftedDate(time: number, utcOffsetMinutes: number): Date {
  return new Date((time + utcOffsetMinutes * 60) * 1000);
}

function unshiftUtcMillis(ms: number, utcOffsetMinutes: number): number {
  return Math.floor(ms / 1000) - utcOffsetMinutes * 60;
}

/** Moc bat dau cua bucket. Week bat dau thu Hai; month bat dau ngay 1. */
export function intervalStart(time: number, interval: string, utcOffsetMinutes = 0): number {
  const date = shiftedDate(time, utcOffsetMinutes);
  if (interval === '1M') {
    return unshiftUtcMillis(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), utcOffsetMinutes);
  }
  if (interval === '1w') {
    const daysFromMonday = (date.getUTCDay() + 6) % 7;
    return unshiftUtcMillis(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysFromMonday),
      utcOffsetMinutes,
    );
  }
  if (interval === '1d') {
    return unshiftUtcMillis(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
      utcOffsetMinutes,
    );
  }
  const step = FIXED_SECONDS[interval as IntervalCode] ?? 60;
  return Math.floor(time / step) * step;
}

/** Dich theo bucket calendar thay vi gia dinh thang luon co 30 ngay. */
export function shiftIntervalStart(
  time: number,
  interval: string,
  count: number,
  utcOffsetMinutes = 0,
): number {
  const start = intervalStart(time, interval, utcOffsetMinutes);
  if (interval === '1M') {
    const date = shiftedDate(start, utcOffsetMinutes);
    return unshiftUtcMillis(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1),
      utcOffsetMinutes,
    );
  }
  if (interval === '1w') return start + count * WEEK_SECONDS;
  if (interval === '1d') return start + count * 86400;
  return start + count * intervalApproxSeconds(interval);
}

export function nextIntervalStart(time: number, interval: string, utcOffsetMinutes = 0): number {
  return shiftIntervalStart(time, interval, 1, utcOffsetMinutes);
}

export function estimateIntervalBars(from: number, to: number, interval: string): number {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  if (interval === '1M') {
    const a = new Date(lo * 1000);
    const b = new Date(hi * 1000);
    return Math.max(1, (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() + 1);
  }
  return Math.max(1, Math.ceil((hi - lo) / intervalApproxSeconds(interval)) + 1);
}
