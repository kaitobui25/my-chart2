import http from 'node:http'
import { mkdir } from 'node:fs/promises'
import { HOST, MAX_BODY_BYTES, PORT, REQUEST_TIMEOUT_MS, RUNTIME_ROOT } from './config.mjs'
import { buildPrompt } from './prompt-builder.mjs'
import { codexAvailable, getCodexOptions, getCodexStatus, runCodex } from './codex-provider.mjs'

await mkdir(RUNTIME_ROOT, { recursive: true })
const activeRequests = new Map()

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  response.end(JSON.stringify(payload))
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large.')
      error.status = 413
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('Request body must be valid JSON.')
    error.status = 400
    error.code = 'INVALID_JSON'
    throw error
  }
}

function validRequestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(value)
}

async function handleChat(request, response) {
  const body = await readJson(request)
  if (!validRequestId(body.requestId)) return sendJson(response, 400, { error: 'Valid requestId is required.', code: 'INVALID_REQUEST_ID' })
  if (typeof body.message !== 'string' || !body.message.trim()) return sendJson(response, 400, { error: 'Message is required.', code: 'INVALID_MESSAGE' })
  if (!body.context || typeof body.context !== 'object') return sendJson(response, 400, { error: 'Chart context is required.', code: 'INVALID_CONTEXT' })
  if (activeRequests.has(body.requestId)) return sendJson(response, 409, { error: 'requestId is already active.', code: 'DUPLICATE_REQUEST' })

  const mode = body.mode === 'analyze' ? 'analyze' : 'chat'
  const prompt = buildPrompt({
    mode,
    message: body.message,
    conversation: body.conversation,
    context: body.context
  })

  let timeout
  try {
    const result = await Promise.race([
      runCodex({
        runtimeRoot: RUNTIME_ROOT,
        mode,
        model: body.model,
        reasoningEffort: body.reasoningEffort,
        prompt,
        screenshotDataUrl: body.screenshotDataUrl,
        onStart: ({ cancel }) => activeRequests.set(body.requestId, cancel)
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          activeRequests.get(body.requestId)?.()
          const error = new Error('Codex request timed out.')
          error.status = 504
          error.code = 'CODEX_TIMEOUT'
          reject(error)
        }, REQUEST_TIMEOUT_MS)
      })
    ])
    return sendJson(response, 200, result)
  } finally {
    clearTimeout(timeout)
    activeRequests.delete(body.requestId)
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`)
  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      const available = codexAvailable()
      return sendJson(response, 200, {
        ok: true,
        codexAvailable: available,
        detail: available ? 'Codex CLI is ready.' : 'Install Codex CLI and sign in with ChatGPT.'
      })
    }
    if (request.method === 'GET' && url.pathname === '/options') {
      return sendJson(response, 200, await getCodexOptions({ runtimeRoot: RUNTIME_ROOT }))
    }
    if (request.method === 'POST' && url.pathname === '/status') {
      const body = await readJson(request)
      return sendJson(response, 200, await getCodexStatus({
        runtimeRoot: RUNTIME_ROOT,
        model: body.model,
        reasoningEffort: body.reasoningEffort
      }))
    }
    if (request.method === 'POST' && url.pathname === '/chat') return await handleChat(request, response)
    if (request.method === 'POST' && url.pathname === '/cancel') {
      const body = await readJson(request)
      const cancel = activeRequests.get(body.requestId)
      if (cancel) cancel()
      return sendJson(response, 200, { cancelled: Boolean(cancel) })
    }
    return sendJson(response, 404, { error: 'Not found.', code: 'NOT_FOUND' })
  } catch (error) {
    const status = Number(error.status) || 500
    return sendJson(response, status, {
      error: error instanceof Error ? error.message : String(error),
      code: error?.code ?? 'INTERNAL_ERROR'
    })
  }
})

server.on('error', error => {
  console.error(`L2Chart assistant sidecar failed: ${error.message}`)
  process.exitCode = 1
})

server.listen(PORT, HOST, () => {
  console.log(`L2Chart assistant sidecar listening on http://${HOST}:${PORT}`)
})
