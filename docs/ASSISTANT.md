# L2Chart AI Assistant

The workstation and Excel add-in support Codex CLI and ChatGPT Web through the local assistant sidecar. The workstation defaults to Codex; use the Provider selector to switch to ChatGPT Web. Settings and conversations stay separate for each provider.

The workstation's **Lịch sử** button opens a local archive for both providers. Messages survive page reloads and New Chat; selecting an archived entry is read-only and does not replace the active AI session. Workstation history is stored separately from Excel, limited to 40 conversations and 100 messages per conversation (8,000 characters per message).

Each archived chat in workstation and Excel has a **…** action showing its native ChatGPT/Codex session ID. Click the ID to copy it; successful copies display a confirmation. IDs are recorded from chat responses for subsequent turns and persist with the archive. Older entries without this metadata show a clearly labeled local history ID instead; that local ID cannot resume a native conversation.

Model and reasoning settings apply on the next Send or New Chat, rather than immediately when a dropdown changes. With **ChatGPT current**, the bridge retains the native model and applies the requested reasoning through its Power control. It verifies the selected effort before sending; an unsupported or unconfirmed effort returns an error without sending the prompt.

The Reasoning dropdown lists only levels reported by the selected model. For ChatGPT current, the extension reads the native Power positions and restores the original setting after inspection. If native capabilities cannot be determined, reasoning stays unavailable instead of offering assumed levels.

The workstation's top-right **…** menu includes **Khởi động lại sidecar và reload extension**. It asks the connected bridge extension to reload, restarts the sidecar through the dev server, waits for the extension to reconnect, then reloads the assistant's options. Active AI requests block this action; local history remains stored. The extension must already support the reload command (reload it manually once after installing this update).

## Start

1. Install dependencies once with `npm install`.
2. Run `npm run dev`.
3. Install Codex CLI and sign in with your ChatGPT account.
4. Open the workstation's AI panel and select a Provider. Use `/status` to check the connection and Codex quota.

`npm run dev` starts the loopback-only assistant sidecar on `127.0.0.1:8788` and the workstation. The Codex provider requires Codex CLI; no browser extension, MCP server, or public tunnel is needed. For ChatGPT Web, load `examples/chatgpt-extension` as an unpacked Chrome extension and keep Chrome signed in to ChatGPT.

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

`get_indicator` supports numeric indicators (SMA, EMA, RSI, MACD, Bollinger and the queryable TA suite) and structured Darvas, SMC V1/V2/V3 and Nikkei 225 results. `indicatorCatalog` lists supported IDs; empty `paramsJson` inherits the active chart parameters, with explicit overrides validated against the indicator definition. Bare `smc` resolves the sole active SMC version; multiple active versions require an exact ID. Rendering metadata (`__*`) is excluded from calculation inputs.

Structured queries reuse current chart snapshots when parameters, timeframe and anchor match. Historical queries recalculate the same chart models on the bounded candle prefix; provider timeframe bars must have closed by the query deadline. Darvas returns box bounds/states; SMC returns bounded events, active zones, pivots and derived levels with times and availability notes; Nikkei returns actual `^N225` OHLC aligned to chart buckets, preserving missing sessions as null. Nikkei raw candles remain local and reuse the overlay data where possible. Basic indicators can be calculated even when not attached. Provider-dependent features report unavailable data explicitly; display filters and active zone inventories are not treated as complete historical signal archives. Results are limited to 120 points/events per collection (10 recent SMC bar states), and repeated identical requests are deduplicated within a chat turn.

## Tests

Historical tool requests may include `beforeTime` (exclusive Unix seconds; null/omitted uses the chart anchor). This cursor is bounded by the visible/replay anchor. Nikkei responses distinguish `history.availableRange`/`availableCount` from the limited `values` page and expose `nextBeforeTime` for older pages. Monthly OHLC summaries describe available aligned chart history, including partial months and missing coverage; they do not imply complete provider history. Older requested windows outside chart memory can be loaded from the datafeed. A 120-point page must never be described as the full available history.

ChatGPT Web model/reasoning discovery is cached in the extension's persistent local storage for 24 hours. Opening more charts or restarting the extension reuses that result without loading ChatGPT again. Concurrent requests share one inspection. A temporary inspection tab opens in the background and closes afterward. Failed inspections are also remembered for 24 hours to avoid repeatedly opening tabs; after signing in or changing accounts/models, use the workstation assistant's ↻ button to refresh immediately. Sending a message still validates the requested reasoning against the live web UI and requires a ChatGPT tab.

```bash
node --test examples/sidecars/assistant/tests/*.test.mjs
npm run typecheck
```
