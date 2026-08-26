import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DividendInputError,
  readDividendEventsFromSqlite,
} from '../../examples/workstation/dividend/sqlite-reader';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const supportsNodeSqlite = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5);
const describeNodeSqlite = supportsNodeSqlite ? describe : describe.skip;

describeNodeSqlite('dividend SQLite reader', () => {
  it('merges Simplize rows on the same ex-date and ignores CafeF rows', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'l2-dividend-sqlite-'));
    const dbPath = join(directory, 'stockdata.sqlite3');
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE dividend_events (
          symbol TEXT NOT NULL,
          ex_date TEXT NOT NULL,
          source TEXT NOT NULL,
          cash_vnd_per_share INTEGER,
          cash_percent REAL,
          stock_percent REAL,
          bonus_percent REAL
        );
        INSERT INTO dividend_events VALUES
          ('GAS', '2025-08-28', 'simplize', 2100, NULL, NULL, NULL),
          ('GAS', '2025-08-28', 'simplize', NULL, NULL, NULL, 3.0),
          ('GAS', '2024-09-13', 'simplize', 6000, NULL, NULL, 2.0),
          ('GAS', '2025-08-28', 'cafef', 9999, 99, 99, 99),
          ('HPG', '2025-06-26', 'simplize', NULL, NULL, 20, NULL);
      `);
      db.close();

      await expect(readDividendEventsFromSqlite(dbPath, 'gas')).resolves.toEqual({
        symbol: 'GAS',
        source: 'simplize',
        events: [
          {
            exDate: '2024-09-13',
            cashVndPerShare: 6000,
            cashPercent: null,
            stockPercent: null,
            bonusPercent: 2,
          },
          {
            exDate: '2025-08-28',
            cashVndPerShare: 2100,
            cashPercent: null,
            stockPercent: null,
            bonusPercent: 3,
          },
        ],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects unsupported symbols before touching the database', async () => {
    await expect(readDividendEventsFromSqlite('missing.sqlite3', 'BTCUSDT')).rejects.toBeInstanceOf(DividendInputError);
  });
});
