import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexSessionStore } from '../codex-session-store.mjs'
import { CodexProvider } from '../codex-provider.mjs'
import { runCodexExec } from '../codex-exec-runner.mjs'

const CLIENT = '11111111-1111-4111-8111-111111111111'
const SECOND_CLIENT = '22222222-2222-4222-8222-222222222222'
const THREAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const fakeCli = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

async function withRuntime(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'l2chart-session-test-'))
  try { await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

function fakeSpawn(mode, trace) {
  return (_, args, options) => spawn(process.execPath, [fakeCli, ...args], {
    ...options,
    env: { ...process.env, FAKE_CODEX_MODE: mode ?? '', FAKE_CODEX_TRACE: trace ?? '' }
  })
}

function runner(trace, mode) {
  return args => runCodexExec({ ...args, spawnImpl: fakeSpawn(mode, trace) })
}

function provider(root, trace, mode) {
  return new CodexProvider({ runtimeRoot: root, runner: runner(trace, mode), available: () => true })
}

test('session IDs survive store recreation and New Chat clears only the requested client', async () => {
  await withRuntime(async root => {
    const store = new CodexSessionStore(root)
    await store.update(CLIENT, THREAD)
    await store.update(SECOND_CLIENT, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    const reloaded = new CodexSessionStore(root)
    assert.equal(await reloaded.get(CLIENT), THREAD)
    await reloaded.update(CLIENT, null)
    const afterReset = new CodexSessionStore(root)
    assert.equal(await afterReset.get(CLIENT), null)
    assert.equal(await afterReset.get(SECOND_CLIENT), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  })
})

test('corrupt session store fails instead of silently restarting history', async () => {
  await withRuntime(async root => {
    await writeFile(path.join(root, 'codex-sessions.json'), '{broken')
    await assert.rejects(new CodexSessionStore(root).get(CLIENT), SyntaxError)
  })
})

test('first turn starts a session; subsequent turns and restarted provider resume it', async () => {
  await withRuntime(async root => {
    const trace = path.join(root, 'trace.jsonl')
    const first = provider(root, trace)
    assert.deepEqual(await first.runChat({ clientSessionId: CLIENT, prompt: 'first question' }), { message: 'started' })
    assert.deepEqual(await first.runChat({ clientSessionId: CLIENT, prompt: 'second question' }), { message: 'resumed' })
    const restarted = provider(root, trace)
    assert.deepEqual(await restarted.runChat({ clientSessionId: CLIENT, prompt: 'third question' }), { message: 'resumed' })
    const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.length, 3)
    assert.equal(calls[0].args.includes('resume'), false)
    assert.equal(calls[1].args.includes('resume'), true)
    assert.equal(calls[1].sessionId, calls[0].sessionId)
    assert.equal(calls[2].sessionId, calls[0].sessionId)
    assert.deepEqual(await restarted.newConversation({ clientSessionId: CLIENT }), {
      sessionId: CLIENT, conversationId: null, selection: null
    })
    assert.deepEqual(await restarted.runChat({ clientSessionId: CLIENT, prompt: 'fresh question' }), { message: 'started' })
    assert.notEqual(await new CodexSessionStore(root).get(CLIENT), calls[0].sessionId)
  })
})

test('long Codex conversations keep the same native session beyond ten messages', async () => {
  await withRuntime(async root => {
    const visited = []
    const session = new CodexProvider({
      runtimeRoot: root,
      available: () => true,
      runner: async ({ sessionId }) => {
        visited.push(sessionId)
        return { sessionId: THREAD, response: { message: 'ok' } }
      }
    })
    for (let turn = 0; turn < 12; turn++) {
      assert.deepEqual(await session.runChat({ clientSessionId: CLIENT, prompt: `message ${turn}` }), { message: 'ok' })
    }
    assert.equal(visited[0], null)
    assert.ok(visited.slice(1).every(id => id === THREAD))
  })
})

test('simultaneous first reads cannot overwrite a newly persisted session', async () => {
  await withRuntime(async root => {
    const store = new CodexSessionStore(root)
    const pendingRead = store.get(CLIENT)
    const pendingWrite = store.update(SECOND_CLIENT, THREAD)
    await Promise.all([pendingRead, pendingWrite])
    assert.equal(await new CodexSessionStore(root).get(SECOND_CLIENT), THREAD)
  })
})

test('data query reply and continuation stay on the same native thread', async () => {
  await withRuntime(async root => {
    const trace = path.join(root, 'trace.jsonl')
    const codex = provider(root, trace)
    const first = await codex.runChat({ clientSessionId: CLIENT, prompt: 'request-rsi' })
    assert.equal(first.requests[0].tool, 'get_indicator')
    const next = await codex.runChat({ clientSessionId: CLIENT, prompt: 'Continue the pending chart question with RSI value 55.' })
    assert.deepEqual(next, { message: 'resumed' })
    const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls[0].sessionId, calls[1].sessionId)
  })
})

test('rejects overlapping requests on one client, but allows independent clients', async () => {
  await withRuntime(async root => {
    let finish
    const running = new Promise(resolve => { finish = resolve })
    const calls = []
    const codex = new CodexProvider({
      runtimeRoot: root,
      available: () => true,
      runner: async ({ sessionId }) => {
        calls.push(sessionId)
        await running
        return { sessionId: THREAD, response: { message: 'ok' } }
      }
    })
    const first = codex.runChat({ clientSessionId: CLIENT, prompt: 'first' })
    await assert.rejects(codex.runChat({ clientSessionId: CLIENT, prompt: 'duplicate' }), { code: 'CODEX_SESSION_BUSY' })
    await assert.rejects(codex.newConversation({ clientSessionId: CLIENT }), { code: 'CODEX_SESSION_BUSY' })
    const second = codex.runChat({ clientSessionId: SECOND_CLIENT, prompt: 'independent' })
    finish()
    assert.deepEqual(await Promise.all([first, second]), [{ message: 'ok' }, { message: 'ok' }])
    assert.equal(calls.length, 2)
  })
})

test('failed or invalid Codex responses never bind a new session', async () => {
  await withRuntime(async root => {
    for (const mode of ['failed', 'bad-response', 'incomplete', 'mismatch']) {
      const session = provider(root, null, mode)
      if (mode === 'mismatch') {
        await session.store.update(CLIENT, THREAD)
      }
      await assert.rejects(session.runChat({ clientSessionId: CLIENT, prompt: 'check failure' }))
      assert.equal(await new CodexSessionStore(root).get(CLIENT), mode === 'mismatch' ? THREAD : null)
      if (mode === 'mismatch') await session.newConversation({ clientSessionId: CLIENT })
    }
  })
})

test('cancelling the subprocess rejects the turn and leaves session unbound', async () => {
  await withRuntime(async root => {
    const session = provider(root, null, 'sleep')
    let cancel
    const pending = session.runChat({ clientSessionId: CLIENT, prompt: 'long running', onStart: handle => { cancel = handle.cancel } })
    // onStart is called after spawning the child.
    for (let attempts = 0; !cancel && attempts < 20; attempts++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(typeof cancel, 'function')
    cancel()
    await assert.rejects(pending)
    assert.equal(await new CodexSessionStore(root).get(CLIENT), null)
  })
})
