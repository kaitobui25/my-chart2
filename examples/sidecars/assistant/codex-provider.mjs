import { mkdir } from 'node:fs/promises'
import { withCodexAppServer } from './codex-app-server-client.mjs'
import { commandExists } from './command-utils.mjs'
import { CodexSessionStore, CODEX_SESSION_ID } from './codex-session-store.mjs'
import { runCodexExec } from './codex-exec-runner.mjs'

export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh']
const REASONING_EFFORT_SET = new Set(CODEX_REASONING_EFFORTS)
const MODEL_CACHE_MS = 5 * 60 * 1000
let modelCache = null
let modelCacheAt = 0

function normalizeModel(value) {
  if (value == null || value === '') return null
  const text = String(value).trim()
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(text) ? text : null
}

function normalizeEffort(value) {
  const effort = String(value ?? '').toLowerCase()
  return REASONING_EFFORT_SET.has(effort) ? effort : 'medium'
}

function reasoningValue(value) {
  if (typeof value === 'string') return value
  return value?.reasoningEffort ?? value?.reasoning_effort ?? value?.effort ?? value?.value ?? value?.id ?? null
}

export function normalizeModelList(response) {
  const rows = Array.isArray(response?.data)
    ? response.data
    : Array.isArray(response?.models)
      ? response.models
      : []

  return rows.map(item => {
    const id = normalizeModel(item?.id ?? item?.model ?? item?.slug)
    if (id === null) return null
    const efforts = (item?.supportedReasoningEfforts ?? item?.supported_reasoning_efforts ?? [])
      .map(reasoningValue)
      .map(value => String(value ?? '').toLowerCase())
      .filter(value => REASONING_EFFORT_SET.has(value))
    return {
      id,
      label: String(item?.displayName ?? item?.display_name ?? item?.name ?? id),
      defaultReasoningEffort: normalizeEffort(item?.defaultReasoningEffort ?? item?.default_reasoning_effort),
      supportedReasoningEfforts: efforts.length > 0 ? [...new Set(efforts)] : [...CODEX_REASONING_EFFORTS]
    }
  }).filter(Boolean)
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

export async function getCodexOptions({ runtimeRoot }) {
  if (!codexAvailable()) throw unavailableError()
  const now = Date.now()
  if (modelCache !== null && now - modelCacheAt < MODEL_CACHE_MS) {
    return { models: modelCache, reasoningEfforts: [...CODEX_REASONING_EFFORTS] }
  }

  await mkdir(runtimeRoot, { recursive: true })
  const models = await withCodexAppServer({ cwd: runtimeRoot }, async client => {
    return normalizeModelList(await client.request('model/list', { includeHidden: false }))
  })
  modelCache = models
  modelCacheAt = now
  return { models, reasoningEfforts: [...CODEX_REASONING_EFFORTS] }
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

/** The client ID is stable in the browser; Codex's thread ID is durable on disk. */
export class CodexProvider {
  constructor({ runtimeRoot, store = new CodexSessionStore(runtimeRoot), runner = runCodexExec, available = codexAvailable }) {
    this.runtimeRoot = runtimeRoot
    this.store = store
    this.runner = runner
    this.available = available
    this.busy = new Set()
  }

  validate(clientSessionId) {
    if (!CODEX_SESSION_ID.test(clientSessionId ?? '')) {
      const error = new Error('Valid clientSessionId is required for Codex.')
      error.status = 400
      error.code = 'INVALID_CLIENT_SESSION'
      throw error
    }
    if (this.busy.has(clientSessionId)) {
      const error = new Error('This Codex conversation already has an active request.')
      error.status = 409
      error.code = 'CODEX_SESSION_BUSY'
      throw error
    }
    this.busy.add(clientSessionId)
  }

  async sessionFor(clientSessionId) {
    if (!CODEX_SESSION_ID.test(clientSessionId ?? '')) return null
    return this.store.get(clientSessionId)
  }

  async newConversation({ clientSessionId }) {
    this.validate(clientSessionId)
    try {
      await this.store.update(clientSessionId, null)
      return { sessionId: clientSessionId, conversationId: null, selection: null }
    } finally {
      this.busy.delete(clientSessionId)
    }
  }

  async runChat({ clientSessionId, model, reasoningEffort, prompt, screenshotDataUrl, onStart }) {
    if (!this.available()) throw unavailableError()
    this.validate(clientSessionId)
    try {
      const sessionId = await this.store.get(clientSessionId)
      const result = await this.runner({
        runtimeRoot: this.runtimeRoot,
        sessionId,
        model: normalizeModel(model),
        reasoningEffort: normalizeEffort(reasoningEffort),
        prompt,
        screenshotDataUrl,
        onStart
      })
      if (!CODEX_SESSION_ID.test(result.sessionId ?? '') || (sessionId && result.sessionId !== sessionId)) {
        const error = new Error('Codex returned a mismatched session ID.')
        error.code = 'CODEX_SESSION_INVALID'
        throw error
      }
      if (!sessionId) await this.store.update(clientSessionId, result.sessionId)
      return result.response
    } finally {
      this.busy.delete(clientSessionId)
    }
  }
}
