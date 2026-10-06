import type { SmcV2Pivot, SmcV2Scope, SmcV2StructureLine } from './smart-money-concepts-v2-model';

/** Chronological zigzag of accepted pivots; consecutive highs/lows retain the extreme. */
export function createProtectedStructurePath(scope: SmcV2Scope, lines: SmcV2StructureLine[]) {
  // Keep accepted pivots even while a same-side extreme temporarily hides them.
  // A later promotion can split that run and make its earlier vertices relevant again.
  const accepted: SmcV2Pivot[] = [];
  const points: SmcV2Pivot[] = [];
  const edges: SmcV2StructureLine[] = [];
  const moreExtreme = (next: SmcV2Pivot, old: SmcV2Pivot) =>
    next.direction === 'bearish' ? next.price >= old.price : next.price <= old.price;

  const replaceEdge = (position: number, confirmedAt: number) => {
    const from = points[position], to = points[position + 1];
    const old = edges[position];
    if (old) old.supersededAt = confirmedAt;
    const line: SmcV2StructureLine = { fromIndex: from.index, fromPrice: from.price,
      toIndex: to.index, toPrice: to.price, confirmedAt, scope };
    edges[position] = line;
    lines.push(line);
  };

  const lowerBound = (items: readonly SmcV2Pivot[], index: number): number => {
    let left = 0, right = items.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (items[middle].index < index) left = middle + 1;
      else right = middle;
    }
    return left;
  };

  return (pivot: SmcV2Pivot, confirmedAt: number): void => {
    const position = lowerBound(accepted, pivot.index);
    if (accepted[position]?.index === pivot.index) return;
    const chronological = position === accepted.length;
    accepted.splice(position, 0, pivot);
    const last = points.length - 1;
    if (last < 0) { points.push(pivot); return; }
    const tail = points[last];
    // Normal chronological arrivals update only the active leg.
    if (chronological) {
      if (pivot.direction !== tail.direction) {
        points.push(pivot);
        replaceEdge(last, confirmedAt);
      } else if (moreExtreme(pivot, tail)) {
        points[last] = pivot;
        if (last > 0) replaceEdge(last - 1, confirmedAt);
      }
      return;
    }
    // Revisit the adjacent run, including vertices hidden by its former extreme.
    // The already-finalized prefix remains untouched.
    let start = Math.max(0, position - 1);
    while (start > 0 && accepted[start - 1].direction === accepted[start].direction) start--;
    const prefix = lowerBound(points, accepted[start].index);
    const rebuilt: SmcV2Pivot[] = [];
    for (let i = start; i < accepted.length; i++) {
      const next = accepted[i], previous = rebuilt[rebuilt.length - 1];
      if (!previous || next.direction !== previous.direction) rebuilt.push(next);
      else if (moreExtreme(next, previous)) rebuilt[rebuilt.length - 1] = next;
    }
    let shared = 0;
    while (shared < rebuilt.length && points[prefix + shared] === rebuilt[shared]) shared++;
    const unchanged = prefix + shared;
    const firstEdge = Math.max(0, unchanged - 1);
    for (let i = firstEdge; i < edges.length; i++) edges[i].supersededAt = confirmedAt;
    points.splice(unchanged, points.length - unchanged, ...rebuilt.slice(shared));
    edges.length = firstEdge;
    for (let i = firstEdge; i < points.length - 1; i++) {
      replaceEdge(i, confirmedAt);
    }
  };
}
