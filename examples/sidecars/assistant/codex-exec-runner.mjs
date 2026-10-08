import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { spawnCommand } from './command-utils.mjs'
import { ASSISTANT_RESPONSE_SCHEMA, parseResponse } from './response-schema.mjs'
import { CODEX_SESSION_ID } from './codex-session-store.mjs'

function terminate(child) {
  if (!child || child.killed) return
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
  } else {
    child.kill('SIGTERM')
  }
}

/** Every invocation is a process; the returned thread ID links successive invocations. */
export async function runCodexExec({
  runtimeRoot, sessionId = null, model, reasoningEffort, prompt, screenshotDataUrl, onStart,
  spawnImpl = spawnCommand
}) {
  await mkdir(runtimeRoot, { recursive: true })
  const requestDir = await mkdtemp(path.join(os.tmpdir(), 'l2chart-codex-'))
  const schemaPath = path.join(requestDir, 'response-schema.json')
  const outputPath = path.join(requestDir, 'response.json')
  const imagePath = path.join(requestDir, 'chart.png')

  try {
    const args = ['exec', '--json']
    if (sessionId) {
      args.push('resume')
    } else {
      await writeFile(schemaPath, JSON.stringify(ASSISTANT_RESPONSE_SCHEMA), 'utf8')
      args.push('--sandbox', 'read-only', '-C', runtimeRoot, '--output-schema', schemaPath)
    }
    args.push('--skip-git-repo-check', '--config', 'sandbox_mode="read-only"')
    args.push('--config', `model_reasoning_effort="${reasoningEffort}"`)
    args.push('--output-last-message', outputPath)
    if (model) args.push('--model', model)

    if (typeof screenshotDataUrl === 'string' && screenshotDataUrl.startsWith('data:image/png;base64,')) {
      const base64 = screenshotDataUrl.slice('data:image/png;base64,'.length)
      await writeFile(imagePath, Buffer.from(base64, 'base64'))
      args.push('--image', imagePath)
    }
    if (sessionId) args.push(sessionId)
    args.push('-')

    let threadId = null
    let completed = false
    let eventFailure = null
    let malformedOutput = false
    let stdoutBuffer = ''
    let stderr = ''

    await new Promise((resolve, reject) => {
      let child
      try {
        child = spawnImpl('codex', args, {
          cwd: runtimeRoot,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (error) {
        reject(error)
        return
      }
      const consumeLine = line => {
        if (!line.trim()) return
        let event
        try { event = JSON.parse(line) } catch { malformedOutput = true; return }
        if (event.type === 'thread.started') {
          if (threadId && threadId !== event.thread_id) malformedOutput = true
          threadId = event.thread_id
        }
        if (event.type === 'turn.completed') completed = true
        if (event.type === 'turn.failed' || event.type === 'error') {
          eventFailure = event.error?.message ?? event.message ?? 'Codex turn failed.'
        }
      }
      child.stdout.on('data', chunk => {
        stdoutBuffer += String(chunk)
        if (stdoutBuffer.length > 4 * 1024 * 1024) {
          malformedOutput = true
          terminate(child)
          return
        }
        const lines = stdoutBuffer.split(/\r?\n/)
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) consumeLine(line)
      })
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16_384) })
      child.on('error', reject)
      child.on('close', code => {
        consumeLine(stdoutBuffer)
        if (code !== 0 || eventFailure || malformedOutput) {
          const error = new Error(eventFailure || stderr.trim() || `Codex exited with code ${code}.`)
          error.code = 'CODEX_FAILED'
          reject(error)
        } else resolve()
      })
      onStart?.({ child, cancel: () => terminate(child) })
      child.stdin.on('error', () => {}) // A cancelled child may close stdin while writing.
      child.stdin.end(prompt)
    })

    if (!CODEX_SESSION_ID.test(threadId ?? '') || (sessionId && threadId !== sessionId) || !completed) {
      const error = new Error('Codex did not complete a turn in the expected session.')
      error.code = 'CODEX_SESSION_INVALID'
      throw error
    }
    return { sessionId: threadId, response: parseResponse(await readFile(outputPath, 'utf8')) }
  } finally {
    await rm(requestDir, { recursive: true, force: true })
  }
}
