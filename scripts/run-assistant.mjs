import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const assistantServerPath = path.join(ROOT, 'examples', 'sidecars', 'assistant', 'server.mjs')
const workstationConfigPath = path.join(ROOT, 'examples', 'workstation', 'vite.config.ts')
const fiinQuantDir = path.join(ROOT, 'examples', 'sidecars', 'fiinquant')
const fiinQuantEnvPath = path.join(fiinQuantDir, '.env')
const fiinQuantLauncherPath = path.join(fiinQuantDir, 'run_autologin.py')

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
const fiinQuantHealthUrl = `http://127.0.0.1:${Number.isFinite(fiinQuantPort) ? fiinQuantPort : 8720}/health`
const pythonCommand = process.env.FIINQUANT_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
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

async function readFiinQuantHealth() {
  try {
    const response = await fetch(fiinQuantHealthUrl, { signal: AbortSignal.timeout(800) })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

async function waitForFiinQuantSidecar() {
  for (let attempt = 0; attempt < 80 && !closing; attempt += 1) {
    const health = await readFiinQuantHealth()
    if (health?.ok) return health
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return null
}

spawnManaged(process.execPath, [assistantServerPath])

let fiinQuantHealth = await readFiinQuantHealth()
if (fiinQuantHealth?.ok) {
  console.log(`[fiinquant] Reusing sidecar at ${fiinQuantHealthUrl}`)
} else {
  if (!existsSync(fiinQuantLauncherPath)) {
    console.error(`Missing FiinQuant launcher: ${fiinQuantLauncherPath}`)
    shutdown(1)
  } else {
    console.log('[fiinquant] Starting sidecar and signing in from .env...')
    spawnManaged(pythonCommand, [fiinQuantLauncherPath], { cwd: fiinQuantDir })
    fiinQuantHealth = await waitForFiinQuantSidecar()
  }
}

if (closing) process.exit(process.exitCode ?? 1)

if (!fiinQuantHealth?.ok) {
  console.error(`[fiinquant] Sidecar did not become ready at ${fiinQuantHealthUrl}`)
  shutdown(1)
  process.exit(process.exitCode ?? 1)
}

if (fiinQuantEnv.FIINQUANT_USERNAME && fiinQuantEnv.FIINQUANT_PASSWORD) {
  if (fiinQuantHealth.loggedIn) {
    console.log('[fiinquant] Auto-login ready.')
  } else {
    console.warn('[fiinquant] Auto-login failed. Check FIINQUANT_USERNAME/PASSWORD in examples/sidecars/fiinquant/.env.')
  }
} else {
  console.warn('[fiinquant] FIINQUANT_USERNAME/PASSWORD are missing from examples/sidecars/fiinquant/.env; browser Sign in is still required.')
}

if (!fiinQuantEnv.SIDECAR_TOKEN) {
  console.warn('[fiinquant] SIDECAR_TOKEN is missing from examples/sidecars/fiinquant/.env.')
}

spawnManaged(process.execPath, [viteBin, '--config', workstationConfigPath, '--open'], {
  env: viteEnv,
})

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
