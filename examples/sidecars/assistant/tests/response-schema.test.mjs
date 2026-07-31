import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTradePlan, parseResponse } from '../response-schema.mjs'

test('downgrades incomplete directional plans to WAIT', () => {
  const plan = normalizeTradePlan({ decision: 'LONG', confidence: 80, targets: [120] })
  assert.equal(plan.decision, 'WAIT')
  assert.equal(plan.entryZone, null)
  assert.deepEqual(plan.targets, [])
})

test('normalizes a complete directional plan', () => {
  const plan = normalizeTradePlan({
    decision: 'short',
    confidence: 72,
    marketRegime: 'trend',
    entryZone: { from: 110, to: 108 },
    stopLoss: 112,
    targets: [104, 100],
    riskReward: 2.2
  })
  assert.equal(plan.decision, 'SHORT')
  assert.deepEqual(plan.entryZone, { from: 108, to: 110 })
})

test('parses fenced chat JSON', () => {
  assert.deepEqual(parseResponse('```json\n{"message":"ok"}\n```', 'chat'), { message: 'ok', tradePlan: null })
})
