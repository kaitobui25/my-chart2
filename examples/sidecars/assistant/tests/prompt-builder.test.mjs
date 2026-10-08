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

test('native Codex session uses structured output without duplicating local conversation', () => {
  const conversation = Array.from({ length: 20 }, (_, index) => ({ role: 'user', content: `m${index}` }))
  const prompt = buildPrompt({
    message: 'What now?',
    conversation,
    structuredResponse: true,
    context: { symbol: 'HPG', timeframe: '15m', candles: [] }
  })
  assert.doesNotMatch(prompt, /m0/)
  assert.doesNotMatch(prompt, /m19/)
  assert.doesNotMatch(prompt, /Recent conversation JSON/)
  assert.match(prompt, /Required response shape/)
})

test('Codex data follow-up does not repeat the original question or chart context', () => {
  const prompt = buildPrompt({
    message: 'What is RSI?',
    context: { symbol: 'FPT', timeframe: '1d', candles: [{ close: 123 }] },
    mode: 'toolContinuation',
    structuredResponse: true,
    toolResults: [{ request: { tool: 'get_indicator', id: 'rsi' }, ok: true, values: [55] }]
  })
  assert.match(prompt, /Continue answering the pending chart question/)
  assert.match(prompt, /"values":\[55\]/)
  assert.doesNotMatch(prompt, /What is RSI\? /)
  assert.doesNotMatch(prompt, /"candles"/)
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

test('follow-up omits setup rules and all candle snapshots but keeps fresh chart metadata', () => {
  const context = {
    symbol: '7203.T', timeframe: '15m', mode: 'candles',
    replay: { phase: 'paused' }, visibleRange: { from: 101, to: 202 },
    candleCount: 1, candles: [{ time: 202, open: 1, high: 2, low: 1, close: 2 }],
    additionalTimeframes: [{ timeframe: '1h', candleCount: 1, candles: [{ time: 201, open: 8, high: 9, low: 7, close: 8 }] }]
  }
  const prompt = buildPrompt({ message: 'Thế 1h thì sao?', mode: 'followUp', context })
  assert.match(prompt, /Current chart: 7203\.T 15m/)
  assert.match(prompt, /User question: Thế 1h thì sao/)
  assert.match(prompt, /request get_candles or get_indicator/)
  assert.match(prompt, /"phase":"paused"/)
  assert.match(prompt, /"visibleRange":\{"from":101,"to":202\}/)
  assert.match(prompt, /"candleCount":1/)
  assert.doesNotMatch(prompt, /"candles":/)
  assert.doesNotMatch(prompt, /"additionalTimeframes":/)
  assert.doesNotMatch(prompt, /"open":1|"open":8/)
  assert.doesNotMatch(prompt, /structured candles available/)
  assert.doesNotMatch(prompt, /Answer only what the user asked/)
  assert.doesNotMatch(prompt, /Read-only chart data tools/)
  assert.ok(prompt.length < buildPrompt({ message: 'Thế 1h thì sao?', context }).length)
})

test('ChatGPT tool continuation only includes new tool results and no chart snapshot', () => {
  const prompt = buildPrompt({
    message: 'What is the trend?', mode: 'toolContinuation',
    context: { symbol: '7203.T', timeframe: '5m', candles: [{ close: 2910 }] },
    toolResults: [{ request: { timeframe: '1h' }, ok: true, data: { candles: [{ close: 2900 }] } }]
  })
  assert.match(prompt, /"close":2900/)
  assert.doesNotMatch(prompt, /"close":2910/)
  assert.doesNotMatch(prompt, /What is the trend/)
  assert.doesNotMatch(prompt, /Chart context JSON/)
  assert.doesNotMatch(prompt, /Required response shape/)
})

test('full prompt includes tool data if the native conversation could not be resumed', () => {
  const prompt = buildPrompt({
    message: 'Compare 5m and 1h',
    context: { symbol: '7203.T', timeframe: '5m', candleCount: 1, candles: [{ close: 2910 }] },
    toolResults: [{ ok: true, data: { timeframe: '1h', candles: [{ close: 2900 }] } }]
  })
  assert.match(prompt, /User question: Compare 5m and 1h/)
  assert.match(prompt, /"close":2910/)
  assert.match(prompt, /"close":2900/)
})

test('full prompt reports zero extra candles unavailable, while follow-up never claims extra candle data was attached', () => {
  const context = { symbol: '7203.T', timeframe: '5m', candles: [], additionalTimeframes: [{ timeframe: '1d', candleCount: 0, candles: [] }] }
  const prompt = buildPrompt({
    message: 'Can you see 1d?', context
  })
  assert.match(prompt, /1d: unavailable \(no candles\)/)
  const followUp = buildPrompt({ message: 'Can you see 1d?', mode: 'followUp', context })
  assert.doesNotMatch(followUp, /1d: unavailable|structured candles available|additionalTimeframes/)
})
