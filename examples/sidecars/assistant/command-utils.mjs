import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function findBundledCodex({
  homeDir = os.homedir(),
  platform = process.platform,
  architecture = process.arch
} = {}) {
  if (platform !== 'win32') return null

  const runtime = architecture === 'arm64' ? 'windows-arm64' : 'windows-x86_64'
  const extensionRoots = [
    path.join(homeDir, '.vscode', 'extensions'),
    path.join(homeDir, '.vscode-insiders', 'extensions'),
    path.join(homeDir, '.cursor', 'extensions')
  ]

  for (const root of extensionRoots) {
    let extensions
    try {
      extensions = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }

    const openaiExtensions = extensions
      .filter(entry => entry.isDirectory() && /^openai\.chatgpt-/i.test(entry.name))
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))

    for (const extension of openaiExtensions) {
      const executable = path.join(root, extension.name, 'bin', runtime, 'codex.exe')
      if (existsSync(executable)) return executable
    }
  }

  return null
}

export function resolveCommand(command) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = spawnSync(locator, [command], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status !== 0) {
    return command.toLowerCase() === 'codex' ? findBundledCodex() : null
  }

  const candidates = String(result.stdout ?? '')
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean)

  if (process.platform === 'win32') {
    return candidates.find(item => /\.(?:cmd|bat|exe|com)$/i.test(item)) ?? candidates[0] ?? findBundledCodex()
  }
  return candidates[0] ?? null
}

export function commandExists(command) {
  return resolveCommand(command) !== null
}

function quoteWindowsArg(value) {
  const text = String(value)
  return `"${text.replace(/"/g, '""').replace(/%/g, '%%')}"`
}

function buildWindowsCommand(executable, args = []) {
  const commandLine = [quoteWindowsArg(executable), ...args.map(quoteWindowsArg)].join(' ')
  return `"${commandLine}"`
}

export function spawnCommand(command, args, options = {}) {
  const executable = resolveCommand(command)
  if (executable === null) {
    const error = new Error(`${command} was not found in PATH.`)
    error.code = 'ENOENT'
    throw error
  }

  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    return spawn(process.env.ComSpec ?? 'cmd.exe', [
      '/d',
      '/s',
      '/c',
      buildWindowsCommand(executable, args)
    ], {
      ...options,
      windowsVerbatimArguments: true
    })
  }

  return spawn(executable, args, options)
}
