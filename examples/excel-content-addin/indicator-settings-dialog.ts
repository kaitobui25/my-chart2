import type { IndicatorDef, Params } from '../../src/indicators/registry';
import type { IndicatorController } from './indicator-controller';
import {
  defaultIndicatorSettings,
  INDICATOR_STYLE_KEYS,
  mergeIndicatorSettings,
} from './indicator-settings';
import { IndicatorSectionStateStore } from './indicator-section-state';

const COLLAPSIBLE_SECTION_INDICATORS = new Set([
  'smart-money-concepts-v2',
  'smart-money-concepts-v3',
]);

export class IndicatorSettingsDialog {
  private readonly overlay = element<HTMLElement>('#param-overlay');
  private readonly title = element<HTMLElement>('#param-title');
  private readonly fields = element<HTMLElement>('#param-fields');
  private readonly resetButton = element<HTMLButtonElement>('#param-reset');
  private readonly cancelButton = element<HTMLButtonElement>('#param-cancel');
  private readonly okButton = element<HTMLButtonElement>('#param-ok');
  private readonly closeButton = element<HTMLButtonElement>('#param-close');
  private activeId = '';
  private readonly sectionState = new IndicatorSectionStateStore();

  private readonly onReset = () => this.reset();
  private readonly onCancel = () => this.close();
  private readonly onApply = () => this.apply();
  private readonly onOverlayPointerDown = (event: PointerEvent) => {
    if (event.target === this.overlay) this.close();
  };
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || this.overlay.hidden) return;
    event.preventDefault();
    this.close();
  };

  constructor(
    private readonly indicators: IndicatorController,
    private readonly applied?: () => void,
  ) {
    this.resetButton.addEventListener('click', this.onReset);
    this.cancelButton.addEventListener('click', this.onCancel);
    this.okButton.addEventListener('click', this.onApply);
    this.closeButton.addEventListener('click', this.onCancel);
    this.overlay.addEventListener('pointerdown', this.onOverlayPointerDown);
    document.addEventListener('keydown', this.onKeyDown);
  }

  open(id: string): void {
    const definition = this.indicators.getDefinition(id);
    if (!definition) return;
    this.activeId = id;
    this.title.textContent = definition.name;
    this.fill(definition, this.indicators.getParams(id));
    this.overlay.hidden = false;
    window.setTimeout(() => {
      this.fields.querySelector<HTMLElement>('input, select')?.focus();
    }, 0);
  }

  close(): void {
    this.activeId = '';
    this.overlay.hidden = true;
  }

  dispose(): void {
    this.resetButton.removeEventListener('click', this.onReset);
    this.cancelButton.removeEventListener('click', this.onCancel);
    this.okButton.removeEventListener('click', this.onApply);
    this.closeButton.removeEventListener('click', this.onCancel);
    this.overlay.removeEventListener('pointerdown', this.onOverlayPointerDown);
    document.removeEventListener('keydown', this.onKeyDown);
  }

  private apply(): void {
    const definition = this.indicators.getDefinition(this.activeId);
    if (!definition) return;
    this.indicators.setParams(definition.id, this.collect(definition));
    this.applied?.();
    this.close();
  }

  private reset(): void {
    const definition = this.indicators.getDefinition(this.activeId);
    if (!definition) return;
    this.fill(definition, defaultIndicatorSettings(definition));
  }

  private fill(definition: IndicatorDef, values: Params): void {
    this.fields.replaceChildren();
    const mergedValues = mergeIndicatorSettings(definition, values);
    const hasSections = (definition.params ?? []).some((param) => param.section);

    if (!hasSections) {
      this.fields.appendChild(sectionTitle('Thông số tính toán', 'Thay đổi cách chỉ báo được tính'));
    }

    const collapsibleSections = COLLAPSIBLE_SECTION_INDICATORS.has(definition.id);
    let currentSection: string | undefined;
    let currentSectionBody: HTMLElement | null = null;
    for (const param of definition.params ?? []) {
      if (param.section && param.section !== currentSection) {
        currentSection = param.section;
        if (collapsibleSections) {
          const group = document.createElement('section');
          group.className = 'param-group';
          const body = document.createElement('div');
          body.className = 'param-group-body';
          const expanded = this.sectionState.isExpanded(definition.id, param.section);
          body.hidden = !expanded;
          const heading = this.createGroupToggle(definition.id, param.section, body, expanded);
          group.append(heading, body);
          this.fields.appendChild(group);
          currentSectionBody = body;
        } else {
          const heading = document.createElement('div');
          heading.className = 'param-section-title param-group-title';
          heading.textContent = param.section;
          this.fields.appendChild(heading);
          currentSectionBody = null;
        }
      }

      const row = document.createElement('label');
      row.className = param.type === 'boolean' ? 'param-row param-toggle-row' : 'param-row';
      const name = document.createElement('span');
      name.textContent = param.label;
      let input: HTMLInputElement | HTMLSelectElement;

      if (param.type === 'select') {
        input = document.createElement('select');
        for (const optionDefinition of param.options ?? []) {
          const option = document.createElement('option');
          option.value = optionDefinition.value;
          option.textContent = optionDefinition.label;
          input.appendChild(option);
        }
        input.value = String(mergedValues[param.key]);
      } else {
        input = document.createElement('input');
        if (param.type === 'boolean') {
          input.type = 'checkbox';
          input.checked = mergedValues[param.key] === true;
        } else if (param.type === 'color') {
          input.type = 'color';
          input.value = String(mergedValues[param.key]);
        } else {
          input.type = 'number';
          if (param.min !== undefined) input.min = String(param.min);
          if (param.max !== undefined) input.max = String(param.max);
          input.step = String(param.step ?? (param.type === 'int' ? 1 : 0.1));
          input.value = String(mergedValues[param.key]);
        }
      }
      input.dataset.key = param.key;
      row.append(name, input);
      (currentSectionBody ?? this.fields).appendChild(row);
    }

    if (!definition.params?.length) {
      const empty = document.createElement('div');
      empty.className = 'param-empty';
      empty.textContent = 'Chỉ báo này không có tham số tính toán riêng.';
      this.fields.appendChild(empty);
    }

    const styleTitle = sectionTitle('Hiển thị', 'Áp dụng cho các series của chỉ báo');
    styleTitle.classList.add('param-style-title');
    this.fields.appendChild(styleTitle);
    this.appendSelect('Kiểu hiển thị', INDICATOR_STYLE_KEYS.display, mergedValues, [
      ['line', 'Đường'],
      ['area', 'Vùng (Area)'],
    ]);
    this.appendSelect('Kiểu nét', INDICATOR_STYLE_KEYS.lineStyle, mergedValues, [
      ['solid', 'Liền'],
      ['dashed', 'Gạch'],
      ['dotted', 'Chấm'],
    ]);

    const widthInput = document.createElement('input');
    widthInput.type = 'number';
    widthInput.min = '0.5';
    widthInput.max = '5';
    widthInput.step = '0.5';
    widthInput.value = String(mergedValues[INDICATOR_STYLE_KEYS.lineWidth]);
    widthInput.dataset.styleKey = INDICATOR_STYLE_KEYS.lineWidth;
    this.fields.appendChild(paramRow('Độ dày', widthInput));

    const opacityInput = document.createElement('input');
    opacityInput.type = 'range';
    opacityInput.min = '0';
    opacityInput.max = '100';
    opacityInput.step = '1';
    opacityInput.value = String(mergedValues[INDICATOR_STYLE_KEYS.opacity]);
    opacityInput.dataset.styleKey = INDICATOR_STYLE_KEYS.opacity;
    opacityInput.setAttribute('aria-label', 'Độ hiển thị');
    const opacityValue = document.createElement('output');
    opacityValue.textContent = `${opacityInput.value}%`;
    opacityInput.addEventListener('input', () => {
      opacityValue.textContent = `${opacityInput.value}%`;
    });
    const opacityControl = document.createElement('span');
    opacityControl.className = 'param-opacity-control';
    opacityControl.append(opacityInput, opacityValue);
    this.fields.appendChild(paramRow('Độ hiển thị', opacityControl));

    const colors = document.createElement('div');
    colors.className = 'param-colors';
    [INDICATOR_STYLE_KEYS.color1, INDICATOR_STYLE_KEYS.color2, INDICATOR_STYLE_KEYS.color3]
      .forEach((key, index) => {
        const label = document.createElement('label');
        const name = document.createElement('span');
        name.textContent = `Màu ${index + 1}`;
        const input = document.createElement('input');
        input.type = 'color';
        input.value = String(mergedValues[key]);
        input.dataset.styleKey = key;
        label.append(name, input);
        colors.appendChild(label);
      });
    this.fields.appendChild(colors);
  }

  private createGroupToggle(
    indicatorId: string,
    section: string,
    body: HTMLElement,
    expanded: boolean,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'param-group-toggle';
    button.setAttribute('aria-expanded', String(expanded));

    const arrow = document.createElement('span');
    arrow.className = 'param-group-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = expanded ? '▾' : '▸';
    const label = document.createElement('span');
    label.textContent = section;
    button.append(arrow, label);

    button.addEventListener('click', () => {
      const nextExpanded = body.hidden === true;
      body.hidden = !nextExpanded;
      button.setAttribute('aria-expanded', String(nextExpanded));
      arrow.textContent = nextExpanded ? '▾' : '▸';
      this.sectionState.setExpanded(indicatorId, section, nextExpanded);
    });
    return button;
  }

  private appendSelect(
    label: string,
    key: string,
    values: Params,
    options: Array<[string, string]>,
  ): void {
    const select = document.createElement('select');
    select.dataset.styleKey = key;
    for (const [value, optionLabel] of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = optionLabel;
      select.appendChild(option);
    }
    select.value = String(values[key]);
    this.fields.appendChild(paramRow(label, select));
  }

  private collect(definition: IndicatorDef): Params {
    const params: Params = {};
    for (const input of this.fields.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]')) {
      const param = definition.params?.find((item) => item.key === input.dataset.key);
      if (!param) continue;
      if (param.type === 'boolean' && input instanceof HTMLInputElement) {
        params[param.key] = input.checked;
      } else if (param.type === 'select' || param.type === 'color') {
        params[param.key] = input.value;
      } else {
        let value = Number(input.value);
        if (!Number.isFinite(value)) value = Number(param.default);
        if (param.min !== undefined) value = Math.max(param.min, value);
        if (param.max !== undefined) value = Math.min(param.max, value);
        params[param.key] = param.type === 'int' ? Math.round(value) : value;
      }
    }
    for (const input of this.fields.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-style-key]')) {
      const key = input.dataset.styleKey;
      if (!key) continue;
      params[key] = key === INDICATOR_STYLE_KEYS.lineWidth || key === INDICATOR_STYLE_KEYS.opacity
        ? Number(input.value)
        : input.value;
    }
    return params;
  }
}

function sectionTitle(title: string, description: string): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'param-section-title';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const detail = document.createElement('span');
  detail.textContent = description;
  wrapper.append(strong, detail);
  return wrapper;
}

function paramRow(label: string, control: HTMLElement): HTMLLabelElement {
  const row = document.createElement('label');
  row.className = 'param-row';
  const name = document.createElement('span');
  name.textContent = label;
  row.append(name, control);
  return row;
}

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing indicator settings element: ${selector}`);
  return found;
}
