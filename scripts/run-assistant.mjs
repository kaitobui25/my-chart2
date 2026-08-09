import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const assistantServerPath = path.join(ROOT, 'examples', 'sidecars', 'assistant', 'server.mjs')
const workstationConfigPath = path.join(ROOT, 'examples', 'workstation', 'vite.config.ts')
const ASSISTANT_HEALTH_URL = 'http://127.0.0.1:8788/health'
const DEFAULT_WORKSTATION_PORT = 53173
const PROVIDER_RUNTIME_VERSION = 1

if (!existsSync(viteBin)) {
  console.error('Missing node_modules. Run "npm install" once, then start this launcher again.')
  process.exit(1)
}

const children = []
let closing = false

function shutdown(code = 0) {
  if (closing) return
  closing = true
  for (const child of children) {
    if (!child.killed) child.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
  }
  process.exitCode = code
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: false,
    ...options,
  })
  children.push(child)
  child.on('exit', code => {
    if (!closing && code !== 0) shutdown(code ?? 1)
  })
  child.on('error', error => {
    console.error(error.message)
    shutdown(1)
  })
  return child
}

async function readJson(url, timeoutMs = 900) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

async function waitForJsonHealth(url, attempts = 40) {
  for (let attempt = 0; attempt < attempts && !closing; attempt += 1) {
    const health = await readJson(url)
    if (health?.ok) return health
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return null
}

async function ensureAssistantSidecar() {
  let health = await readJson(ASSISTANT_HEALTH_URL)
  if (health?.ok) {
    console.log(`[assistant] Reusing sidecar at ${ASSISTANT_HEALTH_URL}`)
    return
  }

  console.log('[assistant] Starting sidecar...')
  spawnManaged(process.execPath, [assistantServerPath])
  health = await waitForJsonHealth(ASSISTANT_HEALTH_URL)
  if (!health?.ok) throw new Error(`Assistant sidecar did not become ready at ${ASSISTANT_HEALTH_URL}`)
}

async function workstationRuntimeIsCompatible(port) {
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    const page = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(900) })
    if (!page.ok) return false
    const runtime = await readJson(`${baseUrl}/provider-runtime/health`)
    return runtime?.ok === true && runtime.version === PROVIDER_RUNTIME_VERSION
  } catch {
    return false
  }
}

function portIsAvailable(port) {
  return new Promise(resolve => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

async function chooseWorkstationPort() {
  for (let port = DEFAULT_WORKSTATION_PORT; port < DEFAULT_WORKSTATION_PORT + 20; port += 1) {
    if (await portIsAvailable(port)) return port
  }
  throw new Error('No free local workstation port was found near 53173.')
}

function openBrowser(url) {
  let child
  if (process.platform === 'win32') {
    child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
  } else if (process.platform === 'darwin') {
    child = spawn('open', [url], { detached: true, stdio: 'ignore' })
  } else {
    child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
  }
  child.unref()
}

async function startOrReuseWorkstation() {
  if (await workstationRuntimeIsCompatible(DEFAULT_WORKSTATION_PORT)) {
    const url = `http://127.0.0.1:${DEFAULT_WORKSTATION_PORT}/`
    console.log(`[workstation] Reusing dev server at ${url}`)
    openBrowser(url)
    return
  }

  const defaultPortFree = await portIsAvailable(DEFAULT_WORKSTATION_PORT)
  const port = defaultPortFree ? DEFAULT_WORKSTATION_PORT : await chooseWorkstationPort()
  if (port !== DEFAULT_WORKSTATION_PORT) {
    console.warn(`[workstation] Port ${DEFAULT_WORKSTATION_PORT} is occupied by an older/incompatible dev server; starting this session on ${port}.`)
  }
  spawnManaged(process.execPath, [
    viteBin,
    '--config', workstationConfigPath,
    '--port', String(port),
    '--strictPort',
    '--open',
  ])
}

try {
  await ensureAssistantSidecar()
  console.log('[providers] FiinQuant and Vnstock are lazy. They start only when the chart activates them.')
  await startOrReuseWorkstation()
} catch (error) {
  console.error(`[launcher] ${error instanceof Error ? error.message : String(error)}`)
  shutdown(1)
}
