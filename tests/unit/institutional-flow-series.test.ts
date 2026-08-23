import { describe, expect, it } from 'vitest';
import {
  formatInstitutionalFlowValue,
  institutionalFlowRegionLayout,
  institutionalFlowZeroPositionForY,
} from '../../src/indicators/external/institutional-flow-series';

describe('institutional flow value labels', () => {
  it('treats billions as the implicit unit and keeps million values explicit', () => {
    expect(formatInstitutionalFlowValue(626_000_000_000)).toBe('+626');
    expect(formatInstitutionalFlowValue(64_500_000_000)).toBe('+64.5');
    expect(formatInstitutionalFlowValue(-8_660_000_000)).toBe('−8.66');
    expect(formatInstitutionalFlowValue(950_000_000)).toBe('+950 tr');
    expect(formatInstitutionalFlowValue(-45_600_000)).toBe('−45.6 tr');
  });

  it('keeps very large billion values compact without restoring the tỷ suffix', () => {
    expect(formatInstitutionalFlowValue(1_250_000_000_000)).toBe('+1.3k');
    expect(formatInstitutionalFlowValue(-12_400_000_000_000)).toBe('−12k');
  });
});

describe('institutional flow zero line layout', () => {
  it('moves the zero line inside the same indicator region', () => {
    const centered = institutionalFlowRegionLayout(800, 24, 0.28, 0.5);
    const upper = institutionalFlowRegionLayout(800, 24, 0.28, 0.3);
    const lower = institutionalFlowRegionLayout(800, 24, 0.28, 0.7);

    expect(upper.top).toBe(centered.top);
    expect(lower.bottom).toBe(centered.bottom);
    expect(upper.zeroY).toBeLessThan(centered.zeroY);
    expect(lower.zeroY).toBeGreaterThan(centered.zeroY);
  });

  it('converts pointer y to a clamped 20-80 percent zero position', () => {
    const layout = institutionalFlowRegionLayout(800, 24, 0.28, 0.5);

    expect(institutionalFlowZeroPositionForY(layout.top, 800, 24, 0.28)).toBe(0.2);
    expect(institutionalFlowZeroPositionForY(layout.top + layout.height * 0.65, 800, 24, 0.28)).toBeCloseTo(0.65);
    expect(institutionalFlowZeroPositionForY(layout.bottom, 800, 24, 0.28)).toBe(0.8);
  });
});
