export interface ExcelDisplayPreferences {
  candlesOnHoverOnly: boolean;
  preserveReplayZoom: boolean;
}

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'l2chart.excel.display-preferences.v1';

export const DEFAULT_EXCEL_DISPLAY_PREFERENCES: Readonly<ExcelDisplayPreferences> = Object.freeze({
  candlesOnHoverOnly: false,
  preserveReplayZoom: false,
});

export class ExcelDisplayPreferencesStore {
  private value: ExcelDisplayPreferences;

  constructor(private readonly storage: PreferenceStorage | null = browserStorage()) {
    this.value = this.read();
  }

  get(): Readonly<ExcelDisplayPreferences> {
    return this.value;
  }

  update(patch: Partial<ExcelDisplayPreferences>): Readonly<ExcelDisplayPreferences> {
    this.value = { ...this.value, ...patch };
    this.write();
    return this.value;
  }

  private read(): ExcelDisplayPreferences {
    if (!this.storage) return { ...DEFAULT_EXCEL_DISPLAY_PREFERENCES };
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_EXCEL_DISPLAY_PREFERENCES };
      const parsed = JSON.parse(raw) as Partial<ExcelDisplayPreferences>;
      return {
        candlesOnHoverOnly: typeof parsed.candlesOnHoverOnly === 'boolean'
          ? parsed.candlesOnHoverOnly
          : DEFAULT_EXCEL_DISPLAY_PREFERENCES.candlesOnHoverOnly,
        preserveReplayZoom: typeof parsed.preserveReplayZoom === 'boolean'
          ? parsed.preserveReplayZoom
          : DEFAULT_EXCEL_DISPLAY_PREFERENCES.preserveReplayZoom,
      };
    } catch {
      return { ...DEFAULT_EXCEL_DISPLAY_PREFERENCES };
    }
  }

  private write(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.value));
    } catch {
      // Persistence is optional in restricted Office WebViews.
    }
  }
}

function browserStorage(): PreferenceStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
