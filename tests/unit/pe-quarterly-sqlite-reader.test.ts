import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PeInputError,
  readQuarterlyPeFromSqlite,
} from '../../examples/workstation/pe/sqlite-reader';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const supportsNodeSqlite = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5);
const describeNodeSqlite = supportsNodeSqlite ? describe : describe.skip;

describeNodeSqlite('P/E quarterly SQLite reader', () => {
  it('returns the stockdata quarterly contract in chronological order', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'l2-pe-sqlite-'));
    const dbPath = join(directory, 'stockdata.sqlite3');
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE pe_quarterly (
          symbol TEXT NOT NULL,
          period TEXT NOT NULL,
          period_end INTEGER NOT NULL,
          trailing_eps REAL NOT NULL,
          pe_ratio REAL,
          first_observed_at INTEGER NOT NULL,
          source TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          PRIMARY KEY(symbol, period)
        );
        INSERT INTO pe_quarterly VALUES
          ('MBB', '2026-Q2', 200, 3200.5, 6.8, 250, 'vnstock-unified', '2026-08-24T10:00:00+00:00'),
          ('MBB', '2026-Q1', 100, 3100.0, 6.5, 150, 'vnstock-unified', '2026-08-23T10:00:00+00:00'),
          ('FPT', '2026-Q2', 200, 5000.0, 20.0, 250, 'vnstock-unified', '2026-08-24T10:00:00+00:00');
      `);
      db.close();

      const record = await readQuarterlyPeFromSqlite(dbPath, 'mbb');

      expect(record.symbol).toBe('MBB');
      expect(record.source).toBe('vnstock-unified');
      expect(record.fetchedAt).toBe(Math.floor(Date.parse('2026-08-24T10:00:00+00:00') / 1000));
      expect(record.quarters).toEqual([
        { period: '2026-Q1', periodEnd: 100, trailingEps: 3100, peRatio: 6.5, firstObservedAt: 150 },
        { period: '2026-Q2', periodEnd: 200, trailingEps: 3200.5, peRatio: 6.8, firstObservedAt: 250 },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects unsupported symbols before touching the database', async () => {
    await expect(readQuarterlyPeFromSqlite('missing.sqlite3', 'BTCUSDT')).rejects.toBeInstanceOf(PeInputError);
  });
});
