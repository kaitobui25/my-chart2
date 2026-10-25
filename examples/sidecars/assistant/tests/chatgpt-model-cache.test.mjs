import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../../../chatgpt-extension/background.js', import.meta.url), 'utf8')
function harness(storage = {}) {
  let calls = 0
  let now = 1000
  let failure = false
  const context = vm.createContext({
    URL, Date: { now: () => now },
    fetch: () => new Promise(() => {}),
    inspect: async () => {
      calls++
      if (failure) throw new Error('login_required')
      return { models: [], reasoningEfforts: ['medium', 'high'] }
    },
    chrome: {
      runtime: { id: 'a'.repeat(32), onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      storage: { local: {
        get: async key => ({ [key]: storage[key] }),
        set: async values => Object.assign(storage, values),
      } },
    },
  })
  vm.runInContext(source, context)
  vm.runInContext('inspectModelsTab = inspect', context)
  return {
    load: (refresh = false) => vm.runInContext(`processModels({refresh:${refresh}})`, context),
    calls: () => calls,
    expire: () => { now += 24 * 60 * 60 * 1000 },
    fail: () => { failure = true },
  }
}

test('catalog persists across worker restarts and refreshes only after 24 hours', async () => {
  const storage = {}
  const first = harness(storage)
  await Promise.all([first.load(), first.load(), first.load()])
  assert.equal(first.calls(), 1)
  const restarted = harness(storage)
  await restarted.load()
  assert.equal(restarted.calls(), 0)
  restarted.expire()
  await restarted.load()
  assert.equal(restarted.calls(), 1)
  await restarted.load(true)
  assert.equal(restarted.calls(), 2)
})

test('failed inspection is cached without fabricated options; manual refresh retries', async () => {
  const h = harness()
  h.fail()
  await assert.rejects(h.load(), /login_required/)
  await assert.rejects(h.load(), /login_required/)
  assert.equal(h.calls(), 1)
  await assert.rejects(h.load(true), /login_required/)
  assert.equal(h.calls(), 2)
})
