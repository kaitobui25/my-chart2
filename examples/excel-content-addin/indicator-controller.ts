import type { L2Chart } from '../../src/library';
import { builtinIndicators } from '../../src/indicators/builtin/all';
import {
  defaultParams,
  type IndicatorCategory,
  type IndicatorDef,
  type IndicatorInstance,
} from '../../src/indicators/registry';

export interface IndicatorOption {
  id: string;
  name: string;
  category: IndicatorCategory;
}

export class IndicatorController {
  private active: IndicatorInstance | null = null;
  private activeId = '';
  private activeParams: Record<string, unknown> = {};
  private readonly byId = new Map<string, IndicatorDef>(
    builtinIndicators.map((definition) => [definition.id, definition]),
  );
  private readonly offData: () => void;

  constructor(private readonly chart: L2Chart) {
    this.offData = chart.on('data', () => this.active?.recompute());
  }

  options(): IndicatorOption[] {
    return builtinIndicators
      .map(({ id, name, category }) => ({ id, name, category }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  select(id: string): void {
    if (id === this.activeId) return;
    this.active?.remove();
    this.active = null;
    this.activeId = '';
    this.activeParams = {};

    if (!id) return;
    const definition = this.byId.get(id);
    if (!definition) throw new Error(`Unknown indicator: ${id}`);
    const params = defaultParams(definition);
    this.active = this.chart.withIndicatorOwner(
      definition.id,
      () => definition.create(this.chart, params),
    );
    this.activeId = definition.id;
    this.activeParams = { ...params };
    this.active.recompute();
  }

  recompute(): void {
    this.active?.recompute();
  }

  contextSnapshot(): Array<{ id: string; params: Record<string, unknown> }> {
    return this.activeId ? [{ id: this.activeId, params: { ...this.activeParams } }] : [];
  }

  dispose(): void {
    this.offData();
    this.active?.remove();
    this.active = null;
    this.activeId = '';
    this.activeParams = {};
  }
}
