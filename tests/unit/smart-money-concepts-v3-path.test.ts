import { describe, expect, it } from 'vitest';
import { createProtectedStructurePath } from '../../src/indicators/builtin/smart-money-concepts-v3-path';
import type { SmcV2Pivot, SmcV2StructureLine } from '../../src/indicators/builtin/smart-money-concepts-v2-model';

const pivot = (index: number, price: number, high: boolean): SmcV2Pivot => ({
  index, price, confirmedAt: index + 1, direction: high ? 'bearish' : 'bullish', label: high ? 'HH' : 'LL',
});
const active = (lines: SmcV2StructureLine[], index = Infinity) => lines
  .filter(line => line.confirmedAt <= index && (line.supersededAt === undefined || line.supersededAt > index))
  .map(line => [line.fromIndex, line.fromPrice, line.toIndex, line.toPrice]);

describe.each(['internal', 'swing'] as const)('V3 %s connector path', scope => {
  it('replaces a growing leg instead of drawing several branches from one pivot', () => {
    const lines: SmcV2StructureLine[] = [], append = createProtectedStructurePath(scope, lines);
    append(pivot(0, 90, false), 1);
    append(pivot(2, 100, true), 3);
    append(pivot(4, 110, true), 5);
    expect(active(lines)).toEqual([[0, 90, 4, 110]]);
    expect(active(lines, 3)).toEqual([[0, 90, 2, 100]]);
    append(pivot(6, 95, false), 7);
    expect(active(lines)).toEqual([[0, 90, 4, 110], [4, 110, 6, 95]]);
  });

  it('keeps the real extreme when a weaker same-side pivot becomes protected', () => {
    const lines: SmcV2StructureLine[] = [], append = createProtectedStructurePath(scope, lines);
    append(pivot(0, 90, false), 1);
    append(pivot(2, 110, true), 3);
    append(pivot(4, 100, true), 5);
    append(pivot(6, 85, false), 7);
    expect(active(lines)).toEqual([[0, 90, 2, 110], [2, 110, 6, 85]]);
  });

  it('updates both adjoining legs when an extreme pullback is promoted late', () => {
    const lines: SmcV2StructureLine[] = [], append = createProtectedStructurePath(scope, lines);
    append(pivot(0, 100, true), 1);
    append(pivot(2, 90, false), 3);
    append(pivot(6, 110, true), 7);
    append(pivot(4, 85, false), 8);
    expect(active(lines)).toEqual([[0, 100, 4, 85], [4, 85, 6, 110]]);
    expect(active(lines, 7)).toEqual([[0, 100, 2, 90], [2, 90, 6, 110]]);
    expect(active(lines).every(([from, , to]) => from < to)).toBe(true);
  });

  it('restores a hidden earlier high when a higher pullback is promoted between highs', () => {
    const lines: SmcV2StructureLine[] = [], append = createProtectedStructurePath(scope, lines);
    append(pivot(0, 90, false), 1);
    append(pivot(2, 100, true), 3);
    append(pivot(6, 110, true), 7);
    expect(active(lines)).toEqual([[0, 90, 6, 110]]);
    append(pivot(4, 95, false), 8);
    expect(active(lines)).toEqual([[0, 90, 2, 100], [2, 100, 4, 95], [4, 95, 6, 110]]);
    expect(active(lines, 7)).toEqual([[0, 90, 6, 110]]);
  });

  it('restores a hidden earlier low when a lower pullback is promoted between lows', () => {
    const lines: SmcV2StructureLine[] = [], append = createProtectedStructurePath(scope, lines);
    append(pivot(0, 110, true), 1);
    append(pivot(2, 100, false), 3);
    append(pivot(6, 90, false), 7);
    append(pivot(4, 105, true), 8);
    expect(active(lines)).toEqual([[0, 110, 2, 100], [2, 100, 4, 105], [4, 105, 6, 90]]);
  });

  it('matches a chronological reconstruction despite out-of-order promotions and preserves past views', () => {
    const lines: SmcV2StructureLine[] = [], append = createProtectedStructurePath(scope, lines);
    const arrivals = Array.from({ length: 40 }, (_, i) => {
      const index = (i * 17) % 40;
      return pivot(index, 100 + Math.sin(index) * 10, index % 3 === 0);
    });
    const snapshots: number[][][] = [];
    arrivals.forEach((next, confirmedAt) => {
      append(next, confirmedAt);
      const chronological = arrivals.slice(0, confirmedAt + 1).sort((a, b) => a.index - b.index);
      const expected: SmcV2Pivot[] = [];
      for (const p of chronological) {
        const tail = expected[expected.length - 1];
        if (!tail || p.direction !== tail.direction) expected.push(p);
        else if (p.direction === 'bearish' ? p.price >= tail.price : p.price <= tail.price) expected[expected.length - 1] = p;
      }
      const segments = expected.slice(1).map((p, i) => [expected[i].index, expected[i].price, p.index, p.price]);
      expect(active(lines)).toEqual(segments);
      snapshots.push(segments);
    });
    snapshots.forEach((expected, index) => expect(active(lines, index)).toEqual(expected));
  });
});
