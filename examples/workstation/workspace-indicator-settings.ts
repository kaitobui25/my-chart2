import type { Params } from '../../src/indicators/registry';

interface TileSettings {
  symbol?: string;
  indicatorParams?: Record<string, Params>;
}
interface SavedSettings {
  updatedAt?: number;
  indicatorParams?: Record<string, Params>;
}

/** Migrate stale workspace snapshots without overwriting newer per-chart settings. */
export function restoreWorkspaceIndicatorSettings<T extends TileSettings>(
  tiles: readonly T[], preferences: Record<string, SavedSettings>, snapshotSavedAt: number,
): T[] {
  return tiles.map(tile => {
    if (!tile.symbol) return tile;
    const saved = preferences[tile.symbol.toUpperCase()];
    if (!saved?.indicatorParams || (saved.updatedAt !== undefined && saved.updatedAt <= snapshotSavedAt)) return tile;
    return { ...tile, indicatorParams: { ...tile.indicatorParams, ...saved.indicatorParams } };
  });
}
