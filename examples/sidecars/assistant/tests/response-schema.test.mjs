import test from 'node:test'
import assert from 'node:assert/strict'
import { parseResponse } from '../response-schema.mjs'

test('parses the single-message response shape', () => {
  assert.deepEqual(parseResponse('```json\n{"message":"ok"}\n```'), { message: 'ok' })
})

test('rejects responses without a usable message', () => {
  assert.throws(() => parseResponse('{"message":""}'), /not valid JSON/)
})
