import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt } from '../prompt-builder.mjs'

test('builds a symbol-aware prompt with bounded conversation', () => {
  const conversation = Array.from({ length: 20 }, (_, index) => ({ role: 'user', content: `m${index}` }))
  const prompt = buildPrompt({
    mode: 'chat',
    message: 'What now?',
    conversation,
    context: { symbol: 'HPG', timeframe: '15m', candles: [{ time: 1, open: 1, high: 2, low: 1, close: 2 }] }
  })
  assert.match(prompt, /HPG 15m/)
  assert.doesNotMatch(prompt, /m0/)
  assert.match(prompt, /m19/)
})
