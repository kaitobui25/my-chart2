# Workstation example

This is the complete L2Chart demo application. It composes the public chart
core with optional provider adapters, indicators, layouts, drawing controls,
paper trading, and local persistence.

From the repository root:

```bash
npm install
npm run dev
```

The default sample provider is deterministic and requires no credentials. The
provider integrations are reference implementations, not runtime dependencies
of the `lamlong-chart` package.

For the DNSE reference adapter, prefer server-side signing through the local Vite
proxy:

```bash
cd examples/workstation
cp .env.example .env
```

Set `DNSE_API_KEY` and `DNSE_API_SECRET` in `.env`, then restart `npm run dev`.

When those values are present, leave the DNSE API Key/Secret fields blank in the
UI and use the local proxy. Credentials typed directly into the browser are kept
in tab memory only and are cleared on reload.

DNSE realtime uses the workstation WebSocket proxy at `/dnse-ws`, which forwards
to `wss://ws-openapi.dnse.com.vn`. If REST history works but realtime reports a
transport error on another machine, check that the WS URL is `/dnse-ws` (or the
current page's `/dnse-ws` URL) and that the machine can open outbound WebSocket
connections to DNSE.

Credentials loaded from this `.env` are accepted only for browser requests made
from the same machine. A workstation exposed with `preview:lan` must use
per-session browser credentials over a trusted private network, or place DNSE
signing behind an authenticated application backend.

The provider dialog has two credential modes:

- **Browser session** uses credentials entered in the UI. The app keeps them in
  memory only; standard credential forms allow the browser or OS password
  manager to save and autofill them without exposing plaintext to localStorage.
  When the workstation is opened through a LAN or Tailscale address, enter the
  sidecar's `SIDECAR_TOKEN` under **Advanced settings** as well. Selecting this
  mode does not bypass sidecar authentication.
- **Server .env** reads persistent credentials from server-side files. For
  FiinQuant, set `FIINQUANT_SIDECAR_TOKEN` here to the same value as
  `SIDECAR_TOKEN` in `examples/sidecars/fiinquant/.env`; the loopback-only Vite
  proxy supplies it to the sidecar.

The dev port is not fixed. Loopback origins are accepted on any port. Remote
origins must be listed exactly in the sidecar's `SIDECAR_ALLOWED_ORIGINS`,
including the port shown in the browser URL. Server `.env` credentials are only
injected for a true loopback client; remote browsers must use Browser session.

Only the selected mode and non-sensitive URLs are stored in localStorage.
