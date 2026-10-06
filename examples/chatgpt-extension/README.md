# LAMlongchart ChatGPT Bridge

Phase 1A uses a small Chrome extension to connect the local LAMlongchart assistant sidecar directly to an authenticated ChatGPT tab. It does not use Codex CLI, Chat On Steroids, MCP, or a tunnel.

## Load the extension

1. Run `npm run dev` so the assistant sidecar is listening on `127.0.0.1:8788`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select `examples/chatgpt-extension`.
5. Keep Chrome signed in to `https://chatgpt.com`.
6. Reload the LAMlongchart workstation after loading or reloading the extension.

The extension opens and owns only the ChatGPT tabs created for LAMlongchart. The workstation sends text plus structured chart context. Phase 1A does not upload chart screenshots.

## Phase 1A responsibilities

- `background.js` long-polls the loopback assistant sidecar, owns the LAM ChatGPT tab binding, and reports command results.
- `content.js` selects the native ChatGPT model/reasoning setting, inserts the exact prompt, clicks the native Send control once, observes the native user-message receipt, and waits for the exact final assistant response.
- `page-model.js` runs in the ChatGPT page's MAIN world only to read bounded native model-picker state and terminal assistant-message evidence.

`New` in the LAM assistant creates a fresh ChatGPT tab/conversation. Later messages reuse only the conversation bound to that LAM session.
