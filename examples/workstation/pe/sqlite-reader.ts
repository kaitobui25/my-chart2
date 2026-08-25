import { existsSync } from 'node:fs';

const SYMBOL_RE = /^[A-Z]{3}$/;
const DEFAULT_SOURCE = 'vnstock-unified';

export interface PeQuarterlySqliteRow {
  period: string;
  periodEnd: number;
  trailingEps: number;
  peRatio: number | null;
  firstObservedAt: number;
}

export interface PeQuarterlySqlitePayload {
  symbol: string;
  source: string;
  fetchedAt: number;
  quarters: PeQuarterlySqliteRow[];
}

export class PeInputError extends Error {}
export class PeDatabaseError extends Error {}

function cleanSymbol(symbol: string): string {
  const cleaned = symbol.trim().toUpperCase();
  if (!SYMBOL_RE.test(cleaned)) throw new PeInputError('invalid stock symbol');
  return cleaned;
}

function timestampSeconds(value: string): number {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : 0;
}

export async function readQuarterlyPeFromSqlite(
  dbPath: string,
  symbol: string,
): Promise<PeQuarterlySqlitePayload> {
  const normalizedSymbol = cleanSymbol(symbol);
  if (!existsSync(dbPath)) throw new PeDatabaseError(`stockdata SQLite not found: ${dbPath}`);

  let DatabaseSyncCtor: typeof import('node:sqlite').DatabaseSync;
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = await import('node:sqlite'));
  } catch (error) {
    throw new PeDatabaseError(
      `node:sqlite is unavailable; use Node 22.5+ (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  let db: import('node:sqlite').DatabaseSync | null = null;
  try {
    db = new DatabaseSyncCtor(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=30000;');
    const rows = db.prepare(`
      SELECT
        period,
        period_end,
        trailing_eps,
        pe_ratio,
        first_observed_at,
        source,
        fetched_at
      FROM pe_quarterly
      WHERE symbol = ?
      ORDER BY period_end
    `).all(normalizedSymbol) as Array<{
      period: string;
      period_end: number | bigint;
      trailing_eps: number;
      pe_ratio: number | null;
      first_observed_at: number | bigint;
      source: string;
      fetched_at: string;
    }>;
    const latestRow = rows.length > 0 ? rows[rows.length - 1] : undefined;

    return {
      symbol: normalizedSymbol,
      source: latestRow?.source ?? DEFAULT_SOURCE,
      fetchedAt: rows.reduce((latest, row) => Math.max(latest, timestampSeconds(row.fetched_at)), 0),
      quarters: rows.map((row) => ({
        period: row.period,
        periodEnd: Number(row.period_end),
        trailingEps: Number(row.trailing_eps),
        peRatio: row.pe_ratio === null ? null : Number(row.pe_ratio),
        firstObservedAt: Number(row.first_observed_at),
      })),
    };
  } catch (error) {
    if (error instanceof PeDatabaseError) throw error;
    throw new PeDatabaseError(
      `unable to read pe_quarterly from ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    db?.close();
  }
}
