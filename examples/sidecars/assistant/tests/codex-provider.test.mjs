import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAccountStatus } from '../codex-provider.mjs'

test('normalizes Codex day and seven-day quota status', () => {
  const status = normalizeAccountStatus({
    accountResponse: {
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
      requiresOpenaiAuth: true
    },
    rateLimitsResponse: {
      rateLimits: {
        primary: { usedPercent: 25, windowDurationMins: 1440, resetsAt: 1730947200 },
        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1731552000 }
      },
      rateLimitResetCredits: { availableCount: 2, credits: [] }
    },
    model: 'gpt-5.3-codex',
    reasoningEffort: 'high'
  })

  assert.equal(status.account.planType, 'plus')
  assert.equal(status.rateLimits.primary.remainingPercent, 75)
  assert.equal(status.rateLimits.primary.windowDurationMins, 1440)
  assert.equal(status.rateLimits.secondary.windowDurationMins, 10080)
  assert.equal(status.resetCredits.availableCount, 2)
  assert.equal(status.selected.reasoningEffort, 'high')
})
