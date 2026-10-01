export const ASSISTANT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false
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
      if (typeof value?.message === 'string' && value.message.trim()) {
        return { message: value.message.trim() }
      }
    } catch {}
  }
  throw new Error('Codex response was not valid JSON.')
}
