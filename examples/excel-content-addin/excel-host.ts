import type { ExcelRangeSnapshot } from './ohlc-range';

interface OfficeReadyInfo {
  host?: string;
}

interface OfficeRuntime {
  onReady(callback: (info: OfficeReadyInfo) => void): void;
}

interface ExcelContext {
  workbook: {
    getSelectedRange(): ExcelRange;
  };
  sync(): Promise<void>;
}

interface ExcelRange {
  values: unknown[][];
  text: string[][];
  load(properties: string): void;
}

interface ExcelRuntime {
  run<T>(callback: (context: ExcelContext) => Promise<T>): Promise<T>;
}

declare const Office: OfficeRuntime;
declare const Excel: ExcelRuntime;

const EXCEL_HOST_NAME = 'Excel';

export async function waitForOfficeReady(): Promise<OfficeReadyInfo | null> {
  if (typeof Office === 'undefined') return null;
  return new Promise((resolve) => Office.onReady(resolve));
}

export function isExcelHost(info: OfficeReadyInfo | null): boolean {
  return info?.host === EXCEL_HOST_NAME && typeof Excel !== 'undefined';
}

export async function readSelectedRange(): Promise<ExcelRangeSnapshot> {
  if (typeof Excel === 'undefined') {
    throw new Error('Excel runtime chưa sẵn sàng.');
  }

  return Excel.run(async (context) => {
    const range = context.workbook.getSelectedRange();
    range.load('values,text');
    await context.sync();
    return { values: range.values, text: range.text };
  });
}
