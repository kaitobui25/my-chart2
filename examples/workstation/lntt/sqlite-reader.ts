import { existsSync } from 'node:fs';

const SYMBOL_RE = /^[A-Z]{3}$/;
const DEFAULT_SOURCE = 'stockdata';

export interface LnttQuarterlySqliteRow {
  period: string;
  year: number;
  quarter: number;
  profitBeforeTaxVnd: number;
}

export interface LnttQuarterlySqlitePayload {
  symbol: string;
  source: string;
  fetchedAt: number;
  quarters: LnttQuarterlySqliteRow[];
}

export class LnttInputError extends Error {}
export class LnttDatabaseError extends Error {}

function cleanSymbol(symbol: string): string {
  const cleaned = symbol.trim().toUpperCase();
  if (!SYMBOL_RE.test(cleaned)) throw new LnttInputError('invalid stock symbol');
  return cleaned;
}

function timestampSeconds(value: string): number {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : 0;
}

export async function readQuarterlyLnttFromSqlite(
  dbPath: string,
  symbol: string,
): Promise<LnttQuarterlySqlitePayload> {
  const normalizedSymbol = cleanSymbol(symbol);
  if (!existsSync(dbPath)) throw new LnttDatabaseError(`stockdata SQLite not found: ${dbPath}`);

  let DatabaseSyncCtor: typeof import('node:sqlite').DatabaseSync;
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = await import('node:sqlite'));
  } catch (error) {
    throw new LnttDatabaseError(
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
        year,
        quarter,
        profit_before_tax_vnd,
        source,
        fetched_at
      FROM financial_results
      WHERE symbol = ?
        AND period_type = 'quarter'
        AND profit_before_tax_vnd IS NOT NULL
      ORDER BY year, quarter
    `).all(normalizedSymbol) as Array<{
      period: string;
      year: number | bigint;
      quarter: number | bigint;
      profit_before_tax_vnd: number | bigint;
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
        year: Number(row.year),
        quarter: Number(row.quarter),
        profitBeforeTaxVnd: Number(row.profit_before_tax_vnd),
      })),
    };
  } catch (error) {
    if (error instanceof LnttDatabaseError) throw error;
    throw new LnttDatabaseError(
      `unable to read financial_results from ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    db?.close();
  }
}
