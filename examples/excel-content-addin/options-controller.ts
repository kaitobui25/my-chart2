import type { L2Chart } from '../../src/library';
import { ExcelDisplayPreferencesStore, type PreferenceStorage } from './display-preferences';
import { HoverCandleController } from './hover-candle-controller';

export interface ExcelOptionsControllerOptions {
  chart: L2Chart;
  surface: HTMLElement;
  candlesOnHoverOnly: HTMLInputElement;
  storage?: PreferenceStorage | null;
}

export class ExcelOptionsController {
  private readonly store: ExcelDisplayPreferencesStore;
  private readonly hoverCandles: HoverCandleController;
  private readonly onChange: () => void;

  constructor(private readonly options: ExcelOptionsControllerOptions) {
    this.store = new ExcelDisplayPreferencesStore(options.storage);
    const preferences = this.store.get();
    options.candlesOnHoverOnly.checked = preferences.candlesOnHoverOnly;
    this.hoverCandles = new HoverCandleController(
      options.chart,
      options.surface,
      preferences.candlesOnHoverOnly,
    );
    this.onChange = () => {
      const enabled = options.candlesOnHoverOnly.checked;
      this.store.update({ candlesOnHoverOnly: enabled });
      this.hoverCandles.setEnabled(enabled);
    };
    options.candlesOnHoverOnly.addEventListener('change', this.onChange);
  }

  dispose(): void {
    this.options.candlesOnHoverOnly.removeEventListener('change', this.onChange);
    this.hoverCandles.dispose();
  }
}
