import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { withCodexAppServer } from './codex-app-server-client.mjs'
import { commandExists, spawnCommand } from './command-utils.mjs'
import { parseResponse, responseSchemaFor } from './response-schema.mjs'

const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])

function normalizeModel(value) {
  if (value == null || value === '') return null
  const text = String(value).trim()
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(text) ? text : null
}

function normalizeEffort(value) {
  const effort = String(value ?? '').toLowerCase()
  return REASONING_EFFORTS.has(effort) ? effort : 'medium'
}

function finiteOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizeRateLimitBucket(value, slot) {
  if (value == null || typeof value !== 'object') return null
  const usedPercent = finiteOrNull(value.usedPercent ?? value.used_percent)
  const windowDurationMins = finiteOrNull(value.windowDurationMins ?? value.window_duration_mins)
  const resetsAt = finiteOrNull(value.resetsAt ?? value.resets_at)
  return {
    slot,
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    windowDurationMins,
    resetsAt,
    limitId: value.limitId ?? value.limit_id ?? null
  }
}

export function normalizeAccountStatus({ accountResponse, rateLimitsResponse, model, reasoningEffort }) {
  const account = accountResponse?.account ?? null
  const rateRoot = rateLimitsResponse?.rateLimits ?? rateLimitsResponse?.rate_limits ?? rateLimitsResponse ?? {}
  const resetRoot = rateLimitsResponse?.rateLimitResetCredits ?? rateLimitsResponse?.rate_limit_reset_credits ?? null

  return {
    account: account === null ? null : {
      type: account.type ?? null,
      email: account.email ?? null,
      planType: account.planType ?? account.plan_type ?? null
    },
    requiresOpenaiAuth: accountResponse?.requiresOpenaiAuth ?? accountResponse?.requires_openai_auth ?? null,
    selected: {
      model: normalizeModel(model),
      reasoningEffort: normalizeEffort(reasoningEffort)
    },
    rateLimits: {
      primary: normalizeRateLimitBucket(rateRoot.primary, 'primary'),
      secondary: normalizeRateLimitBucket(rateRoot.secondary, 'secondary'),
      reachedType: rateRoot.rateLimitReachedType ?? rateRoot.rate_limit_reached_type ?? null,
      individualLimit: rateRoot.individualLimit ?? rateRoot.individual_limit ?? null,
      spendControlReached: rateRoot.spendControlReached ?? rateRoot.spend_control_reached ?? null
    },
    resetCredits: resetRoot === null ? null : {
      availableCount: finiteOrNull(resetRoot.availableCount ?? resetRoot.available_count) ?? 0,
      credits: Array.isArray(resetRoot.credits) ? resetRoot.credits : null
    }
  }
}

export function codexAvailable() {
  return commandExists('codex')
}

function unavailableError() {
  const error = new Error('Codex CLI was not found. Install Codex CLI and sign in with ChatGPT.')
  error.code = 'CODEX_UNAVAILABLE'
  return error
}

function terminate(child) {
  if (!child || child.killed) return
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    return
  }
  child.kill('SIGTERM')
}

export async function getCodexStatus({ runtimeRoot, model, reasoningEffort }) {
  if (!codexAvailable()) throw unavailableError()
  await mkdir(runtimeRoot, { recursive: true })
  return await withCodexAppServer({ cwd: runtimeRoot }, async client => {
    const accountResponse = await client.request('account/read', { refreshToken: false })
    const rateLimitsResponse = await client.request('account/rateLimits/read')
    return normalizeAccountStatus({ accountResponse, rateLimitsResponse, model, reasoningEffort })
  })
}

export async function runCodex({ runtimeRoot, mode, model, reasoningEffort, prompt, screenshotDataUrl, onStart }) {
  if (!codexAvailable()) throw unavailableError()

  await mkdir(runtimeRoot, { recursive: true })
  const requestDir = await mkdtemp(path.join(os.tmpdir(), 'l2chart-codex-'))
  const schemaPath = path.join(requestDir, 'response-schema.json')
  const outputPath = path.join(requestDir, 'response.json')
  const imagePath = path.join(requestDir, 'chart.png')
  await writeFile(schemaPath, JSON.stringify(responseSchemaFor(mode)), 'utf8')

  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--color', 'never',
    '-C', runtimeRoot,
    '--output-schema', schemaPath,
    '--output-last-message', outputPath
  ]
  const selectedModel = normalizeModel(model)
  if (selectedModel) args.push('--model', selectedModel)
  args.push('--config', `model_reasoning_effort="${normalizeEffort(reasoningEffort)}"`)

  if (typeof screenshotDataUrl === 'string' && screenshotDataUrl.startsWith('data:image/png;base64,')) {
    const base64 = screenshotDataUrl.slice('data:image/png;base64,'.length)
    await writeFile(imagePath, Buffer.from(base64, 'base64'))
    args.push('--image', imagePath)
  }
  args.push('-')

  let child
  try {
    await new Promise((resolve, reject) => {
      child = spawnCommand('codex', args, {
        cwd: runtimeRoot,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe']
      })
      onStart?.({ child, cancel: () => terminate(child) })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', reject)
      child.on('exit', code => {
        if (code === 0) resolve()
        else {
          const error = new Error(stderr.trim() || `Codex exited with code ${code}.`)
          error.code = 'CODEX_FAILED'
          reject(error)
        }
      })
      child.stdin.end(prompt)
    })
    return parseResponse(await readFile(outputPath, 'utf8'), mode)
  } finally {
    await rm(requestDir, { recursive: true, force: true })
  }
}
