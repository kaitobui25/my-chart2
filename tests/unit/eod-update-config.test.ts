import { describe, expect, it } from 'vitest';

import { EOD_UPDATE_CONFIG } from '../../examples/workstation/scanner/eod-config';

describe('EOD update root YAML config', () => {
  it('loads the 90-day lookback and 300-second timeout', () => {
    expect(EOD_UPDATE_CONFIG.lookbackDays).toBe(90);
    expect(EOD_UPDATE_CONFIG.timeoutMs).toBe(300_000);
  });
});
