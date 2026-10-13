export type Currency = 'VND' | 'USD' | 'JPY';
export type AssetClass = 'legacy' | 'stock' | 'crypto' | 'forex' | 'futures';

export interface InstrumentSpec {
  symbol: string;
  assetClass: AssetClass;
  currency: Currency;
  accountCurrency: 'VND' | 'USD';
  unit: string;
  minQuantity: number;
  quantityStep: number;
  tickSize: number;
  multiplier: number;
  marginRate: number;
  /** Zero until actual fee assumptions are configured. */
  commissionBps: number;
}

const LEGACY: Omit<InstrumentSpec, 'symbol'> = {
  assetClass: 'legacy', currency: 'VND', accountCurrency: 'VND', unit: 'cp',
  minQuantity: 1, quantityStep: 1, tickSize: 0.01,
  multiplier: 1000, marginRate: 0.2, commissionBps: 0,
};

const JAPAN_STOCK: Omit<InstrumentSpec, 'symbol'> = {
  assetClass: 'stock', currency: 'JPY', accountCurrency: 'USD', unit: 'cp',
  minQuantity: 100, quantityStep: 100, tickSize: 1,
  multiplier: 1, marginRate: 1, commissionBps: 0,
};

const INSTRUMENTS: Record<string, Omit<InstrumentSpec, 'symbol'>> = {
  // Toyota commonly quotes in ¥0.5 increments around its current price band.
  '7203.T': { ...JAPAN_STOCK, tickSize: 0.5 },
  'BTC-USD': {
    assetClass: 'crypto', currency: 'USD', accountCurrency: 'USD', unit: 'BTC',
    minQuantity: 0.001, quantityStep: 0.001, tickSize: 0.01,
    multiplier: 1, marginRate: 1, commissionBps: 0,
  },
  'JPY=X': {
    assetClass: 'forex', currency: 'JPY', accountCurrency: 'USD', unit: 'lot',
    minQuantity: 0.01, quantityStep: 0.01, tickSize: 0.001,
    multiplier: 100_000, marginRate: 0.05, commissionBps: 0,
  },
  'GC=F': {
    assetClass: 'futures', currency: 'USD', accountCurrency: 'USD', unit: 'contract',
    minQuantity: 1, quantityStep: 1, tickSize: 0.1,
    multiplier: 100, marginRate: 0.1, commissionBps: 0,
  },
};

const SYMBOL_ALIASES: Record<string, string> = {
  BTC: 'BTC-USD', BTCUSD: 'BTC-USD', 'BTC/USD': 'BTC-USD',
  USDJPY: 'JPY=X', USDYEN: 'JPY=X', 'USD/JPY': 'JPY=X',
  XAUUSD: 'GC=F', 'XAU/USD': 'GC=F', GOLD: 'GC=F',
};

const TOKYO_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Tokyo', weekday: 'short', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23',
});

export function instrumentFor(symbol: string): InstrumentSpec {
  const normalized = symbol.trim().toUpperCase();
  const lookup = SYMBOL_ALIASES[normalized] ?? normalized;
  const japanese = /^(?:\d{4}|\d{4}\.T)$/.test(normalized);
  return { symbol: normalized, ...(INSTRUMENTS[lookup] ?? (japanese || normalized.endsWith('.T') ? JAPAN_STOCK : LEGACY)) };
}

export function validIncrement(value: number, minimum: number, step: number): boolean {
  if (!Number.isFinite(value) || value < minimum) return false;
  const units = value / step;
  return Math.abs(units - Math.round(units)) < 1e-7;
}

export function validPrice(value: number | undefined, spec: InstrumentSpec): boolean {
  return value !== undefined && validIncrement(value, spec.tickSize, spec.tickSize);
}

export function roundToTick(price: number, spec: InstrumentSpec): number {
  if (!Number.isFinite(price)) return price;
  const precision = String(spec.tickSize).split('.')[1]?.length ?? 0;
  return Number((Math.round(price / spec.tickSize) * spec.tickSize).toFixed(precision));
}

export function quantityDecimals(spec: InstrumentSpec): number {
  const parts = String(spec.quantityStep).split('.');
  return parts[1]?.length ?? 0;
}

/** Basic trading sessions only; not an exchange holiday/early-close calendar. */
export function marketSessionOpen(spec: InstrumentSpec, timestampMs: number): boolean {
  if (spec.assetClass === 'crypto' || spec.assetClass === 'legacy') return true;
  const date = new Date(timestampMs);
  if (spec.assetClass === 'stock') {
    const parts = TOKYO_CLOCK.formatToParts(date);
    const get = (key: string) => parts.find((item) => item.type === key)?.value ?? '';
    if (get('weekday') === 'Sat' || get('weekday') === 'Sun') return false;
    const minute = Number(get('hour')) * 60 + Number(get('minute'));
    return (minute >= 540 && minute < 690) || (minute >= 750 && minute < 930);
  }
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  // Approximate 24/5 schedule; futures exchange maintenance breaks are not modeled.
  return day !== 6 && !(day === 0 && hour < 22) && !(day === 5 && hour >= 22);
}
