import { existsSync } from 'node:fs';

const SYMBOL_RE = /^[A-Z]{3}$/;

export interface DividendSqliteEvent {
  exDate: string;
  cashVndPerShare: number | null;
  cashPercent: number | null;
  stockPercent: number | null;
  bonusPercent: number | null;
}

export interface DividendSqlitePayload {
  symbol: string;
  source: 'simplize';
  events: DividendSqliteEvent[];
}

export class DividendInputError extends Error {}
export class DividendDatabaseError extends Error {}

function cleanSymbol(symbol: string): string {
  const cleaned = symbol.trim().toUpperCase();
  if (!SYMBOL_RE.test(cleaned)) throw new DividendInputError('invalid stock symbol');
  return cleaned;
}

function nullableNumber(value: number | bigint | null): number | null {
  return value === null ? null : Number(value);
}

export async function readDividendEventsFromSqlite(
  dbPath: string,
  symbol: string,
): Promise<DividendSqlitePayload> {
  const normalizedSymbol = cleanSymbol(symbol);
  if (!existsSync(dbPath)) {
    throw new DividendDatabaseError(`stockdata SQLite not found: ${dbPath}`);
  }

  let DatabaseSyncCtor: typeof import('node:sqlite').DatabaseSync;
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = await import('node:sqlite'));
  } catch (error) {
    throw new DividendDatabaseError(
      `node:sqlite is unavailable; use Node 22.5+ (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  let db: import('node:sqlite').DatabaseSync | null = null;
  try {
    db = new DatabaseSyncCtor(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=30000;');
    const rows = db.prepare(`
      SELECT
        ex_date,
        MAX(cash_vnd_per_share) AS cash_vnd_per_share,
        MAX(cash_percent) AS cash_percent,
        MAX(stock_percent) AS stock_percent,
        MAX(bonus_percent) AS bonus_percent
      FROM dividend_events
      WHERE symbol = ? AND source = 'simplize'
      GROUP BY ex_date
      ORDER BY ex_date
    `).all(normalizedSymbol) as Array<{
      ex_date: string;
      cash_vnd_per_share: number | bigint | null;
      cash_percent: number | bigint | null;
      stock_percent: number | bigint | null;
      bonus_percent: number | bigint | null;
    }>;

    return {
      symbol: normalizedSymbol,
      source: 'simplize',
      events: rows.map((row) => ({
        exDate: row.ex_date,
        cashVndPerShare: nullableNumber(row.cash_vnd_per_share),
        cashPercent: nullableNumber(row.cash_percent),
        stockPercent: nullableNumber(row.stock_percent),
        bonusPercent: nullableNumber(row.bonus_percent),
      })),
    };
  } catch (error) {
    if (error instanceof DividendDatabaseError) throw error;
    throw new DividendDatabaseError(
      `unable to read dividend_events from ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    db?.close();
  }
}
