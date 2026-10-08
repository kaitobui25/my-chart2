import test from 'node:test'
import assert from 'node:assert/strict'
import { selectPromptMode } from '../prompt-mode.mjs'

test('ChatGPT sends a full prompt once and a compact prompt in a bound conversation', () => {
  assert.deepEqual(selectPromptMode({
    provider: 'chatgpt', hasConversation: false, conversation: [], toolResults: []
  }), { mode: 'full', resetNativeConversation: false })
  assert.deepEqual(selectPromptMode({
    provider: 'chatgpt', hasConversation: true, conversation: [{ role: 'user', content: 'hi' }], toolResults: []
  }), { mode: 'followUp', resetNativeConversation: false })
})

test('tool results continue the same ChatGPT conversation even before local history is committed', () => {
  assert.deepEqual(selectPromptMode({
    provider: 'chatgpt', hasConversation: true, conversation: [], toolResults: [{ ok: true }]
  }), { mode: 'toolContinuation', resetNativeConversation: false })
})

test('unbound tool results keep the full question and data after a lost session', () => {
  assert.deepEqual(selectPromptMode({
    provider: 'chatgpt', hasConversation: false, conversation: [], toolResults: [{ ok: true }]
  }), { mode: 'full', resetNativeConversation: false })
})

test('workstation reload resets an orphaned ChatGPT binding, while New Chat starts full', () => {
  assert.deepEqual(selectPromptMode({
    provider: 'chatgpt', hasConversation: true, conversation: [], toolResults: []
  }), { mode: 'full', resetNativeConversation: true })
  assert.deepEqual(selectPromptMode({
    provider: 'chatgpt', hasConversation: false, conversation: [], toolResults: []
  }), { mode: 'full', resetNativeConversation: false })
})

test('Codex uses the resumed native session without resetting an empty local transcript', () => {
  assert.deepEqual(selectPromptMode({
    provider: 'codex', hasConversation: true, conversation: [], toolResults: []
  }), { mode: 'followUp', resetNativeConversation: false })
  assert.deepEqual(selectPromptMode({
    provider: 'codex', hasConversation: true, conversation: [], toolResults: [{ ok: true }]
  }), { mode: 'toolContinuation', resetNativeConversation: false })
})
