import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findBundledCodex } from '../command-utils.mjs'

test('finds Codex bundled with the newest OpenAI VS Code extension', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'l2chart-command-utils-'))
  const older = path.join(homeDir, '.vscode', 'extensions', 'openai.chatgpt-1.9.0', 'bin', 'windows-x86_64', 'codex.exe')
  const newer = path.join(homeDir, '.vscode', 'extensions', 'openai.chatgpt-1.10.0', 'bin', 'windows-x86_64', 'codex.exe')

  try {
    await mkdir(path.dirname(older), { recursive: true })
    await mkdir(path.dirname(newer), { recursive: true })
    await writeFile(older, '')
    await writeFile(newer, '')

    assert.equal(findBundledCodex({ homeDir, platform: 'win32', architecture: 'x64' }), newer)
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})
