export interface Instrument {
  symbol: string;
  name: string;
  exchange: string;
  aliases?: string[];
}

export const VIETNAM_INSTRUMENTS: Instrument[] = [
  { symbol: 'VNINDEX', name: 'VN-Index', exchange: 'HOSE', aliases: ['VNI', 'VNDINDEX', 'VNDINEX'] },
  { symbol: 'VN30', name: 'VN30 Index', exchange: 'HOSE' },
  { symbol: 'HNX', name: 'HNX Index', exchange: 'HNX', aliases: ['HNXINDEX'] },
  { symbol: 'HNX30', name: 'HNX30 Index', exchange: 'HNX' },
  { symbol: 'UPCOM', name: 'UPCoM Index', exchange: 'UPCOM', aliases: ['UPCOMINDEX'] },
  { symbol: 'VN30F1M', name: 'VN30 Future front month', exchange: 'HNX' },
  { symbol: 'VN30F2M', name: 'VN30 Future next month', exchange: 'HNX' },
  { symbol: 'ACB', name: 'Asia Commercial Bank', exchange: 'HOSE' },
  { symbol: 'BCM', name: 'Becamex IDC', exchange: 'HOSE' },
  { symbol: 'BID', name: 'BIDV', exchange: 'HOSE' },
  { symbol: 'BVH', name: 'Bao Viet Holdings', exchange: 'HOSE' },
  { symbol: 'CTG', name: 'VietinBank', exchange: 'HOSE' },
  { symbol: 'DGC', name: 'Duc Giang Chemicals', exchange: 'HOSE' },
  { symbol: 'DIG', name: 'DIC Corp', exchange: 'HOSE' },
  { symbol: 'DXG', name: 'Dat Xanh Group', exchange: 'HOSE' },
  { symbol: 'FPT', name: 'FPT Corp', exchange: 'HOSE' },
  { symbol: 'GAS', name: 'PetroVietnam Gas', exchange: 'HOSE' },
  { symbol: 'GVR', name: 'Vietnam Rubber Group', exchange: 'HOSE' },
  { symbol: 'HCM', name: 'HSC Securities', exchange: 'HOSE' },
  { symbol: 'HDB', name: 'HDBank', exchange: 'HOSE' },
  { symbol: 'HPG', name: 'Hoa Phat Group', exchange: 'HOSE' },
  { symbol: 'KDH', name: 'Khang Dien House', exchange: 'HOSE' },
  { symbol: 'LPB', name: 'LPBank', exchange: 'HOSE' },
  { symbol: 'MBB', name: 'MB Bank', exchange: 'HOSE' },
  { symbol: 'MSN', name: 'Masan Group', exchange: 'HOSE' },
  { symbol: 'MWG', name: 'Mobile World', exchange: 'HOSE' },
  { symbol: 'PDR', name: 'Phat Dat Real Estate', exchange: 'HOSE' },
  { symbol: 'PLX', name: 'Petrolimex', exchange: 'HOSE' },
  { symbol: 'POW', name: 'PV Power', exchange: 'HOSE' },
  { symbol: 'SAB', name: 'Sabeco', exchange: 'HOSE' },
  { symbol: 'SHB', name: 'SHB Bank', exchange: 'HOSE' },
  { symbol: 'SSI', name: 'SSI Securities', exchange: 'HOSE' },
  { symbol: 'STB', name: 'Sacombank', exchange: 'HOSE' },
  { symbol: 'TCB', name: 'Techcombank', exchange: 'HOSE' },
  { symbol: 'TPB', name: 'TPBank', exchange: 'HOSE' },
  { symbol: 'VCB', name: 'Vietcombank', exchange: 'HOSE' },
  { symbol: 'VCI', name: 'Vietcap Securities', exchange: 'HOSE' },
  { symbol: 'VHM', name: 'Vinhomes', exchange: 'HOSE' },
  { symbol: 'VIC', name: 'Vingroup', exchange: 'HOSE' },
  { symbol: 'VIX', name: 'VIX Securities', exchange: 'HOSE' },
  { symbol: 'VJC', name: 'Vietjet Air', exchange: 'HOSE' },
  { symbol: 'VND', name: 'VNDirect Securities', exchange: 'HOSE' },
  { symbol: 'VNM', name: 'Vinamilk', exchange: 'HOSE' },
  { symbol: 'VPB', name: 'VPBank', exchange: 'HOSE' },
  { symbol: 'VRE', name: 'Vincom Retail', exchange: 'HOSE' },
];

function normalized(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function searchInstruments(query: string, extraSymbols: string[] = [], limit = 8): Instrument[] {
  const catalog = new Map(VIETNAM_INSTRUMENTS.map((instrument) => [instrument.symbol, instrument]));
  for (const raw of extraSymbols) {
    const symbol = normalized(raw);
    if (symbol && !catalog.has(symbol)) catalog.set(symbol, { symbol, name: 'Ma theo doi', exchange: '' });
  }

  const needle = normalized(query);
  return [...catalog.values()]
    .map((instrument) => {
      const symbol = normalized(instrument.symbol);
      const aliases = (instrument.aliases ?? []).map(normalized);
      const name = normalized(instrument.name);
      let rank = needle ? Number.POSITIVE_INFINITY : 10;
      if (symbol === needle || aliases.includes(needle)) rank = 0;
      else if (symbol.startsWith(needle)) rank = 1;
      else if (aliases.some((alias) => alias.startsWith(needle))) rank = 2;
      else if (name.startsWith(needle)) rank = 3;
      else if (symbol.includes(needle) || aliases.some((alias) => alias.includes(needle))) rank = 4;
      else if (name.includes(needle)) rank = 5;
      return { instrument, rank };
    })
    .filter(({ rank }) => Number.isFinite(rank))
    .sort((a, b) => a.rank - b.rank || a.instrument.symbol.localeCompare(b.instrument.symbol))
    .slice(0, limit)
    .map(({ instrument }) => instrument);
}
