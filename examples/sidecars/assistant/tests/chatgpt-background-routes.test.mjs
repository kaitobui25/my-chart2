import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../../../chatgpt-extension/background.js', import.meta.url), 'utf8')

function backgroundHarness() {
  const removed = []
  const context = vm.createContext({
    URL,
    fetch: () => new Promise(() => {}),
    chrome: {
      runtime: { id: 'a'.repeat(32), onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      tabs: {
        get: async id => ({ id, url: 'https://chatgpt.com/plugins' }),
        remove: async id => removed.push(id),
      },
    },
  })
  vm.runInContext(source, context)
  return { context, removed }
}

test('only composer routes can be reused as a ChatGPT conversation tab', () => {
  const { context } = backgroundHarness()
  const accepts = url => vm.runInContext(`isChatUrl(${JSON.stringify(url)})`, context)
  for (const path of ['/', '/c/12345678-abcd', '/g/example', '/g/example/c/12345678-abcd']) {
    assert.equal(accepts(`https://chatgpt.com${path}`), true)
  }
  for (const path of ['/plugins', '/auth/login', '/images', '/share/12345678-abcd']) {
    assert.equal(accepts(`https://chatgpt.com${path}`), false)
  }
  assert.equal(accepts('https://example.com/'), false)
})

test('does not close a formerly owned chat tab after the user navigates to Plugins', async () => {
  const { context, removed } = backgroundHarness()
  await vm.runInContext('closeOwnedTab({tabId: 42})', context)
  assert.deepEqual(removed, [])
})
