import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { commandExists, spawnCommand } from './command-utils.mjs'
import { parseResponse, responseSchemaFor } from './response-schema.mjs'

const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])

function normalizeModel(value) {
  if (value == null || value === '') return null
  const text = String(value).trim()
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(text) ? text : null
}

function normalizeEffort(value) {
  const effort = String(value ?? '').toLowerCase()
  return REASONING_EFFORTS.has(effort) ? effort : 'medium'
}

export function codexAvailable() {
  return commandExists('codex')
}

function terminate(child) {
  if (!child || child.killed) return
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    return
  }
  child.kill('SIGTERM')
}

export async function runCodex({ runtimeRoot, mode, model, reasoningEffort, prompt, screenshotDataUrl, onStart }) {
  if (!codexAvailable()) {
    const error = new Error('Codex CLI was not found. Install Codex CLI and sign in with ChatGPT.')
    error.code = 'CODEX_UNAVAILABLE'
    throw error
  }

  await mkdir(runtimeRoot, { recursive: true })
  const requestDir = await mkdtemp(path.join(os.tmpdir(), 'l2chart-codex-'))
  const schemaPath = path.join(requestDir, 'response-schema.json')
  const outputPath = path.join(requestDir, 'response.json')
  const imagePath = path.join(requestDir, 'chart.png')
  await writeFile(schemaPath, JSON.stringify(responseSchemaFor(mode)), 'utf8')

  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--color', 'never',
    '-C', runtimeRoot,
    '--output-schema', schemaPath,
    '--output-last-message', outputPath
  ]
  const selectedModel = normalizeModel(model)
  if (selectedModel) args.push('--model', selectedModel)
  args.push('--config', `model_reasoning_effort="${normalizeEffort(reasoningEffort)}"`)

  if (typeof screenshotDataUrl === 'string' && screenshotDataUrl.startsWith('data:image/png;base64,')) {
    const base64 = screenshotDataUrl.slice('data:image/png;base64,'.length)
    await writeFile(imagePath, Buffer.from(base64, 'base64'))
    args.push('--image', imagePath)
  }
  args.push('-')

  let child
  try {
    await new Promise((resolve, reject) => {
      child = spawnCommand('codex', args, {
        cwd: runtimeRoot,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe']
      })
      onStart?.({ child, cancel: () => terminate(child) })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', reject)
      child.on('exit', code => {
        if (code === 0) resolve()
        else {
          const error = new Error(stderr.trim() || `Codex exited with code ${code}.`)
          error.code = 'CODEX_FAILED'
          reject(error)
        }
      })
      child.stdin.end(prompt)
    })
    return parseResponse(await readFile(outputPath, 'utf8'), mode)
  } finally {
    await rm(requestDir, { recursive: true, force: true })
  }
}
