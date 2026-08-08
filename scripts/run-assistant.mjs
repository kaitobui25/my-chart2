import { existsSync, readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const assistantServerPath = path.join(ROOT, 'examples', 'sidecars', 'assistant', 'server.mjs')
const workstationConfigPath = path.join(ROOT, 'examples', 'workstation', 'vite.config.ts')
const fiinQuantDir = path.join(ROOT, 'examples', 'sidecars', 'fiinquant')
const fiinQuantEnvPath = path.join(fiinQuantDir, '.env')
const fiinQuantSidecarPath = path.join(fiinQuantDir, 'fiinquant_sidecar.py')
const fiinQuantRequirementsPath = path.join(fiinQuantDir, 'requirements.txt')
const fiinQuantProviderRequirementsPath = path.join(fiinQuantDir, 'requirements-provider.txt')
const fiinQuantVenvDir = path.join(fiinQuantDir, '.venv')
const ASSISTANT_HEALTH_URL = 'http://127.0.0.1:8788/health'
const WORKSTATION_URL = 'http://127.0.0.1:53173/'

if (!existsSync(viteBin)) {
  console.error('Missing node_modules. Run "npm install" once, then start this launcher again.')
  process.exit(1)
}

function readSimpleEnv(filePath) {
  if (!existsSync(filePath)) return {}
  const values = {}
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) values[key] = value
  }
  return values
}

