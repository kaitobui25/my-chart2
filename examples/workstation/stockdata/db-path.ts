import { resolve } from 'node:path';

export function resolveStockdataDbPath(
  configuredPath = process.env.STOCKDATA_DB_PATH?.trim() ?? '',
  cwd = process.cwd(),
): string {
  return configuredPath
    ? resolve(cwd, configuredPath)
    : resolve(cwd, '..', 'stockdata', 'data', 'stockdata.sqlite3');
}
