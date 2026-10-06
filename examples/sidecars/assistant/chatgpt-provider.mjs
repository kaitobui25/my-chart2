import { randomUUID } from 'node:crypto'
import { ChatGptBridgeError } from './chatgpt-bridge.mjs'

export const CHATGPT_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'pro'
]

const MODEL_ID = /^[\p{L}\p{N}._ -]{1,80}$/u

function normalizedEffort(value, fallback = 'medium') {
  return CHATGPT_REASONING_EFFORTS.includes(value) ? value : fallback
}

function requestedSelection(model, reasoningEffort) {
  const selectedModel = typeof model === 'string' && MODEL_ID.test(model.trim())
    ? model.trim()
    : null
  return {
    model: selectedModel,
    // "ChatGPT current" means leave the native selection untouched. Sending an
    // effort without an explicit model forces older extension builds to open the
    // native model picker, which is unnecessary and brittle.
    reasoningEffort: selectedModel ? normalizedEffort(reasoningEffort) : null
  }
}

function defaultEffort(efforts) {
  for (const preferred of ['high', 'medium', 'max', 'xhigh', 'low', 'minimal', 'none', 'ultra', 'pro']) {
    if (efforts.includes(preferred)) return preferred
  }
  return efforts[0] || 'medium'
}

export function normalizeChatGptModelCatalog(payload) {
  const models = Array.isArray(payload?.models) ? payload.models : []
  const seen = new Set()
  const normalized = []
  for (const item of models.slice(0, 40)) {
    const id = typeof item?.id === 'string' ? item.id.trim() : ''
    const label = typeof item?.label === 'string' ? item.label.trim() : ''
    if (!MODEL_ID.test(id) || !label || label.length > 100 || seen.has(id)) continue
    const efforts = [...new Set((Array.isArray(item.efforts) ? item.efforts : [])
      .filter(value => CHATGPT_REASONING_EFFORTS.includes(value)))]
    if (efforts.length === 0) continue
    seen.add(id)
    normalized.push({
      id,
      label,
      defaultReasoningEffort: defaultEffort(efforts),
      supportedReasoningEfforts: efforts,
      aliases: Array.isArray(item.aliases)
        ? [...new Set(item.aliases.filter(value => typeof value === 'string' && MODEL_ID.test(value)).slice(0, 20))]
        : []
    })
  }
  return normalized
}

function compatibleStatus({ bridge, session, selection, requested }) {
  const bridgeStatus = bridge.status()
  return {
    account: null,
    requiresOpenaiAuth: null,
    selected: {
      model: selection?.model ?? requested?.model ?? null,
      reasoningEffort: normalizedEffort(
        selection?.reasoningEffort ?? requested?.reasoningEffort,
        'medium'
      )
    },
    rateLimits: {
      primary: null,
      secondary: null,
      reachedType: null,
      individualLimit: null,
      spendControlReached: null
    },
    resetCredits: null,
    provider: 'chatgpt',
    bridgeConnected: bridgeStatus.connected,
    conversationId: session?.conversationId ?? null,
    detail: bridgeStatus.connected
      ? 'LAM ChatGPT Bridge extension is connected.'
      : 'LAM ChatGPT Bridge extension is not connected.'
  }
}

export class ChatGptProvider {
  constructor(bridge, { commandTimeoutMs = 180_000 } = {}) {
    this.bridge = bridge
    this.commandTimeoutMs = commandTimeoutMs
    this.sessions = new Map()
  }

  health() {
    const status = this.bridge.status()
    return {
      ok: true,
      assistantAvailable: status.connected,
      bridgeConnected: status.connected,
      // Compatibility for the existing Excel assistant until it moves to generic naming.
      codexAvailable: status.connected,
      detail: status.connected
        ? 'LAM ChatGPT Bridge extension is connected.'
        : 'Load examples/chatgpt-extension as an unpacked Chrome extension, then keep Chrome signed in to ChatGPT.'
    }
  }

  stateFor(clientSessionId) {
    if (typeof clientSessionId !== 'string' || !clientSessionId) {
      throw new ChatGptBridgeError(
        'clientSessionId is required.',
        { status: 400, code: 'INVALID_CLIENT_SESSION' }
      )
    }
    let state = this.sessions.get(clientSessionId)
    if (!state) {
      state = {
        sessionId: clientSessionId,
        conversationId: null,
        generation: 0,
        lastSelection: null,
        lastRequested: { model: null, reasoningEffort: 'medium' }
      }
      this.sessions.set(clientSessionId, state)
    }
    return state
  }

