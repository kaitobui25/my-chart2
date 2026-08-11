import { L2Chart } from '../../src/index';
import type { Theme } from '../../src/core/types';
import {
  CANDLE_THEME_PRESETS,
  CANDLE_THEME_STORAGE_KEY,
  normalizeCandleTheme,
  resolveCandleThemeColors,
  type CandleThemeColors,
  type CandleThemeId,
} from './candle-themes';

const CANDLE_KEYS = ['up', 'down', 'wickUp', 'wickDown'] as const;
const CONTROL_ID = 'candle-theme-settings';
const SELECT_ID = 'candle-theme-select';
const STYLE_ID = 'candle-theme-control-style';

const trackedCharts = new Set<L2Chart>();
const baseColors = new WeakMap<L2Chart, CandleThemeColors>();
const originalSetTheme = L2Chart.prototype.setTheme;
const originalDestroy = L2Chart.prototype.destroy;

let selectedTheme = readStoredTheme();

function isDarkMode(): boolean {
  return !document.body.classList.contains('light');
}

function readStoredTheme(): CandleThemeId {
  try {
    return normalizeCandleTheme(localStorage.getItem(CANDLE_THEME_STORAGE_KEY));
  } catch {
    return 'default';
  }
}

function writeStoredTheme(theme: CandleThemeId): void {
  try {
    localStorage.setItem(CANDLE_THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
}

function pickCandleColors(theme: Theme): CandleThemeColors {
  return {
    up: theme.up,
    down: theme.down,
    wickUp: theme.wickUp,
    wickDown: theme.wickDown,
  };
}

function captureBaseColors(chart: L2Chart, patch: Partial<Theme>): CandleThemeColors {
  const next = {
    ...(baseColors.get(chart) ?? pickCandleColors(chart.theme)),
  };
  for (const key of CANDLE_KEYS) {
    const value = patch[key];
    if (value !== undefined) next[key] = value;
  }
  baseColors.set(chart, next);
  return next;
}

function effectivePatch(patch: Partial<Theme>): Partial<Theme> {
  const colors = resolveCandleThemeColors(selectedTheme, isDarkMode());
  return Object.keys(colors).length > 0 ? { ...patch, ...colors } : patch;
}

L2Chart.prototype.setTheme = function setThemeWithCandlePreset(
  this: L2Chart,
  theme: Partial<Theme>,
): void {
  trackedCharts.add(this);
  captureBaseColors(this, theme);
  originalSetTheme.call(this, effectivePatch(theme));
};

L2Chart.prototype.destroy = function destroyTrackedChart(this: L2Chart): void {
  trackedCharts.delete(this);
  baseColors.delete(this);
  originalDestroy.call(this);
};

function refreshTrackedCharts(): void {
  const override = resolveCandleThemeColors(selectedTheme, isDarkMode());
  for (const chart of trackedCharts) {
    const base = baseColors.get(chart);
    if (!base) continue;
    originalSetTheme.call(chart, { ...base, ...override });
  }
}

function setSelectedTheme(theme: CandleThemeId): void {
  const next = theme === 'cyber' && !isDarkMode() ? 'default' : theme;
  selectedTheme = next;
  writeStoredTheme(next);
  document.documentElement.dataset.candleTheme = next;
  refreshTrackedCharts();
  syncControl();
}

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${CONTROL_ID} {
      border-top: 1px solid var(--border);
    }

    #${CONTROL_ID} .candle-theme-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 132px;
      align-items: center;
      gap: 10px;
    }

    #${CONTROL_ID} .candle-theme-row > span {
      color: var(--text-dim);
      font-size: 12px;
      font-weight: 650;
    }

    #${SELECT_ID} {
      width: 132px;
      height: 30px;
      padding: 0 28px 0 9px;
      border: 1px solid var(--border-strong);
      border-radius: 5px;
      background: var(--bg-inset);
      color: var(--text);
      font: 600 12px/1 var(--sans);
      outline: none;
      cursor: pointer;
    }

    #${SELECT_ID}:focus {
      border-color: var(--accent);
    }

    #${CONTROL_ID} .candle-theme-note {
      display: block;
      margin-top: 6px;
      color: var(--text-dim);
      font-size: 10px;
      line-height: 1.35;
      opacity: 0.72;
    }
  `;
  document.head.appendChild(style);
}

function buildControl(): HTMLElement {
  const section = document.createElement('section');
  section.id = CONTROL_ID;
  section.className = 'toolbar-more-settings';

  const title = document.createElement('strong');
  title.textContent = 'Theme nến';

  const row = document.createElement('label');
  row.className = 'candle-theme-row';
  const label = document.createElement('span');
  label.textContent = 'Theme';
  const select = document.createElement('select');
  select.id = SELECT_ID;
  select.setAttribute('aria-label', 'Candle theme');

  CANDLE_THEME_PRESETS.forEach((preset, index) => {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = `${index + 1} · ${preset.label}`;
    select.appendChild(option);
  });

  select.addEventListener('change', () => {
    setSelectedTheme(normalizeCandleTheme(select.value));
  });

  const note = document.createElement('small');
  note.className = 'candle-theme-note';
  note.textContent = 'Cyber chỉ đổi màu thân/râu nến và chỉ dùng trong Dark Mode.';

  row.append(label, select);
  section.append(title, row, note);
  return section;
}

function syncControl(): void {
  const select = document.getElementById(SELECT_ID) as HTMLSelectElement | null;
  if (!select) return;
  const dark = isDarkMode();
  const cyberOption = select.querySelector<HTMLOptionElement>('option[value="cyber"]');
  if (cyberOption) cyberOption.disabled = !dark;
  select.value = selectedTheme;
  select.title = dark ? '' : 'Cyber chỉ dùng trong Dark Mode';
}

function mountControl(): void {
  const menu = document.getElementById('toolbar-more-menu');
  if (!menu || document.getElementById(CONTROL_ID)) {
    syncControl();
    return;
  }

  const control = buildControl();
  const autoSave = menu.querySelector('.toolbar-more-auto-save');
  if (autoSave?.nextSibling) menu.insertBefore(control, autoSave.nextSibling);
  else if (autoSave) menu.appendChild(control);
  else menu.prepend(control);
  syncControl();
}

function handleAppearanceChange(): void {
  if (!isDarkMode() && selectedTheme === 'cyber') {
    selectedTheme = 'default';
    writeStoredTheme(selectedTheme);
    document.documentElement.dataset.candleTheme = selectedTheme;
    refreshTrackedCharts();
  }
  syncControl();
}

installStyles();
document.documentElement.dataset.candleTheme = selectedTheme;

const menuObserver = new MutationObserver(mountControl);
menuObserver.observe(document.body, { childList: true, subtree: true });

const appearanceObserver = new MutationObserver(handleAppearanceChange);
appearanceObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

mountControl();
