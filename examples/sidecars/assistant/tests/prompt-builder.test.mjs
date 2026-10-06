import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt } from '../prompt-builder.mjs'

test('builds a symbol-aware prompt without duplicating native ChatGPT history', () => {
  const conversation = Array.from({ length: 20 }, (_, index) => ({ role: 'user', content: `m${index}` }))
  const prompt = buildPrompt({
    message: 'What now?',
    conversation,
    context: { symbol: 'HPG', timeframe: '15m', candles: [{ time: 1, open: 1, high: 2, low: 1, close: 2 }] }
  })
  assert.match(prompt, /HPG 15m/)
  assert.doesNotMatch(prompt, /m0/)
  assert.doesNotMatch(prompt, /m19/)
  assert.match(prompt, /easy to understand/)
  assert.match(prompt, /do not invent/i)
  assert.doesNotMatch(prompt, /screenshot/i)
  assert.doesNotMatch(prompt, /Required response shape/)
})

test('includes bounded local history when Codex owns the conversation context', () => {
  const conversation = Array.from({ length: 20 }, (_, index) => ({ role: 'user', content: `m${index}` }))
  const prompt = buildPrompt({
    message: 'What now?',
    conversation,
    includeConversation: true,
    context: { symbol: 'HPG', timeframe: '15m', candles: [] }
  })
  assert.doesNotMatch(prompt, /m0/)
  assert.match(prompt, /m19/)
  assert.match(prompt, /Recent conversation JSON/)
  assert.match(prompt, /Required response shape/)
})

test('includes requested extra timeframe data and missing-data errors', () => {
  const prompt = buildPrompt({
    message: 'Compare 5m and daily',
    conversation: [],
    context: {
      symbol: '7203.T',
      timeframe: '5m',
      candles: [],
      additionalTimeframes: [{ timeframe: '1d', candleCount: 0, candles: [], error: 'no daily data' }]
    }
  })
  assert.match(prompt, /additionalTimeframes/)
  assert.match(prompt, /no daily data/)
})

test('puts available requested timeframes before the user question', () => {
  const prompt = buildPrompt({
    message: 'xem được nến 15 phút ko',
    conversation: [],
    context: {
      symbol: '9984.T',
      timeframe: '1d',
      candleCount: 173,
      candles: [],
      additionalTimeframes: [{
        timeframe: '15m',
        candleCount: 92,
        candles: [{ time: 1, open: 1, high: 2, low: 1, close: 2 }]
      }]
    }
  })
  const summaryIndex = prompt.indexOf('15m: 92 structured candles available')
  const questionIndex = prompt.indexOf('User question: xem được nến 15 phút ko')
  assert.ok(summaryIndex >= 0)
  assert.ok(questionIndex > summaryIndex)
})
