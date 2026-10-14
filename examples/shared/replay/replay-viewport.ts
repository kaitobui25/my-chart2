import type { Candle } from '../../../src/core/types';

export interface LogicalViewport { barSpacing: number; rightIndex: number; width?: number }
interface ViewportScale extends LogicalViewport { scroll(dxPx: number): void }
export interface ReplayViewport { barSpacing: number; anchorTime: number; offset: number }

export function captureLogicalViewport(scale: LogicalViewport): LogicalViewport {
  return { barSpacing: scale.barSpacing, rightIndex: scale.rightIndex };
}
export function restoreLogicalViewport(scale: ViewportScale, saved: LogicalViewport): void {
  scale.barSpacing = saved.barSpacing;
  scale.scroll((scale.rightIndex - saved.rightIndex) * saved.barSpacing);
}
/** Timestamp anchors survive prepending history and rebuilding replay buckets. */
export function captureReplayViewport(scale: LogicalViewport, candles: readonly Candle[]): ReplayViewport | null {
  if (!candles.length) return null;
  const leftIndex = scale.rightIndex - (scale.width ?? 0) / scale.barSpacing;
  const index = Math.max(0, Math.min(candles.length - 1, Math.floor(leftIndex)));
  return { barSpacing: scale.barSpacing, anchorTime: candles[index].time, offset: scale.rightIndex - index };
}
export function restoreReplayViewport(scale: ViewportScale, candles: readonly Candle[], saved: ReplayViewport): void {
  if (!candles.length) return;
  let index = 0;
  for (let i = 0; i < candles.length && candles[i].time <= saved.anchorTime; i++) index = i;
  restoreLogicalViewport(scale, { barSpacing: saved.barSpacing, rightIndex: index + saved.offset });
}
