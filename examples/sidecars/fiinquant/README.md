# FiinQuant reference sidecar

This directory contains an optional FiinQuantX integration for the workstation
example. It is not exported by `lamlong-chart` and is not required by the chart
core.

The sidecar owns one authenticated SDK session, caches recent history, and
multiplexes realtime subscriptions:

```text
Browser <-> HTTP/WebSocket sidecar <-> FiinQuantX session
```

## Security boundaries

- `SIDECAR_TOKEN` is required for session, history, symbol, and stream routes.
- The token is never accepted from a WebSocket URL. Direct browser clients send
  `{ "action": "authenticate", "token": "..." }` as their first frame; the
  local Vite proxy may authenticate with the private sidecar header instead.
- The server does not register subscriptions until stream authentication has
  succeeded and closes unauthenticated sockets after five seconds.
- CORS accepts loopback workstation origins on any port. LAN and Tailscale
  origins must be listed explicitly in `SIDECAR_ALLOWED_ORIGINS`.
- Docker publishes the service on `127.0.0.1:8720` by default.
- Credentials submitted through the UI remain in process memory. Credentials
  placed in `.env` remain on the sidecar host.
- Do not expose the HTTP service directly to the public Internet. Production
  deployments need TLS, application authentication, rate limits, and network
  controls in front of the sidecar.

The FiinQuantX wheel is downloaded from the provider index during installation
and is not stored in this repository or in the npm package. Its wheel metadata
does not currently declare a software license. Confirm provider usage and
redistribution terms before publishing a prebuilt sidecar image.

This example pins `FiinQuantX==0.1.67` and `signalrcore==1.0.2`. Provider
requirements are installed with their dependencies so the SignalR/WebSocket
transport stays compatible with the selected SDK. The workstation's lazy
provider runtime also checks these pinned versions before starting the sidecar;
if the managed `.venv` is stale, it upgrades that environment on first use
instead of silently reusing an older importable SDK.

CI installs the full provider environment in an isolated Python 3.11 virtual
environment, runs `pip check`, and runs `pip-audit --local`. `signalrcore` and
its transitive dependencies are audited normally. `FiinQuantX` is hosted on the
provider index, not PyPI, so `pip-audit` cannot map it to advisories; its source,
release process, and license remain a manual trust decision rather than a
successful audit.

## Docker quick start

From this directory:

```bash
cp .env.example .env
openssl rand -hex 32
```

Set the generated value as `SIDECAR_TOKEN` in `.env`, then run:

```bash
docker compose up -d --build fiinquant-sidecar
curl http://127.0.0.1:8720/health
```

Open the workstation, choose **Market data**, and select FiinQuant. Enter the
same token under **Advanced settings**. Then either:

- enter a username and password for the current sidecar process; or
- set `FIINQUANT_USERNAME` and `FIINQUANT_PASSWORD` in `.env` and use the
  configured server session.

Useful commands:

```bash
docker compose ps fiinquant-sidecar
docker compose logs -f fiinquant-sidecar
docker compose down
```

## Access from another device

Bind the container to one specific private LAN or Tailscale address:

```bash
SIDECAR_BIND_ADDRESS=100.x.y.z docker compose \
  -f compose.yaml -f compose.remote.yaml up -d --build fiinquant-sidecar
```

Set `SIDECAR_ALLOWED_ORIGINS` to the exact workstation origin, for example
`http://100.x.y.z:53175`. Port `53175` is only an example; use the actual port
shown in the browser URL. Do not bind to `0.0.0.0` unless every reachable
network is trusted and independently controlled. Browser-session clients on a
LAN or Tailscale address must also enter `SIDECAR_TOKEN` under **Advanced
settings**; the workstation never sends its server-side token to remote
clients.

## Manual Python setup

Python 3.11 is recommended:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m pip install --upgrade -r requirements-provider.txt
python -m pip check
cp .env.example .env
python fiinquant_sidecar.py
```

For a fully server-configured local workstation, use the same random value for
`SIDECAR_TOKEN` in this directory and `FIINQUANT_SIDECAR_TOKEN` in
`examples/workstation/.env`. The Vite proxy injects the server token only for
loopback clients.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Read configuration, authorization, and stream status |
| `POST /session` | Authenticate a FiinQuantX session |
| `GET /history` | Load OHLC history for a symbol and interval |
| `GET /symbols` | Search provider instruments |
| `WS /stream` | Multiplex realtime bar subscriptions |

Run the focused tests from the repository root:

```bash
npm run test:sidecar
python3.11 scripts/audit-provider.py
```
