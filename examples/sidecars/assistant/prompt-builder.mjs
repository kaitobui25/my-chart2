const COMMON_RULES = [
  'Use the supplied chart context as the source of truth for symbol, timeframe, prices, candles, indicators, and replay state.',
  'The candles array is the complete allowed history for this turn. Never infer or use future candles.',
  'The screenshot is supporting visual evidence; structured candle data wins if they appear to conflict.',
  'Do not invent prices, indicator values, news, fundamentals, or unseen candles.',
  'Separate observed chart facts from inference.',
  'Reply in the language used by the user.'
]

const ANALYSIS_RULES = [
  'Produce a trade plan only for the current chart context.',
  'WAIT is valid and preferred when the setup is unclear.',
  'Do not suggest leverage, position size, or removing a stop loss.',
  'LONG or SHORT requires a numeric entry zone, stop loss, at least one target, and a clear invalidation.',
  'Return JSON only and follow the trade-analysis schema exactly.'
]

const CHAT_RULES = [
  'Communicate naturally about the current chart and the user question.',
  'Do not force LONG, SHORT, WAIT, confidence, or a trade plan in normal chat mode.',
  'Return JSON only with one message field.'
]

function compactConversation(conversation) {
  return Array.isArray(conversation)
    ? conversation.slice(-10).flatMap(item => {
        if (!['user', 'assistant'].includes(item?.role) || typeof item?.content !== 'string') return []
        const content = item.content.trim().slice(0, 4000)
        return content ? [{ role: item.role, content }] : []
      })
    : []
}

function compactContext(context) {
  const source = context && typeof context === 'object' ? context : {}
  return {
    version: source.version,
    generatedAt: source.generatedAt,
    symbol: source.symbol,
    timeframe: source.timeframe,
    mode: source.mode,
    replay: source.replay,
    historyRange: source.historyRange,
    candleCount: source.candleCount,
    candles: Array.isArray(source.candles) ? source.candles.slice(-240) : [],
    indicators: Array.isArray(source.indicators) ? source.indicators : []
  }
}

export function buildPrompt({ mode = 'chat', message, conversation, context }) {
  const analyze = mode === 'analyze'
  const responseShape = analyze
    ? '{"message":"concise explanation","tradePlan":{"decision":"LONG|SHORT|WAIT","confidence":0,"marketRegime":"trend|range|transition|unknown","entryZone":null,"stopLoss":null,"targets":[],"riskReward":null,"expiryBars":0,"invalidation":"","reasons":[],"warnings":[]}}'
    : '{"message":"natural chart-aware answer"}'

  return [
    `You are a cautious chart assistant embedded in L2Chart. Current instrument: ${context?.symbol ?? 'unknown'} ${context?.timeframe ?? ''}.`,
    ...COMMON_RULES.map(rule => `- ${rule}`),
    ...(analyze ? ANALYSIS_RULES : CHAT_RULES).map(rule => `- ${rule}`),
    '',
    `Task mode: ${analyze ? 'Trade analysis' : 'Normal chat'}`,
    `User request: ${String(message ?? '').trim()}`,
    '',
    'Recent conversation JSON:',
    JSON.stringify(compactConversation(conversation)),
    '',
    'Required response shape:',
    responseShape,
    '',
    'Chart context JSON:',
    JSON.stringify(compactContext(context))
  ].join('\n')
}
