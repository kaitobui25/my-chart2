import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LnttInputError,
  readQuarterlyLnttFromSqlite,
} from '../../examples/workstation/lntt/sqlite-reader';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const supportsNodeSqlite = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5);
const describeNodeSqlite = supportsNodeSqlite ? describe : describe.skip;

describeNodeSqlite('LNTT quarterly SQLite reader', () => {
  it('returns only non-null quarterly financial results in chronological order', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'l2-lntt-sqlite-'));
    const dbPath = join(directory, 'stockdata.sqlite3');
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE financial_results (
          symbol TEXT NOT NULL,
          period TEXT NOT NULL,
          period_type TEXT NOT NULL,
          year INTEGER NOT NULL,
          quarter INTEGER,
          period_end TEXT NOT NULL,
          profit_before_tax_vnd INTEGER,
          source TEXT NOT NULL,
          source_url TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          PRIMARY KEY(symbol, period)
        );
        INSERT INTO financial_results VALUES
          ('MBB', '2026Q2', 'quarter', 2026, 2, '2026-06-30', 130000000000, 'cafef', 'https://example.test', '2026-08-24T10:00:00+00:00'),
          ('MBB', '2025Q2', 'quarter', 2025, 2, '2025-06-30', 100000000000, 'cafef', 'https://example.test', '2026-08-23T10:00:00+00:00'),
          ('MBB', '2026Q1', 'quarter', 2026, 1, '2026-03-31', NULL, 'cafef', 'https://example.test', '2026-08-24T09:00:00+00:00'),
          ('MBB', '2025Y', 'year', 2025, NULL, '2025-12-31', 200000000000, 'cafef', 'https://example.test', '2026-08-24T10:00:00+00:00'),
          ('FPT', '2026Q2', 'quarter', 2026, 2, '2026-06-30', 50000000000, 'cafef', 'https://example.test', '2026-08-24T10:00:00+00:00');
      `);
      db.close();

      const record = await readQuarterlyLnttFromSqlite(dbPath, 'mbb');

      expect(record.symbol).toBe('MBB');
      expect(record.source).toBe('cafef');
      expect(record.fetchedAt).toBe(Math.floor(Date.parse('2026-08-24T10:00:00+00:00') / 1000));
      expect(record.quarters).toEqual([
        { period: '2025Q2', year: 2025, quarter: 2, profitBeforeTaxVnd: 100000000000 },
        { period: '2026Q2', year: 2026, quarter: 2, profitBeforeTaxVnd: 130000000000 },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects unsupported symbols before touching the database', async () => {
    await expect(readQuarterlyLnttFromSqlite('missing.sqlite3', 'BTCUSDT')).rejects.toBeInstanceOf(LnttInputError);
  });
});
