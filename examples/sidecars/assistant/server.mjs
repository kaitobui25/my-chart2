import http from 'node:http'
import { mkdir } from 'node:fs/promises'
import { HOST, MAX_BODY_BYTES, PORT, REQUEST_TIMEOUT_MS, RUNTIME_ROOT } from './config.mjs'
import { buildPrompt } from './prompt-builder.mjs'
import { parseNativeResponse } from './response-schema.mjs'
import { ChatGptExtensionBridge, validExtensionId } from './chatgpt-bridge.mjs'
import { ChatGptProvider } from './chatgpt-provider.mjs'
import { CodexProvider, codexAvailable, getCodexOptions, getCodexStatus } from './codex-provider.mjs'

const ASSISTANT_API_VERSION = 2
await mkdir(RUNTIME_ROOT, { recursive: true })
const activeRequests = new Map()
let extensionSourceVersion = null
const chatGptBridge = new ChatGptExtensionBridge()
const chatGptProvider = new ChatGptProvider(chatGptBridge, { commandTimeoutMs: REQUEST_TIMEOUT_MS })
const codexProvider = new CodexProvider({ runtimeRoot: RUNTIME_ROOT })

function assistantProvider(value) {
  if (value == null || value === '') return 'codex'
  if (value === 'chatgpt') return 'chatgpt'
  if (value === 'codex') return 'codex'
  const error = new Error('Assistant provider must be "chatgpt" or "codex".')
  error.status = 400
  error.code = 'INVALID_PROVIDER'
  throw error
}

