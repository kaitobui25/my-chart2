const RULES = [
  'Answer only what the user asked.',
  'Be honest, short, and easy to understand. Explain simply, like you are explaining to a child.',
  'Use the supplied structured chart context as the source of truth for symbol, timeframe, prices, candles, volume, indicators, replay state, and requested extra timeframes.',
  'The primary candles are limited to the chart area the user is currently viewing, with only a small nearby buffer.',
  'The initial context adds extra timeframes when the user explicitly asks; you may request more through the listed chart tools when analysis requires them. If a requested timeframe contains an error or no candles, say that the data is unavailable.',
  'Do not invent prices, volume, indicator values, news, fundamentals, unseen candles, or missing data.',
  'If the data is not enough to answer, say what is missing instead of guessing.',
  'Do not add a trade plan, prediction, or advice unless the user explicitly asks for it.',
  'Reply in the language used by the user.',
];

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

export function buildPrompt({ message, context, toolResults = [], structuredResponse = false, continuation = false }) {
  const responseShape = '{"message":"short, clear answer or empty when requesting data","requests":[]}'
  if (continuation) {
    return [
      'Continue the pending chart question in this Codex session using the newly supplied results.',
      'Do not repeat an earlier request if its result is already available.',
      'Results of prior chart data requests (use these as verified data):',
      JSON.stringify(toolResults.slice(0, 6)),
      'Reply in the language of the original question. Do not invent missing data.',
      'Required response shape:',
      responseShape
    ].join('\n')
  }
  const prompt = [
    `You are a chart assistant embedded in L2Chart. Current instrument: ${context?.symbol ?? 'unknown'} ${context?.timeframe ?? ''}.`,
    ...RULES.map(rule => `- ${rule}`),
    '',
    'Structured timeframe availability:',
    timeframeSummary(context),
    'When answering whether a timeframe is available, trust this summary and the structured candles, not the primary timeframe label.',
    '',
    'Read-only chart data tools: get_candles(timeframe, limit) and get_indicator(timeframe, id, limit, paramsJson).',
    'Call these only if the current context and supplied tool results cannot answer the question.',
    'To request data, output ONLY a JSON object with message:"" and requests:[{tool,timeframe,id,limit,paramsJson}].',
    'Use timeframe "current" for the chart timeframe; valid alternatives: 1m,3m,5m,15m,30m,1h,2h,4h,1d,1w,1M.',
    'For get_candles set id:"" and paramsJson:"{}". For get_indicator use an indicator id such as rsi, ema, sma, macd, bollinger; paramsJson is a JSON object encoded as a string (for example {"length":14}).',
    'Limit must be 1-120; no more than two requests per response. Do not request external files or URLs.',
    'If data has already been provided, answer directly instead of requesting it again.',
    '',
    `User question: ${String(message ?? '').trim()}`,
  ]
  if (toolResults.length) {
    prompt.push('', 'Results of prior chart data requests (use these as verified data):', JSON.stringify(toolResults.slice(0, 6)))
  }
  if (structuredResponse) {
    prompt.push(
      '',
      'Required response shape:',
      responseShape
    )
  }
  prompt.push(
    '',
    'Chart context JSON:',
    JSON.stringify(compactContext(context))
  )
  return prompt.join('\n')
}
