export interface JpxSector {
  name: string; sector33Code: string; sector33Name: string;
  sector17Code: string; sector17Name: string;
}
interface Catalog { asOf: string; sourceUrl: string; records: Record<string, JpxSector> }

/** One request shared by all tiles; never participates in the candle load queue. */
export class JpxSectorMetadata {
  private catalog: Catalog | null = null;
  private request: Promise<Catalog> | null = null;
  private expires = 0;
  private retryAfter = 0;
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  async get(symbol: string): Promise<{ text: string; title: string } | null> {
    if (!/^(?:\d{4}|\d{3}[A-Z]|\d[A-Z]\d{2})\.T$/.test(symbol)) return null;
    if (Date.now() >= this.expires && Date.now() >= this.retryAfter) {
      if (!this.request) {
        this.request = this.fetchImpl('/yfinance-jp-api/jpx/sectors', { signal: AbortSignal.timeout(25_000) })
          .then(async response => {
            if (!response.ok) throw new Error('JPX metadata unavailable');
            const catalog = await response.json() as Catalog;
            if (!catalog.asOf || !catalog.sourceUrl || !catalog.records || typeof catalog.records !== 'object') {
              throw new Error('Invalid JPX catalog');
            }
            this.catalog = catalog; this.expires = Date.now() + 86400_000;
            return catalog;
          }).finally(() => { this.request = null; });
      }
      try { await this.request; } catch { this.retryAfter = Date.now() + 60_000; }
    }
    const record = this.catalog?.records[symbol];
    if (!record || !/^\d{4}$/.test(record.sector33Code) || !/^\d{2}$/.test(record.sector17Code)) return null;
    return {
      text: `33: ${record.sector33Code} · 17: ${record.sector17Code}`,
      title: `${record.name}\n33 ngành: ${record.sector33Name}\nTOPIX-17: ${record.sector17Name}\nJPX · ${this.catalog!.asOf}\n${this.catalog!.sourceUrl}\nPhân loại theo snapshot hiện có, không theo ngày Replay.`,
    };
  }
}
export const jpxSectorMetadata = new JpxSectorMetadata();
