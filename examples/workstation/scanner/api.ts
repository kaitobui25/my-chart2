import type { ScannerRequest, ScannerRun, ScannerSource } from './types';

const BASE = '/scanner-api';

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload as T;
}

export async function getScannerSources(): Promise<ScannerSource[]> {
  const response = await fetch(`${BASE}/sources`, { signal: AbortSignal.timeout(5000) });
  const payload = await readJson<{ sources: ScannerSource[] }>(response);
  return payload.sources ?? [];
}

export async function startScannerRun(request: ScannerRequest): Promise<number> {
  const response = await fetch(`${BASE}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10000),
  });
  const payload = await readJson<{ runId: number }>(response);
  return payload.runId;
}

export async function getScannerRun(runId: number): Promise<ScannerRun> {
  const response = await fetch(`${BASE}/runs/${runId}`, { signal: AbortSignal.timeout(5000) });
  return readJson<ScannerRun>(response);
}

export async function waitForScannerRun(
  runId: number,
  onProgress: (run: ScannerRun) => void,
  timeoutMs = 180_000,
): Promise<ScannerRun> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = await getScannerRun(runId);
    onProgress(run);
    if (run.status === 'complete' || run.status === 'error') return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Scanner timed out before the run completed.');
}
