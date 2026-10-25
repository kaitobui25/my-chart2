import test from 'node:test'
import assert from 'node:assert/strict'
import { parseResponse, parseNativeResponse } from '../response-schema.mjs'

test('parses the single-message response shape', () => {
  assert.deepEqual(parseResponse('```json\n{"message":"ok"}\n```'), { message: 'ok' })
})

test('rejects responses without a usable message', () => {
  assert.throws(() => parseResponse('{"message":""}'), /not valid JSON/)
})

test('accepts a bounded tool request with no final message', () => {
  assert.deepEqual(parseResponse(JSON.stringify({
    message: '',
    requests: [{ tool: 'get_indicator', timeframe: '1d', id: 'rsi', limit: 10, paramsJson: '{"length":14}' }]
  })), {
    message: '',
    requests: [{ tool: 'get_indicator', timeframe: '1d', id: 'rsi', limit: 10, paramsJson: '{"length":14}' }]
  })
})

test('allows a plain native ChatGPT response and parses native JSON requests', () => {
  assert.deepEqual(parseNativeResponse('RSI is 58.'), { message: 'RSI is 58.' })
  assert.deepEqual(parseNativeResponse('{"message":"ok","requests":[]}'), { message: 'ok' })
})

test('preserves a historical cursor and rejects invalid cursors', () => {
  const request = { tool: 'get_indicator', timeframe: 'current', id: 'nikkei-225', limit: 120, paramsJson: '{}', beforeTime: 1735689600 }
  assert.deepEqual(parseResponse(JSON.stringify({ message: '', requests: [request] })).requests, [request])
  for (const beforeTime of [-1, 1.5, '2025-01-01']) {
    assert.throws(() => parseResponse(JSON.stringify({ message: '', requests: [{ ...request, beforeTime }] })), /not valid JSON/)
  }
})
