# L2Chart AI Assistant

The assistant is an optional workstation feature. It does not change the provider-neutral chart package under `src/`. The normal workstation loads the AI tab; it can connect only when the local assistant sidecar is running.

## Start on Windows

1. Install dependencies once with `npm install`.
2. Install Codex CLI and sign in with ChatGPT.
3. Double-click `open-ai-chart.bat`.

The launcher starts the loopback-only Codex sidecar on `127.0.0.1:8788` and the normal workstation config.

You can also run the chart normally with `npm run dev`. The AI tab will be visible, but it will report the sidecar as offline until `examples/sidecars/assistant/server.mjs` is running.

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
