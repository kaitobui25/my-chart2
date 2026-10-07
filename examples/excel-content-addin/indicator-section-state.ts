export interface IndicatorSectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'l2chart.excel.indicator-section-state.v1';

export class IndicatorSectionStateStore {
  private readonly expanded: Set<string>;

  constructor(
    private readonly storage: IndicatorSectionStorage | null = browserStorage(),
  ) {
    this.expanded = this.load();
  }

  isExpanded(indicatorId: string, section: string): boolean {
    return this.expanded.has(sectionKey(indicatorId, section));
  }

  setExpanded(indicatorId: string, section: string, expanded: boolean): void {
    const key = sectionKey(indicatorId, section);
    if (expanded) this.expanded.add(key);
    else this.expanded.delete(key);
    this.persist();
  }

  private load(): Set<string> {
    if (!this.storage) return new Set();
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.map(String));
    } catch {
      return new Set();
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify([...this.expanded]));
    } catch {
      // Office WebViews may disable localStorage. Collapse still works for the
      // current dialog instance when persistence is unavailable.
    }
  }
}

function sectionKey(indicatorId: string, section: string): string {
  return `${indicatorId}\u0000${section}`;
}

function browserStorage(): IndicatorSectionStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
