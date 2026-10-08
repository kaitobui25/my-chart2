export const ASSISTANT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    requests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string', enum: ['get_candles', 'get_indicator'] },
          timeframe: { type: 'string' },
          id: { type: 'string' },
          limit: { type: 'integer' },
          paramsJson: { type: 'string' }
        },
        required: ['tool', 'timeframe', 'id', 'limit', 'paramsJson'],
        additionalProperties: false
      }
    }
  },
  required: ['message', 'requests'],
  additionalProperties: false
}

function validatedRequests(requests) {
  if (!Array.isArray(requests) || requests.length > 2) return null
  const result = []
  for (const item of requests) {
    if (!item || !['get_candles', 'get_indicator'].includes(item.tool)) return null
    if (typeof item.timeframe !== 'string' || item.timeframe.length > 10) return null
    if (typeof item.id !== 'string' || item.id.length > 80) return null
    if (!Number.isInteger(item.limit) || item.limit < 1 || item.limit > 120) return null
    if (typeof item.paramsJson !== 'string' || item.paramsJson.length > 1000) return null
    result.push({ tool: item.tool, timeframe: item.timeframe, id: item.id, limit: item.limit, paramsJson: item.paramsJson })
  }
  return result
}

export function parseResponse(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Codex returned an empty response.')
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const candidates = [cleaned]
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(cleaned.slice(firstBrace, lastBrace + 1))
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      const requests = value?.requests === undefined ? [] : validatedRequests(value.requests)
      if (typeof value?.message === 'string' && requests !== null) {
        if (requests.length) return { message: value.message.trim(), requests }
        if (value.message.trim()) return { message: value.message.trim() }
      }
    } catch {}
  }
  throw new Error('Codex response was not valid JSON.')
}

/** ChatGPT Bridge returns native webpage text; plain answers remain compatible. */
export function parseNativeResponse(text) {
  try {
    return parseResponse(text)
  } catch {
    return { message: String(text ?? '').trim() }
  }
}
