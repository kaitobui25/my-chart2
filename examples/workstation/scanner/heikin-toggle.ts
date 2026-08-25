const STORAGE_KEY = 'l2chart.scanner.heikin-enabled.v1';
const SCAN_ENDPOINT = '/scanner-api/scan';

function readStored(): boolean {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === null) return true;
    return value === '1';
  } catch {
    return true;
  }
}

function saveStored(value: boolean): void {
  try { localStorage.setItem(STORAGE_KEY, value ? '1' : '0'); } catch { /* optional */ }
}

function input(id: string): HTMLInputElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement ? element : null;
}

function applyHeikinState(enabled: boolean): void {
  const heikin = input('scanner-heikin-enabled');
  const details = heikin?.closest('details');
  const stack = details?.querySelector<HTMLElement>('.scanner-control-stack');
  if (!heikin || !stack) return;

  heikin.checked = enabled;
  for (const control of stack.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')) {
    if (control === heikin) continue;
    control.disabled = !enabled;
  }
  for (const child of Array.from(stack.children)) {
    if (!(child instanceof HTMLElement) || child.contains(heikin)) continue;
    child.style.opacity = enabled ? '' : '0.45';
  }
}

function install(): boolean {
  if (input('scanner-heikin-enabled')) {
    applyHeikinState(readStored());
    return true;
  }

  const timeframe = document.querySelector<HTMLInputElement>('input[name="scanner-ha-timeframe"]');
  const details = timeframe?.closest('details');
  const stack = details?.querySelector<HTMLElement>('.scanner-control-stack');
  if (!stack) return false;

  const label = document.createElement('label');
  label.className = 'scanner-switch';
  label.innerHTML = '<span><strong>Bật Scanner 03</strong><small>Heikin Ashi · Week / Month</small></span><input id="scanner-heikin-enabled" type="checkbox"><i></i>';
  stack.prepend(label);

  const heikin = input('scanner-heikin-enabled');
  if (!heikin) return false;
  applyHeikinState(readStored());

  heikin.addEventListener('change', () => {
    saveStored(heikin.checked);
    applyHeikinState(heikin.checked);
  });

  const reset = document.getElementById('scanner-reset');
  reset?.addEventListener('click', () => {
    setTimeout(() => {
      saveStored(true);
      applyHeikinState(true);
    }, 0);
  });

  return true;
}

function scannerRequestUrl(value: RequestInfo | URL): string {
  if (typeof value === 'string') return value;
  if (value instanceof URL) return value.toString();
  return value.url;
}

const originalFetch = window.fetch.bind(window);
window.fetch = (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (readStored() || !scannerRequestUrl(request).includes(SCAN_ENDPOINT) || typeof init?.body !== 'string') {
    return originalFetch(request, init);
  }

  try {
    const payload = JSON.parse(init.body) as {
      heikinAshi?: {
        green?: boolean;
        noLowerWick?: boolean;
        closeChangePctMin?: number | null;
      };
    };
    if (!payload.heikinAshi) return originalFetch(request, init);
    payload.heikinAshi = {
      ...payload.heikinAshi,
      green: false,
      noLowerWick: false,
      closeChangePctMin: null,
    };
    return originalFetch(request, { ...init, body: JSON.stringify(payload) });
  } catch {
    return originalFetch(request, init);
  }
};

if (!install()) {
  const observer = new MutationObserver(() => {
    if (!install()) return;
    observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
