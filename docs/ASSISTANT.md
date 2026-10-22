# L2Chart AI Assistant

The workstation assistant uses Codex CLI through the local assistant sidecar. The Excel add-in supports both Codex CLI and ChatGPT through the dedicated LAMlongchart Chrome extension.

## Start

1. Install dependencies once with `npm install`.
2. Run `npm run dev`.
3. Install Codex CLI and sign in with your ChatGPT account.
4. Open the workstation's AI panel. Use `/status` to check the Codex connection and quota.

`npm run dev` starts the loopback-only assistant sidecar on `127.0.0.1:8788` and the workstation. Workstation chat requires Codex CLI; no browser extension, MCP server, or public tunnel is needed. For the Excel add-in's ChatGPT provider, load `examples/chatgpt-extension` as an unpacked Chrome extension and keep Chrome signed in to ChatGPT.

## Design

- `examples/workstation/assistant/` owns the UI and the browser-facing assistant client.
- `examples/sidecars/assistant/` owns prompt construction, ChatGPT/Codex provider routing, the local ChatGPT command broker, provider/session binding, cancellation, and tests.
- `examples/chatgpt-extension/` owns the dedicated ChatGPT tab, native model/reasoning selection, Send receipt, conversation binding, and final-response observation.
- `examples/workstation/vite.config.ts` adds the `/assistant-api` proxy and injects the assistant UI module.
- `examples/workstation/assistant/context.ts` owns chart-context slicing, requested-timeframe detection, and on-demand timeframe loading.
- The stable `lamlong-chart` exports remain unchanged.

On the first question of a native conversation, the assistant sends candles around the currently visible chart range (up to 240 candles), active indicator parameters, replay state, the latest quote when available, and explicitly requested additional timeframes. Phase 1A sends structured data only; it does not capture or upload a chart PNG.

ChatGPT and Codex both resume their native conversation sessions. The first question in a session sends the chart assistant rules and data-tool instructions. Later questions send only the new user question and chart metadata (symbol, timeframe, visible range, replay, quote, etc.); they never automatically attach candle arrays or additional-timeframe candle data. The AI decides if it needs fresh data and requests it using `get_candles`/`get_indicator`. New Chat starts with the full prompt again.

On the first question, explicit mentions of another timeframe such as `15m`, `1h`, `daily`, or `weekly` cause the context bridge to preload that timeframe. Follow-up questions do not preload it. Requested history is anchored to the end of the visible chart range so replay or historical inspection does not leak later candles. Missing timeframe data is reported as an explicit error instead of being guessed.

## Data-access model

LAMlongchart retains local chart context for every question so read-only tool calls can be verified and anchored to the visible chart. The model receives candle arrays automatically **only for the first question of the native conversation**. Explicitly named extra timeframes are preloaded only for that first question; for later questions the AI requests data when needed.

Generic language such as "multi-timeframe analysis" does not automatically load every timeframe. If more data is needed, ChatGPT or Codex may request `get_candles` or `get_indicator`; the chart bridge runs those read-only queries and sends back only the new results in the same native conversation. Each model response may request up to two queries, for at most three data rounds. Missing data is reported as an error rather than guessed. Tool-result continuations omit the earlier question and candle snapshot because they are already in the native conversation.

## Tests

```bash
node --test examples/sidecars/assistant/tests/*.test.mjs
npm run typecheck
```
