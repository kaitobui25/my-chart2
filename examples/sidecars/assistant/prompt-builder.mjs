const RULES = [
  'Answer only what the user asked.',
  'Be honest, short, and easy to understand. Explain simply, like you are explaining to a child.',
  'Use the supplied structured chart context as the source of truth for symbol, timeframe, prices, candles, volume, indicators, replay state, and requested extra timeframes.',
  'The primary candles are limited to the chart area the user is currently viewing, with only a small nearby buffer.',
  'Additional timeframes are included only when the user request explicitly asks for them. If a requested timeframe contains an error or no candles, say that the data is unavailable.',
  'The screenshot is supporting visual evidence only. Structured data wins if they conflict.',
  'Do not invent prices, volume, indicator values, news, fundamentals, unseen candles, or missing data.',
  'If the data is not enough to answer, say what is missing instead of guessing.',
  'Do not add a trade plan, prediction, or advice unless the user explicitly asks for it.',
  'Reply in the language used by the user.',
  'Return JSON only with one message field.',
];

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
    visibleRange: source.visibleRange,
    candleCount: source.candleCount,
    candles: Array.isArray(source.candles) ? source.candles.slice(-240) : [],
    indicators: Array.isArray(source.indicators) ? source.indicators : [],
    quote: source.quote ?? null,
    additionalTimeframes: Array.isArray(source.additionalTimeframes)
      ? source.additionalTimeframes.map(item => ({
          timeframe: item?.timeframe,
          candleCount: item?.candleCount,
          range: item?.range ?? null,
          candles: Array.isArray(item?.candles) ? item.candles.slice(-160) : [],
          ...(typeof item?.error === 'string' && item.error ? { error: item.error } : {})
        }))
      : []
  }
}

function timeframeSummary(context) {
  const rows = []
  if (context && typeof context === 'object') {
    rows.push(`${context.timeframe ?? 'unknown'}: ${Number(context.candleCount) || 0} candles (primary visible chart context)`)
    if (Array.isArray(context.additionalTimeframes)) {
      for (const item of context.additionalTimeframes) {
        const timeframe = item?.timeframe ?? 'unknown'
        const count = Number(item?.candleCount) || 0
        rows.push(item?.error
          ? `${timeframe}: unavailable (${item.error})`
          : `${timeframe}: ${count} structured candles available`)
      }
    }
  }
  return rows.length > 0 ? rows.join('\n') : 'No chart data available.'
}

export function buildPrompt({ message, conversation, context }) {
  return [
    `You are a chart assistant embedded in L2Chart. Current instrument: ${context?.symbol ?? 'unknown'} ${context?.timeframe ?? ''}.`,
    ...RULES.map(rule => `- ${rule}`),
    '',
    'Structured timeframe availability:',
    timeframeSummary(context),
    'When answering whether a timeframe is available, trust this summary and the structured candles, not the screenshot or primary timeframe label.',
    '',
    `User question: ${String(message ?? '').trim()}`,
    '',
    'Recent conversation JSON:',
    JSON.stringify(compactConversation(conversation)),
    '',
    'Required response shape:',
    '{"message":"short, clear answer"}',
    '',
    'Chart context JSON:',
    JSON.stringify(compactContext(context))
  ].join('\n')
}
