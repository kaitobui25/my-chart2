import { existsSync } from 'node:fs';
import { resolveStockdataDbPath } from '../stockdata/db-path';

const SYMBOL_RE = /^[A-Z0-9]{1,10}$/;
const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MAX_CHART_FLOW_MONTHS = 600;

export { resolveStockdataDbPath };

export interface InstitutionalFlowSqliteMonth {
  period: string;
  foreign_net_value_vnd: number | null;
  proprietary_net_value_vnd: number | null;
}

export interface InstitutionalFlowSqlitePayload {
  symbol: string;
  from: string;
  to: string;
  unit: 'VND';
  months: InstitutionalFlowSqliteMonth[];
}

export class StockFlowInputError extends Error {}
export class StockFlowDatabaseError extends Error {}

function cleanSymbol(symbol: string): string {
  const cleaned = symbol.trim().toUpperCase();
  if (!SYMBOL_RE.test(cleaned)) throw new StockFlowInputError('invalid stock symbol');
  return cleaned;
}

function periodParts(period: string): [year: number, month: number] {
  const match = PERIOD_RE.exec(period);
  if (!match) throw new StockFlowInputError('period must use YYYY-MM');
  return [Number(match[1]), Number(match[2])];
}

function cleanPeriod(period: string): string {
  const cleaned = period.trim();
  periodParts(cleaned);
  return cleaned;
}

function periodRange(fromPeriod: string, toPeriod: string): string[] {
  const [startYear, startMonth] = periodParts(fromPeriod);
  const [endYear, endMonth] = periodParts(toPeriod);
  const startIndex = startYear * 12 + startMonth - 1;
  const endIndex = endYear * 12 + endMonth - 1;
  if (endIndex < startIndex) throw new StockFlowInputError('to must not be earlier than from');
  const count = endIndex - startIndex + 1;
  if (count > MAX_CHART_FLOW_MONTHS) {
    throw new StockFlowInputError(`chart flow range must be <= ${MAX_CHART_FLOW_MONTHS} months`);
  }
  return Array.from({ length: count }, (_, offset) => {
    const index = startIndex + offset;
    return `${Math.floor(index / 12).toString().padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`;
  });
}

function nextMonthStart(period: string): string {
  const [year, month] = periodParts(period);
  const index = year * 12 + month;
  return `${Math.floor(index / 12).toString().padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}-01`;
}

type DatabaseSync = import('node:sqlite').DatabaseSync;
type FlowView = 'v_foreign_trades' | 'v_proprietary_trades';

function netValuesByPeriod(
  db: DatabaseSync,
  view: FlowView,
  symbol: string,
  start: string,
  end: string,
): Map<string, number> {
  const rows = db.prepare(`
    SELECT
      substr(trade_date, 1, 7) AS period,
      SUM(net_value_vnd) AS net_value_vnd
    FROM ${view}
    WHERE symbol = ? AND trade_date >= ? AND trade_date < ?
    GROUP BY substr(trade_date, 1, 7)
    ORDER BY period
  `).all(symbol, start, end) as Array<{ period: string; net_value_vnd: number | bigint | null }>;

  return new Map(rows.map((row) => [row.period, Number(row.net_value_vnd ?? 0)]));
}

export async function readInstitutionalFlowFromSqlite(
  dbPath: string,
  symbol: string,
  fromPeriod: string,
  toPeriod: string,
): Promise<InstitutionalFlowSqlitePayload> {
  const normalizedSymbol = cleanSymbol(symbol);
  const normalizedFrom = cleanPeriod(fromPeriod);
  const normalizedTo = cleanPeriod(toPeriod);
  const periods = periodRange(normalizedFrom, normalizedTo);

  if (!existsSync(dbPath)) {
    throw new StockFlowDatabaseError(`stockdata SQLite not found: ${dbPath}`);
  }

  let DatabaseSyncCtor: typeof import('node:sqlite').DatabaseSync;
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = await import('node:sqlite'));
  } catch (error) {
    throw new StockFlowDatabaseError(
      `node:sqlite is unavailable; use Node 22.5+ (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSyncCtor(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=30000;');

    const start = `${normalizedFrom}-01`;
    const end = nextMonthStart(normalizedTo);
    const foreign = netValuesByPeriod(db, 'v_foreign_trades', normalizedSymbol, start, end);
    const proprietary = netValuesByPeriod(db, 'v_proprietary_trades', normalizedSymbol, start, end);

    return {
      symbol: normalizedSymbol,
      from: normalizedFrom,
      to: normalizedTo,
      unit: 'VND',
      months: periods.map((period) => ({
        period,
        foreign_net_value_vnd: foreign.get(period) ?? null,
        proprietary_net_value_vnd: proprietary.get(period) ?? null,
      })),
    };
  } catch (error) {
    if (error instanceof StockFlowDatabaseError) throw error;
    throw new StockFlowDatabaseError(
      `unable to read stockdata SQLite at ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    db?.close();
  }
}
