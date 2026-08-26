import type {
  CafeFEodStatus,
  CafeFEodUpdateResponse,
  ScannerRequest,
  ScannerResult,
  ScannerRun,
  ScannerSource,
} from './types';
import { EOD_UPDATE_CONFIG } from './eod-config';

const BASE = '/scanner-api';
type ScannerResultMode = ScannerResult['mode'];
const expectedModeByRun = new Map<number, ScannerResultMode>();

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload as T;
}

function normalizeScannerResult(row: ScannerResult): ScannerResult {
  const legacy = row as unknown as Record<string, unknown>;
  if (legacy.mode === 'heikin_ashi' || legacy.mode === 'breakout_volume') return row;
  if ('rvol' in legacy && 'breakoutLevel' in legacy) {
    return { ...legacy, mode: 'breakout_volume' } as unknown as ScannerResult;
  }
  return { ...legacy, mode: 'heikin_ashi' } as unknown as ScannerResult;
}

function normalizeScannerRun(run: ScannerRun): ScannerRun {
  return {
    ...run,
    results: (run.results ?? []).map(normalizeScannerResult),
  };
}

function heikinScannerEnabled(): boolean {
  if (typeof document === 'undefined') return true;
  const element = document.getElementById('scanner-heikin-enabled');
  return !(element instanceof HTMLInputElement) || element.checked;
}

function assertExpectedMode(runId: number, run: ScannerRun): void {
  const expected = expectedModeByRun.get(runId);
  if (!expected || run.status !== 'complete' || !run.results.length) return;
  const mismatch = run.results.some((row) => row.mode !== expected);
  expectedModeByRun.delete(runId);
  if (!mismatch) return;
  throw new Error(
    expected === 'breakout_volume'
      ? 'Scanner sidecar đang chạy code cũ và trả kết quả Heikin thay vì Scanner 04. Restart workstation/sidecar rồi quét lại.'
      : 'Scanner sidecar trả sai loại kết quả. Restart workstation/sidecar rồi quét lại.',
  );
}

export async function getScannerSources(): Promise<ScannerSource[]> {
  const response = await fetch(`${BASE}/sources`, { signal: AbortSignal.timeout(5000) });
  const payload = await readJson<{ sources: ScannerSource[] }>(response);
  return payload.sources ?? [];
}

export async function getCafeFEodStatus(): Promise<CafeFEodStatus> {
  const response = await fetch(`${BASE}/eod/status`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  return readJson<CafeFEodStatus>(response);
}

export async function updateCafeFEod(): Promise<CafeFEodUpdateResponse> {
  const response = await fetch(`${BASE}/eod/import-latest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(EOD_UPDATE_CONFIG.timeoutMs),
  });
  return readJson<CafeFEodUpdateResponse>(response);
}

export async function startScannerRun(request: ScannerRequest): Promise<number> {
  if (!request.breakoutVolume?.enabled && !heikinScannerEnabled()) {
    throw new Error('Bật Scanner 03 hoặc Scanner 04 trước khi quét.');
  }
  const response = await fetch(`${BASE}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10000),
  });
  const payload = await readJson<{ runId: number }>(response);
  expectedModeByRun.set(
    payload.runId,
    request.breakoutVolume?.enabled ? 'breakout_volume' : 'heikin_ashi',
  );
  return payload.runId;
}

export async function getScannerRun(runId: number): Promise<ScannerRun> {
  const response = await fetch(`${BASE}/runs/${runId}`, { signal: AbortSignal.timeout(5000) });
  const raw = await readJson<ScannerRun>(response);
  const run = normalizeScannerRun(raw);
  if (run.status === 'error') expectedModeByRun.delete(runId);
  assertExpectedMode(runId, run);
  return run;
}

export async function waitForScannerRun(
  runId: number,
  onProgress: (run: ScannerRun) => void,
  timeoutMs = 180_000,
): Promise<ScannerRun> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = await getScannerRun(runId);
    window.dispatchEvent(new CustomEvent<ScannerRun>('l2chart:scanner-run-progress', { detail: run }));
    onProgress(run);
    if (run.status === 'complete' || run.status === 'error') return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  expectedModeByRun.delete(runId);
  throw new Error('Scanner timed out before the run completed.');
}
