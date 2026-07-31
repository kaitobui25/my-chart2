import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const serverPath = path.join(ROOT, 'examples', 'sidecars', 'assistant', 'server.mjs')
const configPath = path.join(ROOT, 'examples', 'workstation', 'vite.assistant.config.ts')

if (!existsSync(viteBin)) {
  console.error('Missing node_modules. Run "npm install" once, then start this launcher again.')
  process.exit(1)
}

const children = [
  spawn(process.execPath, [serverPath], { cwd: ROOT, stdio: 'inherit', windowsHide: false }),
  spawn(process.execPath, [viteBin, '--config', configPath, '--open'], { cwd: ROOT, stdio: 'inherit', windowsHide: false })
]

let closing = false
function shutdown(code = 0) {
  if (closing) return
  closing = true
  for (const child of children) {
    if (!child.killed) child.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
  }
  process.exitCode = code
}

for (const child of children) {
  child.on('exit', code => {
    if (!closing && code !== 0) shutdown(code ?? 1)
  })
  child.on('error', error => {
    console.error(error.message)
    shutdown(1)
  })
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
