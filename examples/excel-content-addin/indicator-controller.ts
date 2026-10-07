import type { L2Chart } from '../../src/library';
import { builtinIndicators } from '../../src/indicators/builtin/all';
import {
  type IndicatorCategory,
  type IndicatorDef,
  type IndicatorInstance,
  type Params,
} from '../../src/indicators/registry';
import {
  indicatorAppearanceFromParams,
  mergeIndicatorSettings,
} from './indicator-settings';

export interface IndicatorOption {
  id: string;
  name: string;
  category: IndicatorCategory;
  favorite: boolean;
}

export interface IndicatorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const FAVORITES_STORAGE_KEY = 'l2chart.excel.indicator-favorites.v1';
const STATE_STORAGE_KEY = 'l2chart.excel.indicator-state.v1';

interface StoredIndicatorState {
  activeIds: string[];
  paramsById: Record<string, Params>;
}

export class IndicatorController {
  private readonly active = new Map<string, IndicatorInstance>();
  private readonly paramsById = new Map<string, Params>();
  private readonly favoriteIds: Set<string>;
  private readonly byId = new Map<string, IndicatorDef>(
    builtinIndicators.map((definition) => [definition.id, definition]),
  );
  private readonly offData: () => void;

  constructor(
    private readonly chart: L2Chart,
    private readonly storage: IndicatorStorage | null = browserStorage(),
  ) {
    this.favoriteIds = this.loadFavorites();
    const restored = this.loadState();
    for (const [id, params] of Object.entries(restored.paramsById)) {
      this.paramsById.set(id, params);
    }
    for (const id of restored.activeIds) this.activateInternal(id, false);
    this.offData = chart.on('data', () => {
      for (const instance of this.active.values()) instance.recompute();
    });
  }

  options(): IndicatorOption[] {
    return builtinIndicators
      .map(({ id, name, category }) => ({
        id,
        name,
        category,
        favorite: this.favoriteIds.has(id),
      }))
      .sort((left, right) => {
        if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  }

  isFavorite(id: string): boolean {
    return this.favoriteIds.has(id);
  }

  toggleFavorite(id: string): boolean {
    if (!this.byId.has(id)) throw new Error(`Unknown indicator: ${id}`);
    if (this.favoriteIds.has(id)) this.favoriteIds.delete(id);
    else this.favoriteIds.add(id);
    this.persistFavorites();
    return this.favoriteIds.has(id);
  }

  activate(id: string): void {
    this.activateInternal(id, true);
  }

  private activateInternal(id: string, persist: boolean): void {
    if (this.active.has(id)) return;
    const definition = this.byId.get(id);
    if (!definition) throw new Error(`Unknown indicator: ${id}`);
    const params = this.getParams(id);
    const instance = this.createInstance(definition, params);
    this.active.set(definition.id, instance);
    if (persist) this.persistState();
  }

  deactivate(id: string): void {
    const instance = this.active.get(id);
    if (!instance) return;
    instance.remove();
    this.active.delete(id);
    this.persistState();
  }

  toggle(id: string): boolean {
    if (this.active.has(id)) {
      this.deactivate(id);
      return false;
    }
    this.activate(id);
    return true;
  }

  clear(): void {
    for (const instance of this.active.values()) instance.remove();
    this.active.clear();
    this.persistState();
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  getActiveIds(): string[] {
    return [...this.active.keys()];
  }

  getDefinition(id: string): IndicatorDef | undefined {
    return this.byId.get(id);
  }

  getParams(id: string): Params {
    const definition = this.byId.get(id);
    if (!definition) throw new Error(`Unknown indicator: ${id}`);
    return mergeIndicatorSettings(definition, this.paramsById.get(id) ?? {});
  }

  setParams(id: string, params: Params): void {
    const definition = this.byId.get(id);
    if (!definition) throw new Error(`Unknown indicator: ${id}`);
    const mergedParams = mergeIndicatorSettings(definition, params);
    this.paramsById.set(id, mergedParams);
    this.persistState();
    if (!this.active.has(id)) return;

    this.active.get(id)?.remove();
    const instance = this.createInstance(definition, mergedParams);
    this.active.set(id, instance);
    this.chart.invalidate();
  }

  recompute(): void {
    for (const instance of this.active.values()) instance.recompute();
  }

  contextSnapshot(): Array<{ id: string; params: Record<string, unknown> }> {
    return this.getActiveIds().map((id) => ({
      id,
      params: Object.fromEntries(
        Object.entries(this.getParams(id)).filter(([key]) => !key.startsWith('__')),
      ),
    }));
  }

  dispose(): void {
    this.offData();
    for (const instance of this.active.values()) instance.remove();
    this.active.clear();
  }

  private createInstance(definition: IndicatorDef, params: Params): IndicatorInstance {
    const instance = this.chart.withIndicatorOwner(
      definition.id,
      () => definition.create(this.chart, params),
      indicatorAppearanceFromParams(definition.id, params),
    );
    instance.recompute();
    return instance;
  }

  private loadFavorites(): Set<string> {
    if (!this.storage) return new Set();
    try {
      const raw = this.storage.getItem(FAVORITES_STORAGE_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.map(String).filter((id) => this.byId.has(id)));
    } catch {
      return new Set();
    }
  }

  private persistFavorites(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...this.favoriteIds]));
    } catch {
      // Storage can be unavailable in restricted Office WebViews. Favorites
      // still work in memory for the lifetime of the add-in.
    }
  }

  private loadState(): StoredIndicatorState {
    const empty: StoredIndicatorState = { activeIds: [], paramsById: {} };
    if (!this.storage) return empty;
    try {
      const raw = this.storage.getItem(STATE_STORAGE_KEY);
      if (!raw) return empty;
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) return empty;

      const activeIds = Array.isArray(parsed.activeIds)
        ? [...new Set(parsed.activeIds.map(String).filter((id) => this.byId.has(id)))]
        : [];
      const paramsById: Record<string, Params> = {};
      if (isRecord(parsed.paramsById)) {
        for (const [id, value] of Object.entries(parsed.paramsById)) {
          if (!this.byId.has(id) || !isRecord(value)) continue;
          const params = Object.fromEntries(
            Object.entries(value).filter((entry): entry is [string, string | number | boolean] => (
              typeof entry[1] === 'string'
              || typeof entry[1] === 'number'
              || typeof entry[1] === 'boolean'
            )),
          );
          paramsById[id] = params;
        }
      }
      return { activeIds, paramsById };
    } catch {
      return empty;
    }
  }

  private persistState(): void {
    if (!this.storage) return;
    const paramsById = Object.fromEntries(
      [...this.paramsById.entries()].filter(([id]) => this.byId.has(id)),
    );
    try {
      this.storage.setItem(STATE_STORAGE_KEY, JSON.stringify({
        activeIds: this.getActiveIds(),
        paramsById,
      } satisfies StoredIndicatorState));
    } catch {
      // Storage can be unavailable in restricted Office WebViews. Indicator
      // state remains usable in memory for the lifetime of the add-in.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function browserStorage(): IndicatorStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
