import test from 'node:test'
import assert from 'node:assert/strict'
import { ChatGptExtensionBridge } from '../chatgpt-bridge.mjs'

const EXTENSION_ID = 'a'.repeat(32)
const OTHER_EXTENSION_ID = 'b'.repeat(32)

test('delivers a command to the connected extension and resolves its result', async () => {
  const bridge = new ChatGptExtensionBridge({ pollTimeoutMs: 500 })
  const poll = bridge.poll(EXTENSION_ID)
  const handle = bridge.dispatch('chat_send', { requestId: 'request-1' })
  const command = await poll
  assert.equal(command.id, handle.id)
  assert.equal(command.type, 'chat_send')
  assert.deepEqual(command.payload, { requestId: 'request-1' })
  assert.equal(bridge.complete(EXTENSION_ID, command.id, { ok: true, data: { message: 'ok' } }), true)
  assert.deepEqual(await handle.promise, { message: 'ok' })
})

test('refuses dispatch while the extension is offline', () => {
  const bridge = new ChatGptExtensionBridge()
  assert.throws(
    () => bridge.dispatch('chat_send', {}),
    error => error?.code === 'CHATGPT_EXTENSION_OFFLINE' && error?.status === 503
  )
})

test('cancels queued work and ignores a late extension result', async () => {
  const bridge = new ChatGptExtensionBridge()
  bridge.touch(EXTENSION_ID)
  const handle = bridge.dispatch('chat_send', { requestId: 'request-2' })
  assert.equal(handle.cancel(), true)
  await assert.rejects(handle.promise, error => error?.code === 'ASSISTANT_CANCELLED')
  assert.equal(bridge.complete(EXTENSION_ID, handle.id, { ok: true, data: { message: 'late' } }), false)
  assert.equal(await bridge.poll(EXTENSION_ID, { timeoutMs: 10 }), null)
})

test('expires extension liveness and permits a new extension after expiry', () => {
  let now = 100
  const bridge = new ChatGptExtensionBridge({ connectedTtlMs: 50, now: () => now })
  bridge.touch(EXTENSION_ID)
  assert.equal(bridge.status().connected, true)
  assert.throws(
    () => bridge.touch(OTHER_EXTENSION_ID),
    error => error?.code === 'EXTENSION_CONFLICT'
  )
  now = 151
  assert.equal(bridge.status().connected, false)
  bridge.touch(OTHER_EXTENSION_ID)
  assert.equal(bridge.status().extensionId, OTHER_EXTENSION_ID)
})
