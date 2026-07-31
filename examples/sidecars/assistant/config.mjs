import os from 'node:os'
import path from 'node:path'

export const HOST = process.env.L2CHART_ASSISTANT_HOST?.trim() || '127.0.0.1'
export const PORT = Number(process.env.L2CHART_ASSISTANT_PORT || 8788)
export const MAX_BODY_BYTES = Number(process.env.L2CHART_ASSISTANT_MAX_BODY_BYTES || 10 * 1024 * 1024)
export const REQUEST_TIMEOUT_MS = Number(process.env.L2CHART_ASSISTANT_TIMEOUT_MS || 180_000)
export const RUNTIME_ROOT = path.resolve(
  process.env.L2CHART_ASSISTANT_RUNTIME_ROOT || path.join(os.homedir(), '.l2chart-assistant')
)
