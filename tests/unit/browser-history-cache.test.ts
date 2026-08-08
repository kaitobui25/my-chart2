import { describe, expect, it } from 'vitest';
import {
  historyCoverageContains,
  mergeHistoryCoverage,
  missingHistoryCoverage,
} from '../../examples/providers/browser-history-cache';

describe('BrowserHistoryCache coverage helpers', () => {
  it('merges overlapping and touching fetched ranges', () => {
    expect(mergeHistoryCoverage([
      { from: 300, to: 399 },
      { from: 100, to: 199 },
      { from: 180, to: 299 },
      { from: 500, to: 599 },
    ])).toEqual([
      { from: 100, to: 399 },
      { from: 500, to: 599 },
    ]);
  });

  it('finds only portions not confirmed by provider coverage', () => {
    const coverage = [
      { from: 100, to: 299 },
      { from: 400, to: 499 },
    ];
    expect(missingHistoryCoverage(coverage, { from: 150, to: 450 })).toEqual([
      { from: 300, to: 399 },
    ]);
    expect(historyCoverageContains(coverage, { from: 120, to: 250 })).toBe(true);
    expect(historyCoverageContains(coverage, { from: 250, to: 450 })).toBe(false);
  });
});
