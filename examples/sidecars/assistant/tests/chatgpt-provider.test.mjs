import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ChatGptProvider,
  normalizeChatGptModelCatalog
} from '../chatgpt-provider.mjs'

const CLIENT_SESSION_ID = '11111111-1111-4111-8111-111111111111'

test('normalizes the native ChatGPT model catalog without inventing efforts', () => {
  const models = normalizeChatGptModelCatalog({
    models: [
      {
        id: 'gpt-5.6',
        label: 'GPT-5.6 Sol',
        efforts: ['medium', 'high', 'max', 'invented'],
        aliases: ['gpt-5.6-thinking', 'gpt-5.6-thinking']
      },
      { id: 'bad/id', label: 'Bad', efforts: ['high'] }
    ]
  })
  assert.deepEqual(models, [{
    id: 'gpt-5.6',
    label: 'GPT-5.6 Sol',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['medium', 'high', 'max'],
    aliases: ['gpt-5.6-thinking']
  }])
})

test('binds the first native conversation and reuses it on the next turn', async () => {
  const commands = []
  const bridge = {
    status: () => ({ connected: true }),
    dispatch(type, payload) {
      commands.push({ type, payload })
      if (type !== 'chat_send') throw new Error('unexpected command')
      const first = commands.filter(command => command.type === 'chat_send').length === 1
      return {
        id: 'command-' + commands.length,
        cancel: () => true,
        promise: Promise.resolve({
          conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          message: first ? 'first answer' : 'second answer',
          selection: { model: 'gpt-5.6-thinking', reasoningEffort: 'high' }
        })
      }
    }
  }
  const provider = new ChatGptProvider(bridge)
  assert.deepEqual(await provider.runChat({
    clientSessionId: CLIENT_SESSION_ID,
    requestId: 'request-one',
    model: 'gpt-5.6',
    reasoningEffort: 'high',
    prompt: 'first'
  }), { message: 'first answer' })
  assert.equal(commands[0].payload.conversationId, null)

  assert.deepEqual(await provider.runChat({
    clientSessionId: CLIENT_SESSION_ID,
    requestId: 'request-two',
    model: 'gpt-5.6',
    reasoningEffort: 'high',
    prompt: 'second'
  }), { message: 'second answer' })
  assert.equal(commands[1].payload.conversationId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
})

test('keeps ChatGPT current independent from the native model picker', async () => {
  const commands = []
  const bridge = {
    status: () => ({ connected: true }),
    dispatch(type, payload) {
      commands.push({ type, payload })
      return {
        id: 'command-current',
        cancel: () => true,
        promise: Promise.resolve({
          conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          message: 'ok',
          selection: null
        })
      }
    }
  }
  const provider = new ChatGptProvider(bridge)
  await provider.runChat({
    clientSessionId: CLIENT_SESSION_ID,
    requestId: 'request-current',
    model: null,
    reasoningEffort: 'medium',
    prompt: 'test'
  })
  assert.equal(commands[0].type, 'chat_send')
  assert.equal(commands[0].payload.model, null)
  assert.equal(commands[0].payload.reasoningEffort, null)
})

test('scopes native status reads to the requesting client session', async () => {
  const commands = []
  const bridge = {
    status: () => ({ connected: true }),
    dispatch(type, payload) {
      commands.push({ type, payload })
      return {
        id: 'status-command',
        cancel: () => true,
        promise: Promise.resolve({ conversationId: null, selection: null })
      }
    }
  }
  const provider = new ChatGptProvider(bridge)
  await provider.status({ clientSessionId: CLIENT_SESSION_ID })
  assert.equal(commands[0].type, 'status')
  assert.equal(commands[0].payload.sessionId, CLIENT_SESSION_ID)
})

test('resets the bound conversation only after the browser confirms New', async () => {
  let resolveNew
  const bridge = {
    status: () => ({ connected: true }),
    dispatch(type) {
      assert.equal(type, 'new_chat')
      return {
        id: 'new-command',
        cancel: () => true,
        promise: new Promise(resolve => { resolveNew = resolve })
      }
    }
  }
  const provider = new ChatGptProvider(bridge)
  const state = provider.stateFor(CLIENT_SESSION_ID)
  state.conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const originalGeneration = state.generation
  const pending = provider.newConversation({
    clientSessionId: CLIENT_SESSION_ID,
    model: 'gpt-5.6',
    reasoningEffort: 'high'
  })
  assert.equal(state.conversationId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  assert.equal(state.generation, originalGeneration)
  resolveNew({ selection: { model: 'gpt-5.6-thinking', reasoningEffort: 'high' } })
  const result = await pending
  assert.equal(state.conversationId, null)
  assert.equal(state.generation, originalGeneration + 1)
  assert.equal(result.sessionId, CLIENT_SESSION_ID)
  assert.equal(result.conversationId, null)
})
