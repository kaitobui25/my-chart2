import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../../../chatgpt-extension/content.js', import.meta.url), 'utf8')
  .replace('  const runtimeListener =', `
    globalThis.reasoningTest = {
      selectModelSettings, handleSend, inspectCurrentModelEfforts,
      configure(mock) {
        composer = mock.composer;
        visible = mock.visible;
        waitFor = mock.waitFor;
        pickerAccess = mock.pickerAccess;
        generating = () => false;
        insertPrompt = mock.insertPrompt;
      }
    };
    const runtimeListener =`)

function harness({ supported = ['none', 'medium', 'high'], changeModel = false, confirmClose = true, readableRange = true } = {}) {
  let effort = 'medium'
  let model = 'GPT-6'
  let inserted = false
  let opened = false
  let steps = 0
  const row = { get textContent() { return model } }
  const trigger = {
    focus() {},
    dispatchEvent: () => { opened = true },
    getAttribute: () => effort,
  }
  const control = {
    getAttribute: () => 'ArrowLeft ArrowRight',
    focus() {},
    dispatchEvent(event) {
      steps += 1
      const next = supported.indexOf(effort) + (event.key === 'ArrowRight' ? 1 : -1)
      effort = supported[Math.min(supported.length - 1, Math.max(0, next))]
      if (changeModel) model = effort === 'high' ? 'Another model' : 'GPT-6'
    },
  }
  const slider = { getAttribute: name => String(name === 'aria-valuenow'
    ? supported.indexOf(effort) : name === 'aria-valuemin' ? 0 : supported.length - 1) }
  const panel = {
    querySelector: () => readableRange ? slider : null,
    querySelectorAll: selector => selector.includes('menuitemradio') ? [row] : [control],
  }
  const form = { querySelectorAll: () => [trigger] }
  const context = vm.createContext({
    location: { pathname: '/' },
    document: { querySelector: () => opened ? panel : null },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    KeyboardEvent: class { constructor(_type, options) { this.key = options.key } },
  })
  vm.runInContext(source, context)
  context.reasoningTest.configure({
    composer: () => ({ closest: () => form }),
    visible: node => Boolean(node),
    waitFor: async (read, _timeout, current) => current() ? await read() : null,
    pickerAccess: () => ({ close: async () => { opened = false; return confirmClose } }),
    insertPrompt: () => { inserted = true; return { ok: true } },
  })
  return { api: context.reasoningTest, state: () => ({ effort, model, inserted, opened, steps }) }
}

test('ChatGPT current applies High within the current model and confirms it after closing the picker', async () => {
  const h = harness()
  const result = await h.api.selectModelSettings(null, 'high', () => true)
  assert.equal(result.ok, true)
  assert.equal(result.selection.reasoningEffort, 'high')
  assert.equal(result.selection.model, 'GPT-6')
  assert.deepEqual(h.state(), { effort: 'high', model: 'GPT-6', inserted: false, opened: false, steps: 1 })
  assert.equal((await h.api.selectModelSettings(null, 'medium', () => true)).ok, true)
  assert.equal(h.state().effort, 'medium')
})

test('unsupported High aborts Send before inserting a prompt instead of silently using Medium', async () => {
  const h = harness({ supported: ['none', 'medium'] })
  const result = await h.api.handleSend({ requestId: 'test-request', conversationId: null, model: null, reasoningEffort: 'high', prompt: 'test' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'requested_reasoning_unavailable')
  assert.equal(h.state().effort, 'medium')
  assert.equal(h.state().inserted, false)
  assert.equal(h.state().opened, false)
})

test('does not accept an effort change that switches to another model', async () => {
  const h = harness({ changeModel: true })
  assert.equal((await h.api.selectModelSettings(null, 'high', () => true)).ok, false)
  assert.equal(h.state().model, 'GPT-6')
  assert.equal(h.state().effort, 'medium')
})

test('restores the original native effort when the requested effort is beyond the supported range', async () => {
  const h = harness()
  assert.equal((await h.api.selectModelSettings(null, 'ultra', () => true)).ok, false)
  assert.equal(h.state().effort, 'medium')
})

test('does not accept a selection unless the native picker closes successfully', async () => {
  const h = harness({ confirmClose: false })
  assert.equal((await h.api.selectModelSettings(null, 'high', () => true)).ok, false)
})

test('leaves the native picker alone only when neither model nor effort is requested', async () => {
  const h = harness()
  assert.equal((await h.api.selectModelSettings(null, null, () => true)).ok, true)
  assert.equal(h.state().steps, 0)
  assert.equal(h.state().opened, false)
})

test('lists only observed native power levels and restores the initial model and effort', async () => {
  const h = harness()
  const result = await h.api.inspectCurrentModelEfforts(() => true)
  assert.equal(result.ok, true)
  assert.deepEqual([...result.reasoningEfforts], ['none', 'medium', 'high'])
  assert.equal(result.currentReasoningEffort, 'medium')
  assert.equal(h.state().effort, 'medium')
  assert.equal(h.state().model, 'GPT-6')
  assert.equal(h.state().opened, false)
  assert.equal(h.state().inserted, false)
})

test('does not invent a reasoning list when native Power bounds cannot be read', async () => {
  const h = harness({ readableRange: false })
  const result = await h.api.inspectCurrentModelEfforts(() => true)
  assert.equal(result.ok, false)
  assert.equal(result.reasoningEfforts, undefined)
  assert.equal(h.state().effort, 'medium')
  assert.equal(h.state().opened, false)
})
