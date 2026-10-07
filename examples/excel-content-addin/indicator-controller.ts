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

export interface IndicatorFavoriteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const FAVORITES_STORAGE_KEY = 'l2chart.excel.indicator-favorites.v1';

export class IndicatorController {
  private active: IndicatorInstance | null = null;
  private activeId = '';
  private readonly paramsById = new Map<string, Params>();
  private readonly favoriteIds: Set<string>;
  private readonly byId = new Map<string, IndicatorDef>(
    builtinIndicators.map((definition) => [definition.id, definition]),
  );
  private readonly offData: () => void;

  constructor(
    private readonly chart: L2Chart,
    private readonly storage: IndicatorFavoriteStorage | null = browserStorage(),
  ) {
    this.favoriteIds = this.loadFavorites();
    this.offData = chart.on('data', () => this.active?.recompute());
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

  select(id: string): void {
    if (id === this.activeId) return;
    this.active?.remove();
    this.active = null;
    this.activeId = '';

    if (!id) return;
    const definition = this.byId.get(id);
    if (!definition) throw new Error(`Unknown indicator: ${id}`);
    const params = this.getParams(id);
    this.active = this.chart.withIndicatorOwner(
      definition.id,
      () => definition.create(this.chart, params),
      indicatorAppearanceFromParams(definition.id, params),
    );
    this.activeId = definition.id;
    this.active.recompute();
  }

  getActiveId(): string {
    return this.activeId;
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
    if (id !== this.activeId) return;

    this.active?.remove();
    this.active = this.chart.withIndicatorOwner(
      definition.id,
      () => definition.create(this.chart, mergedParams),
      indicatorAppearanceFromParams(definition.id, mergedParams),
    );
    this.active.recompute();
    this.chart.invalidate();
  }

  recompute(): void {
    this.active?.recompute();
  }

  contextSnapshot(): Array<{ id: string; params: Record<string, unknown> }> {
    if (!this.activeId) return [];
    const params = Object.fromEntries(
      Object.entries(this.getParams(this.activeId)).filter(([key]) => !key.startsWith('__')),
    );
    return [{ id: this.activeId, params }];
  }

  dispose(): void {
    this.offData();
    this.active?.remove();
    this.active = null;
    this.activeId = '';
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
}

function browserStorage(): IndicatorFavoriteStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