const fiinQuantEnv = readSimpleEnv(fiinQuantEnvPath)
const fiinQuantPort = Number(fiinQuantEnv.PORT || process.env.PORT || 8720)
const resolvedFiinQuantPort = Number.isFinite(fiinQuantPort) ? fiinQuantPort : 8720
const fiinQuantBaseUrl = `http://127.0.0.1:${resolvedFiinQuantPort}`
const fiinQuantHealthUrl = `${fiinQuantBaseUrl}/health`
const fiinQuantSessionUrl = `${fiinQuantBaseUrl}/session`
const viteEnv = { ...process.env }
if (!viteEnv.FIINQUANT_SIDECAR_TOKEN && fiinQuantEnv.SIDECAR_TOKEN) {
  viteEnv.FIINQUANT_SIDECAR_TOKEN = fiinQuantEnv.SIDECAR_TOKEN
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

function commandSpec(command, prefixArgs = [], label = command) {
  return { command, prefixArgs, label }
}

function runSync(spec, args, options = {}) {
  return spawnSync(spec.command, [...spec.prefixArgs, ...args], {
    cwd: fiinQuantDir,
    stdio: 'ignore',
    windowsHide: true,
    ...options,
  })
}

function canRunPython(spec) {
  const result = runSync(spec, [
    '-c',
    'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)',
  ])
  return !result.error && result.status === 0
}

function hasFiinQuantDependencies(spec) {
  const result = runSync(spec, ['-c', 'import aiohttp; import FiinQuantX'])
  return !result.error && result.status === 0
}

function fiinQuantVenvPython() {
  return process.platform === 'win32'
    ? path.join(fiinQuantVenvDir, 'Scripts', 'python.exe')
    : path.join(fiinQuantVenvDir, 'bin', 'python')
}

function pythonCandidates() {
  const candidates = []
  if (process.env.FIINQUANT_PYTHON) {
    candidates.push(commandSpec(process.env.FIINQUANT_PYTHON, [], 'FIINQUANT_PYTHON'))
  }

  const venvPython = fiinQuantVenvPython()
  if (existsSync(venvPython)) candidates.push(commandSpec(venvPython, [], 'FiinQuant .venv'))

  if (process.env.VIRTUAL_ENV) {
    const activeVenvPython = process.platform === 'win32'
      ? path.join(process.env.VIRTUAL_ENV, 'Scripts', 'python.exe')
      : path.join(process.env.VIRTUAL_ENV, 'bin', 'python')
    if (existsSync(activeVenvPython)) candidates.push(commandSpec(activeVenvPython, [], 'active virtualenv'))
  }

  if (process.platform === 'win32') {
    candidates.push(commandSpec('py', ['-3.11'], 'Python 3.11 via py launcher'))
    candidates.push(commandSpec('python', [], 'python'))
  } else {
    candidates.push(commandSpec('python3.11', [], 'python3.11'))
    candidates.push(commandSpec('python3', [], 'python3'))
    candidates.push(commandSpec('python', [], 'python'))
  }

  const seen = new Set()
  return candidates.filter(candidate => {
    const key = JSON.stringify([candidate.command, candidate.prefixArgs])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function runChecked(spec, args) {
  const result = spawnSync(spec.command, [...spec.prefixArgs, ...args], {
    cwd: fiinQuantDir,
    stdio: 'inherit',
    windowsHide: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${spec.label} exited with code ${result.status ?? 'unknown'}`)
  }
}

function resolveFiinQuantPython() {
  for (const candidate of pythonCandidates()) {
    if (canRunPython(candidate) && hasFiinQuantDependencies(candidate)) {
      console.log(`[fiinquant] Using ${candidate.label}`)
      return candidate
    }
  }

  console.log('[fiinquant] Python dependencies are missing. Preparing examples/sidecars/fiinquant/.venv (first run only)...')
  const bootstrap = pythonCandidates().find(canRunPython)
  if (!bootstrap) {
    throw new Error('Python 3.11+ was not found. Install Python 3.11, then double-click open-ai-chart.bat again.')
  }

  const venvPython = fiinQuantVenvPython()
  if (!existsSync(venvPython)) {
    runChecked(bootstrap, ['-m', 'venv', fiinQuantVenvDir])
  }

  const venv = commandSpec(venvPython, [], 'FiinQuant .venv')
  runChecked(venv, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', fiinQuantRequirementsPath])
  runChecked(venv, [
    '-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', '-r', fiinQuantProviderRequirementsPath,
  ])

  if (!hasFiinQuantDependencies(venv)) {
    throw new Error('FiinQuant Python environment was created but aiohttp/FiinQuantX still cannot be imported.')
  }
  console.log('[fiinquant] Python environment ready.')
  return venv
}

async function readJson(url, options = {}) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(900),
      ...options,
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

async function waitForJsonHealth(url, headers = {}, attempts = 80) {
  for (let attempt = 0; attempt < attempts && !closing; attempt += 1) {
    const health = await readJson(url, { headers })
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
  health = await waitForJsonHealth(ASSISTANT_HEALTH_URL, {}, 40)
  if (!health?.ok) throw new Error(`Assistant sidecar did not become ready at ${ASSISTANT_HEALTH_URL}`)
}

function fiinQuantAuthHeaders(extra = {}) {
  return {
    ...extra,
    ...(fiinQuantEnv.SIDECAR_TOKEN
      ? { 'X-L2Chart-Sidecar-Token': fiinQuantEnv.SIDECAR_TOKEN }
      : {}),
  }
}

async function readFiinQuantHealth() {
  return readJson(fiinQuantHealthUrl, { headers: fiinQuantAuthHeaders() })
}

async function ensureFiinQuantSidecar() {
  let health = await readFiinQuantHealth()
  if (health?.ok) {
    console.log(`[fiinquant] Reusing sidecar at ${fiinQuantHealthUrl}`)
  } else {
    if (!existsSync(fiinQuantSidecarPath)) {
      throw new Error(`Missing FiinQuant sidecar: ${fiinQuantSidecarPath}`)
    }
    const python = resolveFiinQuantPython()
    console.log('[fiinquant] Starting sidecar...')
    spawnManaged(python.command, [...python.prefixArgs, fiinQuantSidecarPath], { cwd: fiinQuantDir })
    health = await waitForJsonHealth(fiinQuantHealthUrl, fiinQuantAuthHeaders())
  }

  if (!health?.ok) {
    throw new Error(`FiinQuant sidecar did not become ready at ${fiinQuantHealthUrl}`)
  }

  if (fiinQuantEnv.SIDECAR_TOKEN && health.tokenConfigured && health.authorized === false) {
    throw new Error('The running FiinQuant sidecar uses a different SIDECAR_TOKEN. Stop the old sidecar once, then launch again.')
  }

  return health
}

async function autoLoginFiinQuant(health) {
  const username = fiinQuantEnv.FIINQUANT_USERNAME
  const password = fiinQuantEnv.FIINQUANT_PASSWORD
  if (!username || !password) {
    console.warn('[fiinquant] FIINQUANT_USERNAME/PASSWORD are missing from examples/sidecars/fiinquant/.env; browser Sign in is still required.')
    return health
  }
  if (!fiinQuantEnv.SIDECAR_TOKEN) {
    throw new Error('SIDECAR_TOKEN is required in examples/sidecars/fiinquant/.env for one-click auto-login.')
  }
  if (health.loggedIn) {
    console.log('[fiinquant] Session already logged in.')
    return health
  }

  console.log('[fiinquant] Signing in from .env...')
  const response = await fetch(fiinQuantSessionUrl, {
    method: 'POST',
    headers: fiinQuantAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(30_000),
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    // Keep the HTTP status as the useful failure signal.
  }
  if (!response.ok) {
    throw new Error(`FiinQuant auto-login failed (${response.status}): ${payload?.message ?? response.statusText}`)
  }

  const nextHealth = await readFiinQuantHealth()
  if (!nextHealth?.loggedIn) {
    throw new Error('FiinQuant accepted the login request but the sidecar is not reporting a logged-in session.')
  }
  console.log('[fiinquant] Auto-login ready.')
  return nextHealth
}

async function workstationIsRunning() {
  try {
    const response = await fetch(WORKSTATION_URL, { signal: AbortSignal.timeout(900) })
    return response.ok
  } catch {
    return false
  }
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

try {
  await ensureAssistantSidecar()
  let fiinQuantHealth = await ensureFiinQuantSidecar()
  fiinQuantHealth = await autoLoginFiinQuant(fiinQuantHealth)

  if (!fiinQuantEnv.SIDECAR_TOKEN) {
    console.warn('[fiinquant] SIDECAR_TOKEN is missing from examples/sidecars/fiinquant/.env.')
  }

  if (await workstationIsRunning()) {
    console.log(`[workstation] Reusing dev server at ${WORKSTATION_URL}`)
    openBrowser(WORKSTATION_URL)
  } else {
    spawnManaged(process.execPath, [viteBin, '--config', workstationConfigPath, '--open'], {
      env: viteEnv,
    })
  }
} catch (error) {
  console.error(`[launcher] ${error instanceof Error ? error.message : String(error)}`)
  shutdown(1)
}
