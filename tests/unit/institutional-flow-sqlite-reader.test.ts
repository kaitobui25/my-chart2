import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readInstitutionalFlowFromSqlite,
  resolveStockdataDbPath,
  StockFlowInputError,
} from '../../examples/workstation/stock-flow/sqlite-reader';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const supportsNodeSqlite = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5);
const describeNodeSqlite = supportsNodeSqlite ? describe : describe.skip;

describe('Institutional Flow SQLite path', () => {
  it('prefers STOCKDATA_DB_PATH and otherwise uses the sibling stockdata repository', () => {
    const cwd = resolve('workspace', 'LamLongChart');
    expect(resolveStockdataDbPath('custom/flow.sqlite3', cwd)).toBe(resolve(cwd, 'custom/flow.sqlite3'));
    expect(resolveStockdataDbPath('', cwd)).toBe(resolve(cwd, '..', 'stockdata', 'data', 'stockdata.sqlite3'));
  });
});

describeNodeSqlite('Institutional Flow SQLite reader', () => {
  it('matches the stockdata chart-flow contract and preserves missing months as null', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'l2-flow-sqlite-'));
    const dbPath = join(directory, 'stockdata.sqlite3');
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE v_foreign_trades (
          trade_date TEXT NOT NULL,
          symbol TEXT NOT NULL,
          net_value_vnd INTEGER NOT NULL
        );
        CREATE TABLE v_proprietary_trades (
          trade_date TEXT NOT NULL,
          symbol TEXT NOT NULL,
          net_value_vnd INTEGER NOT NULL
        );
        INSERT INTO v_foreign_trades VALUES
          ('2026-01-05', 'HPG', 100),
          ('2026-01-20', 'HPG', -30),
          ('2026-03-02', 'HPG', 45),
          ('2026-01-05', 'FPT', 999);
        INSERT INTO v_proprietary_trades VALUES
          ('2026-02-10', 'HPG', -25),
          ('2026-03-15', 'HPG', 5);
      `);
      db.close();

      await expect(readInstitutionalFlowFromSqlite(dbPath, 'hpg', '2026-01', '2026-03')).resolves.toEqual({
        symbol: 'HPG',
        from: '2026-01',
        to: '2026-03',
        unit: 'VND',
        months: [
          { period: '2026-01', foreign_net_value_vnd: 70, proprietary_net_value_vnd: null },
          { period: '2026-02', foreign_net_value_vnd: null, proprietary_net_value_vnd: -25 },
          { period: '2026-03', foreign_net_value_vnd: 45, proprietary_net_value_vnd: 5 },
        ],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects invalid ranges before touching the database', async () => {
    await expect(
      readInstitutionalFlowFromSqlite('missing.sqlite3', 'HPG', '2026-03', '2026-01'),
    ).rejects.toBeInstanceOf(StockFlowInputError);
  });
});