  hasBoundConversation(clientSessionId) {
    return Boolean(this.sessions.get(clientSessionId)?.conversationId)
  }

  resetLocalConversation(clientSessionId) {
    const state = this.stateFor(clientSessionId)
    state.conversationId = null
    state.generation += 1
    state.lastSelection = null
  }

  async options() {
    const handle = this.bridge.dispatch('models', {}, { timeoutMs: Math.min(this.commandTimeoutMs, 60_000) })
    const payload = await handle.promise
    const models = normalizeChatGptModelCatalog(payload)
    return {
      models,
      reasoningEfforts: CHATGPT_REASONING_EFFORTS
    }
  }

  async status({ clientSessionId, model = null, reasoningEffort = 'medium' } = {}) {
    const state = this.stateFor(clientSessionId)
    if (this.bridge.status().connected) {
      try {
        const handle = this.bridge.dispatch('status', {
          sessionId: state.sessionId
        }, { timeoutMs: Math.min(this.commandTimeoutMs, 15_000) })
        const native = await handle.promise
        if (typeof native?.conversationId === 'string' && native.conversationId.trim()) {
          state.conversationId = native.conversationId.trim()
        }
        if (native?.selection && typeof native.selection === 'object') {
          state.lastSelection = native.selection
        }
      } catch {
        // Status remains useful from local state if the native tab is briefly busy.
      }
    }
    return compatibleStatus({
      bridge: this.bridge,
      session: state,
      selection: state.lastSelection,
      requested: { model, reasoningEffort }
    })
  }

  async newConversation({ clientSessionId, model = null, reasoningEffort = 'medium' } = {}) {
    const state = this.stateFor(clientSessionId)
    const requested = requestedSelection(model, reasoningEffort)
    const handle = this.bridge.dispatch('new_chat', {
      sessionId: state.sessionId,
      ...requested
    }, { timeoutMs: Math.min(this.commandTimeoutMs, 60_000) })
    const result = await handle.promise
    state.conversationId = null
    state.generation += 1
    state.lastRequested = requested
    state.lastSelection = result?.selection ?? null
    return {
      sessionId: state.sessionId,
      conversationId: null,
      selection: state.lastSelection
    }
  }

  runChat({
    clientSessionId,
    requestId,
    model = null,
    reasoningEffort = 'medium',
    prompt,
    resumeExisting = false,
    onStart
  }) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new ChatGptBridgeError('Prompt is required.', { status: 400, code: 'INVALID_PROMPT' })
    }
    const requested = requestedSelection(model, reasoningEffort)
    const state = this.stateFor(clientSessionId)
    state.lastRequested = requested
    const generationAtStart = state.generation
    const handle = this.bridge.dispatch('chat_send', {
      requestId,
      sessionId: state.sessionId,
      conversationId: state.conversationId,
      resumeExisting: resumeExisting === true,
      ...requested,
      prompt
    }, { timeoutMs: this.commandTimeoutMs })

    const cancel = () => {
      const cancelled = handle.cancel()
      try {
        const stop = this.bridge.dispatch('cancel', {
          requestId,
          sessionId: state.sessionId
        }, { timeoutMs: 10_000 })
        void stop.promise.catch(() => undefined)
      } catch {
        // Local cancellation still succeeds if the extension disconnected.
      }
      return cancelled
    }
    onStart?.({ cancel })

    return handle.promise.then(result => {
      const current = this.stateFor(clientSessionId)
      if (current.generation !== generationAtStart) {
        throw new ChatGptBridgeError(
          'ChatGPT response belongs to an older LAM conversation.',
          { status: 409, code: 'STALE_CHATGPT_SESSION' }
        )
      }
      if (typeof result?.conversationId !== 'string' || !result.conversationId.trim()) {
        throw new ChatGptBridgeError(
          'ChatGPT conversation id was not observed after Send.',
          { status: 502, code: 'CHATGPT_CONVERSATION_MISSING' }
        )
      }
      if (typeof result?.message !== 'string' || !result.message.trim()) {
        throw new ChatGptBridgeError(
          'ChatGPT did not return a usable assistant message.',
          { status: 502, code: 'CHATGPT_RESPONSE_MISSING' }
        )
      }
      current.conversationId = result.conversationId
      current.lastSelection = result.selection ?? current.lastSelection
      return { message: result.message.trim() }
    })
  }
}
