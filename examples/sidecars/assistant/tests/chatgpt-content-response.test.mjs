import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../../../chatgpt-extension/content.js', import.meta.url), 'utf8')
  .replace('  const runtimeListener =', '  globalThis.responseTest = { assistantDomMessages };\n  const runtimeListener =')

test('recognizes a completed short reply in the current ChatGPT DOM without including the role heading', () => {
  const turn = {
    querySelector: selector => selector.includes('[aria-label="Regenerate response"]') ? {} : null,
  }
  const node = {
    isConnected: true,
    innerText: 'ChatGPT said:\n\n7203.T — 15m',
    closest: () => turn,
    getAttribute: name => name === 'data-chatgpt-search-message-ids' ? 'assistant-id assistant-id' : null,
    querySelector: selector => selector.includes('[data-markdown-text-style="assistant-message"]')
      ? { innerText: '7203.T — 15m' } : null,
  }
  const context = vm.createContext({
    document: { querySelectorAll: () => [node] },
    chrome: { runtime: { onMessage: { addListener() {} } } },
  })
  vm.runInContext(source, context)
  const result = vm.runInContext('responseTest.assistantDomMessages()', context)
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 'assistant-id')
  assert.equal(result[0].text, '7203.T — 15m')
  assert.equal(result[0].completed, true)
})
