export const CHAT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false
}

export const TRADE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    tradePlan: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['LONG', 'SHORT', 'WAIT'] },
        confidence: { type: 'number', minimum: 0, maximum: 100 },
        marketRegime: { type: 'string' },
        entryZone: {
          anyOf: [
            { type: 'null' },
            {
              type: 'object',
              properties: { from: { type: 'number' }, to: { type: 'number' } },
              required: ['from', 'to'],
              additionalProperties: false
            }
          ]
        },
        stopLoss: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        targets: { type: 'array', items: { type: 'number' }, maxItems: 5 },
        riskReward: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        expiryBars: { type: 'integer', minimum: 0, maximum: 500 },
        invalidation: { type: 'string' },
        reasons: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        warnings: { type: 'array', items: { type: 'string' }, maxItems: 10 }
      },
      required: [
        'decision', 'confidence', 'marketRegime', 'entryZone', 'stopLoss',
        'targets', 'riskReward', 'expiryBars', 'invalidation', 'reasons', 'warnings'
      ],
      additionalProperties: false
    }
  },
  required: ['message', 'tradePlan'],
  additionalProperties: false
}

export function responseSchemaFor(mode = 'chat') {
  return mode === 'analyze' ? TRADE_RESPONSE_SCHEMA : CHAT_RESPONSE_SCHEMA
}

function finiteOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean).slice(0, 10)
    : []
}

function normalizeEntryZone(value) {
  const from = finiteOrNull(value?.from)
  const to = finiteOrNull(value?.to)
  if (from === null || to === null) return null
  return { from: Math.min(from, to), to: Math.max(from, to) }
}

export function normalizeTradePlan(value = {}) {
  const decision = ['LONG', 'SHORT', 'WAIT'].includes(String(value.decision).toUpperCase())
    ? String(value.decision).toUpperCase()
    : 'WAIT'
  const confidence = Math.min(100, Math.max(0, finiteOrNull(value.confidence) ?? 0))
  const entryZone = normalizeEntryZone(value.entryZone)
  const stopLoss = finiteOrNull(value.stopLoss)
  const targets = Array.isArray(value.targets)
    ? value.targets.map(finiteOrNull).filter(value => value !== null).slice(0, 5)
    : []
  const riskReward = finiteOrNull(value.riskReward)
  const expiryBars = Math.min(500, Math.max(0, Math.round(finiteOrNull(value.expiryBars) ?? 0)))
  const complete = entryZone !== null && stopLoss !== null && targets.length > 0
  const safeDecision = decision !== 'WAIT' && !complete ? 'WAIT' : decision

  return {
    decision: safeDecision,
    confidence,
    marketRegime: typeof value.marketRegime === 'string' && value.marketRegime.trim() ? value.marketRegime.trim() : 'unknown',
    entryZone: safeDecision === 'WAIT' ? null : entryZone,
    stopLoss: safeDecision === 'WAIT' ? null : stopLoss,
    targets: safeDecision === 'WAIT' ? [] : targets,
    riskReward: safeDecision === 'WAIT' ? null : riskReward,
    expiryBars,
    invalidation: typeof value.invalidation === 'string' ? value.invalidation.trim() : '',
    reasons: stringArray(value.reasons),
    warnings: stringArray(value.warnings)
  }
}

export function normalizeResponse(value, mode = 'chat') {
  const source = value && typeof value === 'object' ? value : {}
  return {
    message: typeof source.message === 'string' && source.message.trim()
      ? source.message.trim()
      : 'Codex returned no explanatory message.',
    tradePlan: mode === 'analyze' ? normalizeTradePlan(source.tradePlan) : null
  }
}

export function parseResponse(text, mode = 'chat') {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Codex returned an empty response.')
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const candidates = [cleaned]
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(cleaned.slice(firstBrace, lastBrace + 1))
  for (const candidate of candidates) {
    try {
      return normalizeResponse(JSON.parse(candidate), mode)
    } catch {}
  }
  throw new Error('Codex response was not valid JSON.')
}
