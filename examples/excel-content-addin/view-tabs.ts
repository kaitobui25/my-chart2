export type ExcelAddinView = 'chart' | 'watchlist';

export interface ViewTabsOptions {
  chartTab: HTMLButtonElement;
  watchlistTab: HTMLButtonElement;
  chartView: HTMLElement;
  watchlistView: HTMLElement;
  onChange?(view: ExcelAddinView): void;
}

export interface ViewTabsBinding {
  select(view: ExcelAddinView): void;
  dispose(): void;
}

export function bindViewTabs(options: ViewTabsOptions): ViewTabsBinding {
  let current: ExcelAddinView = 'chart';

  const select = (view: ExcelAddinView) => {
    if (current === view) return;
    current = view;
    apply();
    options.onChange?.(view);
  };
  const onChart = () => select('chart');
  const onWatchlist = () => select('watchlist');
  const onKeyDown = (event: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next: ExcelAddinView = event.key === 'ArrowLeft' || event.key === 'Home' ? 'chart' : 'watchlist';
    select(next);
    (next === 'chart' ? options.chartTab : options.watchlistTab).focus();
  };
  options.chartTab.addEventListener('click', onChart);
  options.watchlistTab.addEventListener('click', onWatchlist);
  options.chartTab.addEventListener('keydown', onKeyDown);
  options.watchlistTab.addEventListener('keydown', onKeyDown);
  apply();

  return {
    select,
    dispose() {
      options.chartTab.removeEventListener('click', onChart);
      options.watchlistTab.removeEventListener('click', onWatchlist);
      options.chartTab.removeEventListener('keydown', onKeyDown);
      options.watchlistTab.removeEventListener('keydown', onKeyDown);
    },
  };

  function apply(): void {
    const chartActive = current === 'chart';
    options.chartTab.setAttribute('aria-selected', String(chartActive));
    options.watchlistTab.setAttribute('aria-selected', String(!chartActive));
    options.chartTab.tabIndex = chartActive ? 0 : -1;
    options.watchlistTab.tabIndex = chartActive ? -1 : 0;
    options.chartView.hidden = !chartActive;
    options.watchlistView.hidden = chartActive;
  }
}
