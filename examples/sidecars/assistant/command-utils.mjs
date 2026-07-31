import { spawn, spawnSync } from 'node:child_process'

export function resolveCommand(command) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = spawnSync(locator, [command], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status !== 0) return null

  const candidates = String(result.stdout ?? '')
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean)

  if (process.platform === 'win32') {
    return candidates.find(item => /\.(?:cmd|bat|exe|com)$/i.test(item)) ?? candidates[0] ?? null
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
