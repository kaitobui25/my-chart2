export interface PriceSeriesRenderTarget {
  setPriceSeriesRenderVisible(visible: boolean): void;
}

export class HoverCandleController {
  private enabled: boolean;
  private pointerInside = false;
  private appliedVisible: boolean | null = null;

  private readonly onPointerEnter = () => {
    this.pointerInside = true;
    this.apply();
  };

  private readonly onPointerLeave = () => {
    this.pointerInside = false;
    this.apply();
  };

  constructor(
    private readonly chart: PriceSeriesRenderTarget,
    private readonly surface: HTMLElement,
    enabled: boolean,
  ) {
    this.enabled = enabled;
    this.pointerInside = isHovered(surface);
    surface.addEventListener('pointerenter', this.onPointerEnter);
    surface.addEventListener('pointerleave', this.onPointerLeave);
    this.apply();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.apply();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  dispose(): void {
    this.surface.removeEventListener('pointerenter', this.onPointerEnter);
    this.surface.removeEventListener('pointerleave', this.onPointerLeave);
    this.chart.setPriceSeriesRenderVisible(true);
  }

  private apply(): void {
    const visible = !this.enabled || this.pointerInside;
    if (visible === this.appliedVisible) return;
    this.appliedVisible = visible;
    this.chart.setPriceSeriesRenderVisible(visible);
  }
}

function isHovered(surface: HTMLElement): boolean {
  try {
    return surface.matches(':hover');
  } catch {
    return false;
  }
}
