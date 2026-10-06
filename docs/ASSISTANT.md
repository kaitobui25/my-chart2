# L2Chart AI Assistant

The workstation assistant is provider-neutral at the chart layer. Phase 1A connects the local assistant sidecar directly to ChatGPT through the dedicated LAMlongchart Chrome extension, while the sidecar also retains the optional Codex CLI provider used by the Excel add-in.

## Start

1. Install dependencies once with `npm install`.
2. Run `npm run dev`.
3. In Chrome, open `chrome://extensions`, enable Developer mode, and load `examples/chatgpt-extension` as an unpacked extension.
4. Keep Chrome signed in to ChatGPT.
5. Reload the workstation after the extension is loaded or reloaded.

`npm run dev` starts the loopback-only assistant sidecar on `127.0.0.1:8788` and the workstation. ChatGPT does not require Codex CLI, Chat On Steroids runtime, MCP server, or a public tunnel. Codex CLI is only required when the Codex provider is selected.

## Design

- `examples/workstation/assistant/` owns the UI and the browser-facing assistant client.
- `examples/sidecars/assistant/` owns prompt construction, ChatGPT/Codex provider routing, the local ChatGPT command broker, provider/session binding, cancellation, and tests.
- `examples/chatgpt-extension/` owns the dedicated ChatGPT tab, native model/reasoning selection, Send receipt, conversation binding, and final-response observation.
- `examples/workstation/vite.config.ts` adds the `/assistant-api` proxy and injects the assistant UI module.
- `examples/workstation/assistant/context.ts` owns chart-context slicing, requested-timeframe detection, and on-demand timeframe loading.
- The stable `lamlong-chart` exports remain unchanged.

The assistant sends candles around the currently visible chart range with a small nearby buffer capped at 240 candles. It also sends active indicator parameters, replay state, the latest quote when available, and requested additional timeframes. Phase 1A sends structured data only; it does not capture or upload a chart PNG.

ChatGPT's native conversation owns prior turns, so the sidecar sends the current user question plus the current structured chart context without duplicating the visible transcript. Codex is stateless between CLI executions, so the sidecar includes the bounded local transcript when Codex is selected.

When the user's question explicitly names another timeframe such as `15m`, `1h`, `daily`, or `weekly`, the context bridge loads that timeframe on demand for the same symbol. Requested history is anchored to the end of the visible chart range so replay or historical inspection does not leak later candles. Missing timeframe data is passed to the assistant as an explicit error instead of being guessed.

## Tests

```bash
node --test examples/sidecars/assistant/tests/*.test.mjs
npm run typecheck
```
