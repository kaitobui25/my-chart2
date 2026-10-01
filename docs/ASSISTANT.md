# L2Chart AI Assistant

The assistant is integrated into the workstation. It does not change the provider-neutral chart package under `src/`. The standard development command starts both the chart and the local AI sidecar.

## Start

1. Install dependencies once with `npm install`.
2. Install Codex CLI and sign in with ChatGPT.
3. Run `npm run dev`.

This single command starts the loopback-only Codex sidecar on `127.0.0.1:8788` and the complete workstation. On Windows, `open-ai-chart.bat` remains a convenience shortcut for the same command.

## Design

- `examples/workstation/assistant/` owns the UI and browser client.
- `examples/sidecars/assistant/` owns Codex execution, prompt construction, response validation, cancellation, and tests.
- `examples/workstation/vite.config.ts` adds the `/assistant-api` proxy and injects the assistant UI module.
- `examples/workstation/assistant/context.ts` owns chart-context slicing, requested-timeframe detection, and on-demand timeframe loading.
- The stable `lamlong-chart` exports remain unchanged.

By default the assistant sends only candles around the currently visible chart range, with a small nearby buffer capped at 240 candles. It also sends active indicator parameters, replay state, the latest quote when available, recent chat messages, and a PNG capture of the active chart.

When the user's question explicitly names another timeframe such as `15m`, `1h`, `daily`, or `weekly`, the context bridge loads that timeframe on demand for the same symbol. Requested history is anchored to the end of the visible chart range so replay or historical inspection does not leak later candles. Missing timeframe data is passed to the assistant as an explicit error instead of being guessed.

## Tests

```bash
node --test examples/sidecars/assistant/tests/*.test.mjs
```