function providerHealth(provider) {
  if (provider === 'chatgpt') {
    return { ...chatGptProvider.health(), apiVersion: ASSISTANT_API_VERSION, provider }
  }
  const available = codexAvailable()
  return {
    ok: true,
    apiVersion: ASSISTANT_API_VERSION,
    provider,
    assistantAvailable: available,
    bridgeConnected: false,
    codexAvailable: available,
    detail: available ? 'Codex CLI is ready.' : 'Install Codex CLI and sign in with ChatGPT.'
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  response.end(JSON.stringify(payload))
}

function loopbackAddress(request) {
  return String(request.socket.remoteAddress || '').replace(/^::ffff:/, '')
}

function isLoopbackRequest(request) {
  return ['127.0.0.1', '::1'].includes(loopbackAddress(request))
}

function extensionOrigin(request) {
  const origin = request.headers.origin
  if (!origin) return null
  return /^chrome-extension:\/\/[a-p]{32}$/i.test(origin) ? origin : false
}

function setBridgeCors(request, response) {
  const origin = extensionOrigin(request)
  if (origin) response.setHeader('access-control-allow-origin', origin)
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  response.setHeader('access-control-allow-headers', 'content-type, x-l2chart-extension-id')
  response.setHeader('access-control-max-age', '600')
}

function sendBridgeJson(request, response, status, payload) {
  setBridgeCors(request, response)
  sendJson(response, status, payload)
}

function bridgeExtensionId(request) {
  const value = request.headers['x-l2chart-extension-id']
  return typeof value === 'string' && validExtensionId(value) ? value : null
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
  // Reject browser form POSTs to the directly reachable local sidecar.
  // The Vite proxy and native chart client both submit JSON.
  if (request.headers['sec-fetch-site'] === 'cross-site'
    || !/^application\/json(?:\s*;|\s*$)/i.test(String(request.headers['content-type'] ?? ''))) {
    return sendJson(response, 403, { error: 'Chart requests must be same-origin JSON.', code: 'FORBIDDEN' })
  }
  const body = await readJson(request)
  const provider = assistantProvider(body.provider)
  if (!validRequestId(body.requestId)) return sendJson(response, 400, { error: 'Valid requestId is required.', code: 'INVALID_REQUEST_ID' })
  if (typeof body.message !== 'string' || !body.message.trim()) return sendJson(response, 400, { error: 'Message is required.', code: 'INVALID_MESSAGE' })
  if (!body.context || typeof body.context !== 'object') return sendJson(response, 400, { error: 'Chart context is required.', code: 'INVALID_CONTEXT' })
  if (activeRequests.has(body.requestId)) return sendJson(response, 409, { error: 'requestId is already active.', code: 'DUPLICATE_REQUEST' })
  if (
    provider === 'chatgpt'
    &&
    Array.isArray(body.conversation)
    && body.conversation.length === 0
    && chatGptProvider.hasBoundConversation(body.clientSessionId)
  ) {
    // The native thread owns history. An empty local transcript after a workstation reload
    // means the browser client no longer owns the old native thread, so start fresh lazily.
    chatGptProvider.resetLocalConversation(body.clientSessionId)
  }

  const prompt = buildPrompt({
    message: body.message,
    structuredResponse: provider === 'codex',
    continuation: provider === 'codex' && Array.isArray(body.toolResults) && body.toolResults.length > 0,
    context: body.context,
    toolResults: Array.isArray(body.toolResults) ? body.toolResults : []
  })

  const active = { cancelled: false, cancel: null }
  activeRequests.set(body.requestId, () => {
    active.cancelled = true
    active.cancel?.()
  })
  const onStart = ({ cancel }) => {
    active.cancel = cancel
    if (active.cancelled) cancel()
  }
  let timeout
  try {
    const providerRequest = provider === 'codex'
      ? codexProvider.runChat({
          clientSessionId: body.clientSessionId,
          model: body.model,
          reasoningEffort: body.reasoningEffort,
          prompt,
          screenshotDataUrl: body.screenshotDataUrl,
          onStart
        })
      : chatGptProvider.runChat({
          clientSessionId: body.clientSessionId,
          requestId: body.requestId,
          model: body.model,
          reasoningEffort: body.reasoningEffort,
          prompt,
          onStart
        })
    const result = await Promise.race([
      providerRequest,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          activeRequests.get(body.requestId)?.()
          const error = new Error(`${provider === 'codex' ? 'Codex' : 'ChatGPT'} request timed out.`)
          error.status = 504
          error.code = provider === 'codex' ? 'CODEX_TIMEOUT' : 'CHATGPT_TIMEOUT'
          reject(error)
        }, REQUEST_TIMEOUT_MS)
      })
    ])
    return sendJson(response, 200, provider === 'chatgpt' ? parseNativeResponse(result.message) : result)
  } finally {
    clearTimeout(timeout)
    activeRequests.delete(body.requestId)
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`)
  try {
    if (url.pathname.startsWith('/bridge/')) {
      if (!isLoopbackRequest(request)) {
        return sendBridgeJson(request, response, 403, { error: 'Loopback access only.', code: 'FORBIDDEN' })
      }
      if (extensionOrigin(request) === false) {
        return sendBridgeJson(request, response, 403, { error: 'Only the Chrome extension may use this bridge.', code: 'FORBIDDEN' })
      }
      if (request.method === 'OPTIONS') {
        setBridgeCors(request, response)
        response.writeHead(204)
        response.end()
        return
      }
      const extensionId = bridgeExtensionId(request)
      if (!extensionId) {
        return sendBridgeJson(request, response, 400, { error: 'Missing extension identity.', code: 'INVALID_EXTENSION_ID' })
      }
      if (request.method === 'GET' && url.pathname === '/bridge/poll') {
        extensionSourceVersion = url.searchParams.get('source') || null
        const command = await chatGptBridge.poll(extensionId)
        return sendBridgeJson(request, response, 200, { command })
      }
      if (request.method === 'POST' && url.pathname === '/bridge/result') {
        const body = await readJson(request)
        if (typeof body.commandId !== 'string' || !body.commandId) {
          return sendBridgeJson(request, response, 400, { error: 'commandId is required.', code: 'INVALID_COMMAND_ID' })
        }
        const accepted = chatGptBridge.complete(extensionId, body.commandId, body.result)
        return sendBridgeJson(request, response, 200, { accepted })
      }
      return sendBridgeJson(request, response, 404, { error: 'Bridge endpoint not found.', code: 'NOT_FOUND' })
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const provider = assistantProvider(url.searchParams.get('provider'))
      return sendJson(response, 200, {
        ...providerHealth(provider),
        extensionSourceVersion
      })
    }
    if (request.method === 'GET' && url.pathname === '/options') {
      const provider = assistantProvider(url.searchParams.get('provider'))
      const payload = provider === 'codex'
        ? await getCodexOptions({ runtimeRoot: RUNTIME_ROOT })
        : await chatGptProvider.options()
      return sendJson(response, 200, payload)
    }
    if (request.method === 'POST' && url.pathname === '/status') {
      const body = await readJson(request)
      const provider = assistantProvider(body.provider)
      const payload = provider === 'codex'
        ? {
            ...await getCodexStatus({
              runtimeRoot: RUNTIME_ROOT,
              model: body.model,
              reasoningEffort: body.reasoningEffort
            }),
            provider,
            conversationId: await codexProvider.sessionFor(body.clientSessionId),
            bridgeConnected: false,
            detail: 'Codex CLI is ready.'
          }
        : await chatGptProvider.status({
            clientSessionId: body.clientSessionId,
            model: body.model,
            reasoningEffort: body.reasoningEffort
          })
      return sendJson(response, 200, payload)
    }
    if (request.method === 'POST' && url.pathname === '/new') {
      const body = await readJson(request)
      const provider = assistantProvider(body.provider)
      if (provider === 'codex') {
        return sendJson(response, 200, await codexProvider.newConversation({ clientSessionId: body.clientSessionId }))
      }
      return sendJson(response, 200, await chatGptProvider.newConversation({
        clientSessionId: body.clientSessionId,
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
