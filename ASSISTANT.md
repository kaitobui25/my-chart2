# L2Chart AI Assistant

The assistant is an optional workstation feature. It does not change the provider-neutral chart package under `src/` and it is not loaded by the normal `npm run dev` command.

## Start on Windows

1. Install dependencies once with `npm install`.
2. Install Codex CLI and sign in with ChatGPT.
3. Double-click `open-ai-chart.bat`.

The launcher starts the loopback-only Codex sidecar on `127.0.0.1:8788` and the workstation with `examples/workstation/vite.assistant.config.ts`.

## Design

- `examples/workstation/assistant/` owns the UI and browser client.
- `examples/sidecars/assistant/` owns Codex execution, prompt construction, response validation, cancellation, and tests.
- `vite.assistant.config.ts` reuses the normal workstation config, adds the `/assistant-api` proxy, injects the assistant module, and exposes a read-only context snapshot from the active tile.
- The normal workstation and the stable `lamlong-chart` exports remain unchanged.

The assistant sends at most 240 recent candles, active indicator parameters, replay state, recent chat messages, and a PNG capture of the active chart. It never sends an exchange order.

## Tests

```bash
node --test examples/sidecars/assistant/tests/*.test.mjs
```
