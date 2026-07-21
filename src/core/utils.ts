export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Round a rough step up to a "nice" 1/2/5 * 10^n value. */
export function niceStep(rough: number): number {
  if (!isFinite(rough) || rough <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const n = rough / pow;
  const m = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return m * pow;
}

/** Number of decimals appropriate for a tick step (capped at 8). */
export function decimalsForStep(step: number): number {
  if (step >= 1) return step >= 10 ? 0 : 2;
  return Math.min(8, Math.max(0, -Math.floor(Math.log10(step))) + 1);
}

export function formatPrice(p: number, decimals = 2): string {
  return p.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Compact formatting for volumes: 1.23K, 4.56M, 7.89B. */
export function formatCompact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toFixed(2);
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** Axis tick label for a bar time, adapted to the bar interval. */
export function formatTimeLabel(tsSec: number, intervalSec: number): string {
  const d = new Date(tsSec * 1000);
  if (intervalSec >= 30 * 86400) return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  if (intervalSec >= 86400) return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
  if (d.getHours() === 0 && d.getMinutes() === 0) return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export interface TimeTickLabel {
  text: string;
  /** True at a day, month, or year boundary. */
  major: boolean;
}

/** Format hierarchical time-axis labels for calendar boundaries and intraday ticks. */
export function formatTimeTick(
  tsSec: number,
  prevTickSec: number | null,
  intervalSec: number,
): TimeTickLabel {
  const d = new Date(tsSec * 1000);
  if (prevTickSec !== null) {
    const p = new Date(prevTickSec * 1000);
    if (d.getFullYear() !== p.getFullYear()) {
      return { text: String(d.getFullYear()), major: true };
    }
    if (d.getMonth() !== p.getMonth()) {
      return { text: `Thg ${d.getMonth() + 1}`, major: true };
    }
    if (intervalSec < 86400 && d.getDate() !== p.getDate()) {
      return { text: String(d.getDate()), major: true };
    }
  }
  if (intervalSec >= 30 * 86400) {
    return { text: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`, major: false };
  }
  if (intervalSec >= 86400) return { text: String(d.getDate()), major: false };
  return { text: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`, major: false };
}

/** Full date-time used for the crosshair time label. */
export function formatTimeFull(tsSec: number, intervalSec: number): string {
  const d = new Date(tsSec * 1000);
  const date = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  if (intervalSec >= 86400) return date;
  return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Human duration for a measured span: "69d", "5h 30m", "45m". */
export function formatDuration(sec: number): string {
  if (sec >= 86400) {
    const d = sec / 86400;
    return d >= 10 ? `${Math.round(d)}d` : `${Math.round(d * 10) / 10}d`;
  }
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.round(sec / 60)}m`;
}

/** Nice step for bar-count spacing on the time axis. */
export function niceBarStep(minBars: number): number {
  const steps = [1, 2, 5, 10, 15, 20, 30, 60, 120, 240, 480];
  for (const s of steps) if (s >= minBars) return s;
  return Math.ceil(minBars / 480) * 480;
}
