import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const assistantServerPath = path.join(ROOT, 'examples', 'sidecars', 'assistant', 'server.mjs')
const binanceLocalSidecarPath = path.join(ROOT, 'examples', 'sidecars', 'binance-local', 'binance_local_sidecar.py')
const workstationConfigPath = path.join(ROOT, 'scripts', 'vite-dev.config.mjs')
const ASSISTANT_HEALTH_URL = 'http://127.0.0.1:8788/health'
const BINANCE_LOCAL_HEALTH_URL = 'http://127.0.0.1:8750/health'
const DEFAULT_WORKSTATION_PORT = 53173
const PROVIDER_RUNTIME_VERSION = 1
const DEV_TRACE_VERSION = 1

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

function localPythonCandidates() {
  const candidates = []
  if (process.env.BINANCE_LOCAL_PYTHON) candidates.push(process.env.BINANCE_LOCAL_PYTHON)
  if (process.env.VIRTUAL_ENV) {
    candidates.push(process.platform === 'win32'
      ? path.join(process.env.VIRTUAL_ENV, 'Scripts', 'python.exe')
      : path.join(process.env.VIRTUAL_ENV, 'bin', 'python'))
  }
  if (process.platform === 'win32') candidates.push('python', 'py')
  else candidates.push('python3', 'python')
  return [...new Set(candidates)]
}

function startBinanceLocalSidecar() {
  if (!existsSync(binanceLocalSidecarPath)) {
    throw new Error(`Missing Binance Local Archive sidecar: ${binanceLocalSidecarPath}`)
  }
  const candidates = localPythonCandidates()
  const launch = index => {
    const python = candidates[index]
    if (!python) {
      console.error('[binance-local] Python was not found. Install Python 3 and run npm run dev again.')
      shutdown(1)
      return
    }
    const args = python === 'py' ? ['-3', binanceLocalSidecarPath] : [binanceLocalSidecarPath]
    const child = spawn(python, args, {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: false,
      env: { ...process.env, BINANCE_LOCAL_PORT: '8750' },
    })
    children.push(child)
    let started = false
    child.once('spawn', () => { started = true })
    child.once('error', error => {
      const position = children.indexOf(child)
      if (position >= 0) children.splice(position, 1)
      if (!closing && !started && error?.code === 'ENOENT') launch(index + 1)
      else if (!closing) {
        console.error(`[binance-local] ${error.message}`)
        shutdown(1)
      }
    })
    child.once('exit', code => {
      if (!closing && code !== 0) shutdown(code ?? 1)
    })
  }
  launch(0)
}

async function ensureBinanceLocalSidecar() {
  let health = await readJson(BINANCE_LOCAL_HEALTH_URL)
  if (health?.ok) {
    console.log(`[binance-local] Reusing sidecar at ${BINANCE_LOCAL_HEALTH_URL}`)
    return
  }

  console.log('[binance-local] Starting independent local SQLite archive service...')
  startBinanceLocalSidecar()
  health = await waitForJsonHealth(BINANCE_LOCAL_HEALTH_URL, 80)
  if (!health?.ok) throw new Error(`Binance Local Archive sidecar did not become ready at ${BINANCE_LOCAL_HEALTH_URL}`)
}

async function workstationRuntimeIsCompatible(port) {
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    const page = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(900) })
    if (!page.ok) return false
    const [runtime, trace] = await Promise.all([
      readJson(`${baseUrl}/provider-runtime/health`),
      readJson(`${baseUrl}/__l2chart_dev_trace/health`),
    ])
    return runtime?.ok === true
      && runtime.version === PROVIDER_RUNTIME_VERSION
      && trace?.ok === true
      && trace.version === DEV_TRACE_VERSION
  } catch {
    return false
  }
}

async function waitForWorkstation(port, attempts = 120) {
  for (let attempt = 0; attempt < attempts && !closing; attempt += 1) {
    if (await workstationRuntimeIsCompatible(port)) return true
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
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
    console.log(`[workstation] Reusing traced dev server at ${url}`)
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
  ])
  const ready = await waitForWorkstation(port)
  if (!ready) throw new Error(`Workstation did not become ready at http://127.0.0.1:${port}/`)
  const url = `http://127.0.0.1:${port}/`
  console.log(`[workstation] Ready at ${url}`)
  openBrowser(url)
}

try {
  await ensureAssistantSidecar()
  await ensureBinanceLocalSidecar()
  console.log('[providers] Binance Local Archive is independent. Existing Binance Spot/USD-M providers are unchanged. FiinQuant and Vnstock remain lazy.')
  await startOrReuseWorkstation()
} catch (error) {
  console.error(`[launcher] ${error instanceof Error ? error.message : String(error)}`)
  shutdown(1)
}
