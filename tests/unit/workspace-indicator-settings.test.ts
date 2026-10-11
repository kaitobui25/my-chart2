import { describe, expect, it } from 'vitest';
import { restoreWorkspaceIndicatorSettings } from '../../examples/workstation/workspace-indicator-settings';

describe('workspace indicator settings restoration', () => {
  it('restores newer user settings instead of stale startup snapshot defaults', () => {
    const tiles = [{ symbol: 'FPT', indicatorParams: { 'super-ema': { frame0: '15', mini2: true, length0: 20 } } }];
    const preferences = { FPT: { updatedAt: 200, indicatorParams: { 'super-ema': { frame0: 'D', mini2: false, length0: 34, gap: 0, color0: '#123456' } } } };
    const result = restoreWorkspaceIndicatorSettings(tiles, JSON.parse(JSON.stringify(preferences)), 100);
    expect(result[0].indicatorParams['super-ema']).toEqual(preferences.FPT.indicatorParams['super-ema']);
    expect(tiles[0].indicatorParams['super-ema'].frame0).toBe('15');
  });
  it('keeps distinct settings on two charts of the same symbol when the snapshot is newer', () => {
    const tiles = [
      { symbol: 'FPT', indicatorParams: { 'super-ema': { length0: 20 } } },
      { symbol: 'FPT', indicatorParams: { 'super-ema': { length0: 34 } } },
    ];
    const preferences = { FPT: { updatedAt: 100, indicatorParams: { 'super-ema': { length0: 34 } } } };
    expect(restoreWorkspaceIndicatorSettings(tiles, preferences, 200)).toEqual(tiles);
  });
  it('migrates existing preferences without a timestamp and preserves unrelated settings', () => {
    const tiles = [{ symbol: 'fpt', indicatorParams: { sma: { length: 50 }, 'super-ema': { length0: 20 } } }];
    const preferences = { FPT: { indicatorParams: { 'super-ema': { length0: 34 } } } };
    expect(restoreWorkspaceIndicatorSettings(tiles, preferences, 100)[0].indicatorParams)
      .toEqual({ sma: { length: 50 }, 'super-ema': { length0: 34 } });
  });
});
