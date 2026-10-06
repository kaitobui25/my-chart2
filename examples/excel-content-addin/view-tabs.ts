export type ExcelAddinView = 'chart' | 'watchlist' | 'options';

export interface ViewTabsOptions {
  chartTab: HTMLButtonElement;
  watchlistTab: HTMLButtonElement;
  optionsTab: HTMLButtonElement;
  chartView: HTMLElement;
  watchlistView: HTMLElement;
  optionsView: HTMLElement;
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
  const onOptions = () => select('options');
  const onKeyDown = (event: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const views: ExcelAddinView[] = ['chart', 'watchlist', 'options'];
    const index = views.indexOf(current);
    const next = event.key === 'Home'
      ? 'chart'
      : event.key === 'End'
        ? 'options'
        : views[(index + (event.key === 'ArrowRight' ? 1 : -1) + views.length) % views.length];
    select(next);
    ({ chart: options.chartTab, watchlist: options.watchlistTab, options: options.optionsTab })[next].focus();
  };
  options.chartTab.addEventListener('click', onChart);
  options.watchlistTab.addEventListener('click', onWatchlist);
  options.optionsTab.addEventListener('click', onOptions);
  options.chartTab.addEventListener('keydown', onKeyDown);
  options.watchlistTab.addEventListener('keydown', onKeyDown);
  options.optionsTab.addEventListener('keydown', onKeyDown);
  apply();

  return {
    select,
    dispose() {
      options.chartTab.removeEventListener('click', onChart);
      options.watchlistTab.removeEventListener('click', onWatchlist);
      options.optionsTab.removeEventListener('click', onOptions);
      options.chartTab.removeEventListener('keydown', onKeyDown);
      options.watchlistTab.removeEventListener('keydown', onKeyDown);
      options.optionsTab.removeEventListener('keydown', onKeyDown);
    },
  };

  function apply(): void {
    const chartActive = current === 'chart';
    const watchlistActive = current === 'watchlist';
    const optionsActive = current === 'options';
    options.chartTab.setAttribute('aria-selected', String(chartActive));
    options.watchlistTab.setAttribute('aria-selected', String(watchlistActive));
    options.optionsTab.setAttribute('aria-selected', String(optionsActive));
    options.chartTab.tabIndex = chartActive ? 0 : -1;
    options.watchlistTab.tabIndex = watchlistActive ? 0 : -1;
    options.optionsTab.tabIndex = optionsActive ? 0 : -1;
    options.chartView.hidden = !chartActive;
    options.watchlistView.hidden = !watchlistActive;
    options.optionsView.hidden = !optionsActive;
  }
}
