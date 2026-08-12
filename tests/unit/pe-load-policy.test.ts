import { describe, expect, it } from 'vitest';
import { PE_CACHE_MISS_DELAY_MS, peCacheMissDelay } from '../../src/indicators/builtin/pe';

describe('P/E cache-miss loading policy', () => {
  it('fetches immediately after a manual indicator enable', () => {
    expect(peCacheMissDelay(true)).toBe(0);
  });

  it('waits 30 seconds after a restored indicator or ticker change', () => {
    expect(PE_CACHE_MISS_DELAY_MS).toBe(30_000);
    expect(peCacheMissDelay(false)).toBe(30_000);
  });
});
