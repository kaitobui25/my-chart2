import { spawn } from 'node:child_process'
import { spawnCommand } from './command-utils.mjs'

const DEFAULT_TIMEOUT_MS = 15000

function terminate(child) {
  if (!child || child.killed) return
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    return
  }
  child.kill('SIGTERM')
}

export class CodexAppServerClient {
  constructor({ cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.cwd = cwd
    this.timeoutMs = timeoutMs
    this.child = null
    this.buffer = ''
    this.stderr = ''
    this.nextId = 1
    this.pending = new Map()
  }

  async start() {
    if (this.child !== null) return
    this.child = spawnCommand('codex', ['app-server', '--stdio'], {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child.stdout.on('data', chunk => this.consume(String(chunk)))
    this.child.stderr.on('data', chunk => { this.stderr += String(chunk) })
    this.child.on('error', error => this.rejectAll(error))
    this.child.on('exit', code => {
      const message = this.stderr.trim() || `Codex app-server exited with code ${code}.`
      this.rejectAll(new Error(message))
      this.child = null
    })

    await this.request('initialize', {
      clientInfo: {
        name: 'l2chart_assistant',
        title: 'L2Chart AI Assistant',
        version: '1.0.0'
      },
      capabilities: {
        optOutNotificationMethods: [
          'thread/started',
          'turn/started',
          'turn/completed',
          'item/started',
          'item/completed',
          'item/agentMessage/delta'
        ]
      }
    })
    this.notify('initialized')
  }

  consume(chunk) {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.id === undefined || !this.pending.has(message.id)) continue

      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error) {
        const error = new Error(message.error.message ?? 'Codex app-server request failed.')
        error.code = 'CODEX_APP_SERVER_ERROR'
        pending.reject(error)
      } else {
        pending.resolve(message.result ?? {})
      }
    }
  }

  request(method, params) {
    if (this.child === null || this.child.killed) {
      return Promise.reject(new Error('Codex app-server is not running.'))
    }
    const id = this.nextId++
    const payload = params === undefined ? { id, method } : { id, method, params }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        const error = new Error(`Codex app-server request timed out: ${method}`)
        error.code = 'CODEX_APP_SERVER_TIMEOUT'
        reject(error)
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.child.stdin.write(`${JSON.stringify(payload)}\n`)
    })
  }

  notify(method, params) {
    if (this.child === null || this.child.killed) return
    const payload = params === undefined ? { method } : { method, params }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  close() {
    this.rejectAll(new Error('Codex app-server connection closed.'))
    terminate(this.child)
    this.child = null
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export async function withCodexAppServer(options, callback) {
  const client = new CodexAppServerClient(options)
  try {
    await client.start()
    return await callback(client)
  } finally {
    client.close()
  }
}
