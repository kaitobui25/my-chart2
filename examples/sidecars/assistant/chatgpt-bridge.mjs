import { randomUUID } from 'node:crypto'

const EXTENSION_ID = /^[a-p]{32}$/i
const DEFAULT_CONNECTED_TTL_MS = 45_000
const DEFAULT_POLL_TIMEOUT_MS = 20_000

export class ChatGptBridgeError extends Error {
  constructor(message, { status = 500, code = 'CHATGPT_BRIDGE_ERROR' } = {}) {
    super(message)
    this.name = 'ChatGptBridgeError'
    this.status = status
    this.code = code
  }
}

function bridgeError(message, status, code) {
  return new ChatGptBridgeError(message, { status, code })
}

export class ChatGptExtensionBridge {
  constructor({
    connectedTtlMs = DEFAULT_CONNECTED_TTL_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    now = () => Date.now()
  } = {}) {
    this.connectedTtlMs = connectedTtlMs
    this.pollTimeoutMs = pollTimeoutMs
    this.now = now
    this.extensionId = null
    this.lastSeenAt = 0
    this.queue = []
    this.pollWaiters = []
    this.pending = new Map()
  }

  status() {
    const connected = Boolean(
      this.extensionId
      && this.lastSeenAt > 0
      && this.now() - this.lastSeenAt <= this.connectedTtlMs
    )
    return {
      connected,
      extensionId: connected ? this.extensionId : null,
      lastSeenAt: this.lastSeenAt || null
    }
  }

  touch(extensionId) {
    if (!EXTENSION_ID.test(String(extensionId || ''))) {
      throw bridgeError('A valid L2Chart extension id is required.', 400, 'INVALID_EXTENSION_ID')
    }
    const current = this.status()
    if (current.connected && this.extensionId !== extensionId) {
      throw bridgeError('Another L2Chart ChatGPT extension is already connected.', 409, 'EXTENSION_CONFLICT')
    }
    this.extensionId = extensionId
    this.lastSeenAt = this.now()
  }

  async poll(extensionId, { timeoutMs = this.pollTimeoutMs } = {}) {
    this.touch(extensionId)
    const queued = this.queue.shift()
    if (queued) return queued

    return await new Promise(resolve => {
      const waiter = {
        extensionId,
        resolve: command => {
          clearTimeout(waiter.timer)
          resolve(command)
        },
        timer: null
      }
      waiter.timer = setTimeout(() => {
        const index = this.pollWaiters.indexOf(waiter)
        if (index >= 0) this.pollWaiters.splice(index, 1)
        resolve(null)
      }, Math.max(250, timeoutMs))
      this.pollWaiters.push(waiter)
    })
  }

  dispatch(type, payload, { timeoutMs = 180_000 } = {}) {
    if (!this.status().connected) {
      throw bridgeError(
        'LAM ChatGPT Bridge extension is not connected. Load the unpacked extension and keep Chrome signed in to ChatGPT.',
        503,
        'CHATGPT_EXTENSION_OFFLINE'
      )
    }
    if (typeof type !== 'string' || !/^[a-z_]{2,40}$/.test(type)) {
      throw bridgeError('Invalid bridge command type.', 400, 'INVALID_BRIDGE_COMMAND')
    }

    const id = randomUUID()
    const command = { id, type, payload, createdAt: this.now() }
    let settled = false
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending || settled) return
        settled = true
        this.pending.delete(id)
        reject(bridgeError('ChatGPT browser command timed out.', 504, 'CHATGPT_BRIDGE_TIMEOUT'))
      }, Math.max(1_000, timeoutMs))
      this.pending.set(id, {
        resolve: value => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.pending.delete(id)
          resolve(value)
        },
        reject: error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.pending.delete(id)
          reject(error)
        }
      })
    })

    const cancel = (reason = 'Request cancelled.') => {
      if (settled) return false
      const pending = this.pending.get(id)
      const queued = this.queue.findIndex(item => item.id === id)
      if (queued >= 0) this.queue.splice(queued, 1)
      const error = bridgeError(reason, 499, 'ASSISTANT_CANCELLED')
      if (pending) pending.reject(error)
      return true
    }

    const waiterIndex = this.pollWaiters.findIndex(waiter => waiter.extensionId === this.extensionId)
    if (waiterIndex >= 0) {
      const [waiter] = this.pollWaiters.splice(waiterIndex, 1)
      waiter.resolve(command)
    } else {
      this.queue.push(command)
    }

    return { id, promise, cancel }
  }

  complete(extensionId, commandId, result) {
    this.touch(extensionId)
    const pending = this.pending.get(commandId)
    if (!pending) return false
    if (result?.ok === true) {
      pending.resolve(result.data ?? {})
      return true
    }
    pending.reject(bridgeError(
      typeof result?.error === 'string' && result.error.trim()
        ? result.error.trim().slice(0, 2_000)
        : 'ChatGPT browser command failed.',
      Number(result?.status) || 502,
      typeof result?.code === 'string' && result.code
        ? result.code.slice(0, 80)
        : 'CHATGPT_BROWSER_ERROR'
    ))
    return true
  }
}

export function validExtensionId(value) {
  return EXTENSION_ID.test(String(value || ''))
}
