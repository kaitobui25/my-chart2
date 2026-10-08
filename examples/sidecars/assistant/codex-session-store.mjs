import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export const CODEX_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class CodexSessionStore {
  constructor(runtimeRoot) {
    this.filePath = path.join(runtimeRoot, 'codex-sessions.json')
    this.sessions = null
    this.loading = null
    this.pending = Promise.resolve()
  }

  async load() {
    if (this.sessions !== null) return
    if (!this.loading) this.loading = this.readSessions().finally(() => { this.loading = null })
    await this.loading
  }

  async readSessions() {
    let contents
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      this.sessions = new Map()
      return
    }
    const stored = JSON.parse(contents)
    if (!stored || stored.version !== 1 || !Array.isArray(stored.sessions)) {
      throw new Error('Invalid Codex session store format.')
    }
    if (!stored.sessions.every(entry => Array.isArray(entry) && entry.length === 2
      && CODEX_SESSION_ID.test(entry[0]) && CODEX_SESSION_ID.test(entry[1]))) {
      throw new Error('Invalid Codex session store entries.')
    }
    this.sessions = new Map(stored.sessions)
  }

  async get(clientSessionId) {
    await this.pending
    await this.load()
    return this.sessions.get(clientSessionId) ?? null
  }

  update(clientSessionId, threadId) {
    if (!CODEX_SESSION_ID.test(clientSessionId ?? '') || (threadId !== null && !CODEX_SESSION_ID.test(threadId ?? ''))) {
      return Promise.reject(new Error('Invalid Codex session identifier.'))
    }
    const operation = this.pending.then(async () => {
      await this.load()
      const previous = this.sessions.get(clientSessionId) ?? null
      if (threadId === null) this.sessions.delete(clientSessionId)
      else this.sessions.set(clientSessionId, threadId)

      try {
        await mkdir(path.dirname(this.filePath), { recursive: true })
        const temporary = `${this.filePath}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, JSON.stringify({ version: 1, sessions: [...this.sessions] }), { mode: 0o600 })
          await rename(temporary, this.filePath)
        } finally {
          await rm(temporary, { force: true })
        }
      } catch (error) {
        if (previous === null) this.sessions.delete(clientSessionId)
        else this.sessions.set(clientSessionId, previous)
        throw error
      }
    })
    this.pending = operation.catch(() => {})
    return operation
  }
}
