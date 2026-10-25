import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../../../chatgpt-extension/content.js', import.meta.url), 'utf8')

function contentHarness({ loggedOut = false, hidden = false } = {}) {
  let listener
  const form = {
    isConnected: true,
    parentElement: null,
    closest: () => hidden ? {} : null,
    getClientRects: () => [1],
  }
  const context = vm.createContext({
    chrome: { runtime: { onMessage: {
      addListener: (value) => { listener = value },
      removeListener: () => {},
    } } },
    document: { querySelectorAll: (selector) => {
      assert.match(selector, /data-logged-out|unauth-mweb/)
      return loggedOut ? [form] : []
    } },
    location: { pathname: '/' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  })
  vm.runInContext(source, context)
  return (type) => new Promise(resolve => listener({ type }, {}, resolve))
}

test('logged-out ChatGPT rejects chart commands immediately, without trying to send a guest prompt', async () => {
  const command = contentHarness({ loggedOut: true })
  for (const type of ['prepare', 'models', 'status', 'send']) {
    const result = await command(`l2chart:${type}`)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'chatgpt_login_required')
  }
})

test('bridge ping and cancel remain available while logged out', async () => {
  const command = contentHarness({ loggedOut: true })
  assert.equal((await command('l2chart:ping')).ok, true)
  const cancel = await command('l2chart:cancel')
  assert.equal(cancel.ok, true)
  assert.equal(cancel.cancelled, false)
})

test('a hidden logged-out form does not block commands on an authenticated page', async () => {
  const command = contentHarness({ loggedOut: true, hidden: true })
  assert.equal((await command('l2chart:send')).error, 'invalid_request_id')
})
