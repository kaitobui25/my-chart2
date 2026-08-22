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
- `examples/workstation/vite.config.ts` adds the `/assistant-api` proxy, injects the assistant module, and exposes a read-only context snapshot from the active tile.
- The stable `lamlong-chart` exports remain unchanged.

The assistant sends at most 240 recent candles, active indicator parameters, replay state, recent chat messages, and a PNG capture of the active chart. It never sends an exchange order.

## Tests

```bash
node --test examples/sidecars/assistant/tests/*.test.mjs
```
