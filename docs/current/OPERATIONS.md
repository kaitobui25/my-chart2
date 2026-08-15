# Current Operations

**Generated:** 2026-08-16  
**Documented main:** `c0c322d259d7300ea1107283813e2aed808dc855`  

This page describes how the documented repository is started, tested and operated locally. Provider credentials/entitlements remain external dependencies.

## Requirements

Core JavaScript development requires Node.js 20 or newer according to `package.json`.

The optional Python sidecars use Python. Current CI tests the Python sidecars with Python 3.11.

The FiinQuant provider runtime explicitly searches for Python 3.11+ and can create/manage `examples/sidecars/fiinquant/.venv` when needed.

## Install

Normal local dependency installation:

```bash
npm install
```

CI/reproducible install:

```bash
npm ci
```

## Normal development start

```bash
npm run dev
```

This runs:

```text
node scripts/run-assistant.mjs
```

`open-ai-chart.bat` is the Windows convenience entry point for the same development flow.

### Launcher behavior

`scripts/run-assistant.mjs` currently:

1. requires `node_modules`/Vite to be installed;
2. reuses the assistant sidecar if `127.0.0.1:8788/health` is already healthy;
3. otherwise starts the assistant sidecar and waits for health;
4. checks whether an existing workstation on the default port is compatible;
5. reuses a compatible workstation or chooses the next available port near 53173;
6. starts Vite and opens the browser.

The launcher starts Vite with `scripts/vite-dev.config.mjs`, which merges the workstation config with the terminal-trace plugin from `scripts/dev-trace-vite.mjs`. A reused dev server is only considered compatible when both `/provider-runtime/health` and `/__l2chart_dev_trace/health` report the expected versions.

The launcher deliberately reports that FiinQuant and Vnstock are lazy providers. They are not both started unconditionally before the workstation opens.

### Terminal trace diagnostics

Development/Playwright Vite runs use `scripts/vite-dev.config.mjs`, which adds the dev-only plugin in `scripts/dev-trace-vite.mjs`. The plugin injects a browser script (at `/__l2chart_dev_trace`) that reports network `fetch` timing, IndexedDB operations, long tasks and window errors back to the Vite terminal. Requests whose query parameters match token/secret keywords have those values redacted, and health-check endpoints are excluded from tracing. This trace is a diagnostics feature for dev/browser-test runs, not part of the production workstation config.

## Development ports

Default/current service addresses:

| Service | Default address | Startup behavior |
|---|---|---|
| Workstation Vite | `127.0.0.1:53173` | normal default; launcher may choose a nearby free port if 53173 is occupied by an incompatible process |
| Assistant sidecar | `127.0.0.1:8788` | eagerly ensured by `scripts/run-assistant.mjs` |
| FiinQuant sidecar | `127.0.0.1:8720` by default | lazy/on-demand via provider runtime; port may be configured in FiinQuant `.env` |
| Scanner sidecar | `127.0.0.1:8730` | scanner Vite integration eagerly ensures it when the Vite server config is installed and can restart/ensure it on API access |
| Vnstock sidecar | `127.0.0.1:8740` | lazy/on-demand through `/vnstock-api` integration |

Do not hard-code the workstation browser port in external tooling if the launcher is allowed to choose a fallback port.

## Vite proxy/application routes

Current important same-origin routes include:

- `/fiinquant-api` → FiinQuant sidecar (history, realtime via WebSocket, and `/valuation/stock` for the P/E indicator);
- `/scanner-api` → scanner sidecar;
- `/vnstock-api` → Vnstock sidecar (history, `/latest`, `/symbols`, and `/fundamentals/pe` for the P/E indicator);
- `/assistant-api` → assistant sidecar;
- `/dnse-api` → DNSE REST proxy/signing path;
- `/dnse-ws` → DNSE WebSocket proxy;
- `/__l2chart_dev_trace` → dev-only terminal trace endpoint installed by `scripts/vite-dev.config.mjs`.

Browser request origin checks are used by the local proxy/sidecar integrations to reject unwanted cross-site use.

## FiinQuant runtime

Primary files:

- `examples/workstation/provider-runtime/vite-plugin.ts`
- `examples/sidecars/fiinquant/.env.example`
- `examples/sidecars/fiinquant/fiinquant_sidecar.py` (facade: session + `/valuation/stock`)
- `examples/sidecars/fiinquant/fiinquant_sidecar_core.py` (FiinQuantX session, history cache, realtime)
- `examples/sidecars/fiinquant/requirements.txt`
- `examples/sidecars/fiinquant/requirements-provider.txt`

### Credentials

The provider runtime reads `examples/sidecars/fiinquant/.env` when present.

Relevant configured values include FiinQuant username/password, sidecar token and optional port according to the current example/runtime files.

Never commit the real `.env` or credentials.

### Managed Python environment

The runtime checks pinned provider/runtime dependency versions rather than accepting any importable environment as equivalent.

If an explicit `FIINQUANT_PYTHON` is not suitable, it can use/create:

```text
examples/sidecars/fiinquant/.venv
```

The bootstrap searches Python 3.11+ candidates and installs the pinned requirements. The runtime also preserves the repository's explicitly pinned patched `msgpack` version after installing the provider stack.

### Lazy startup and auto-login

When FiinQuant is needed, the provider runtime:

1. checks sidecar health;
2. starts the local sidecar if needed;
3. waits for health;
4. auto-logins from `.env` if username/password are configured and the sidecar is not logged in;
5. requires a configured sidecar token for server-side login.

The workstation shares a browser-side startup gate so concurrent chart/health/navigation work does not create duplicate startup races.

## Vnstock runtime

Primary files:

- `examples/providers/vnstock.ts`
- `examples/sidecars/vnstock/vnstock_sidecar.py`
- `examples/sidecars/vnstock/requirements.txt`
- `examples/workstation/scanner/vite-plugin-v2.ts`

The Vite integration starts Vnstock on demand when `/vnstock-api` is first needed or provider health/use requires it.

Python selection order currently supports:

- `VNSTOCK_PYTHON`;
- `examples/sidecars/vnstock/.venv`;
- repository `.venv`;
- active `VIRTUAL_ENV`;
- system `python`/`python3` fallback.

If the selected environment lacks the Vnstock dependencies, startup fails visibly rather than silently pretending the source is connected.

## Scanner runtime

Primary files:

- `examples/sidecars/scanner/scanner_sidecar.py`
- `examples/workstation/scanner/vite-plugin-v2.ts`

The scanner integration targets port 8730 and can start the scanner sidecar with:

1. `SCANNER_PYTHON` if supplied;
2. the FiinQuant managed `.venv` Python if present;
3. `FIINQUANT_PYTHON` if supplied;
4. system Python fallback.

The scanner sidecar itself only requires aiohttp in addition to standard-library `sqlite3` for its core HTTP/SQLite runtime. Provider-specific FiinQuant scanner calls additionally depend on the FiinQuant provider environment.

Default database:

```text
examples/sidecars/scanner/data/scanner.db
```

Override:

```text
SCANNER_DB_PATH
```

Scanner runtime data is not intended to be committed.

## CafeF EOD operations

Run commands from the repo root as shown below, or from `examples/sidecars/scanner/` without the path prefix.

### First/deep bootstrap

```bash
python examples/sidecars/scanner/cafef_eod.py import-latest --mode upto
```

### Daily EOD update

```bash
python examples/sidecars/scanner/cafef_eod.py import-latest --mode eod
```

This is the same importer invoked by the scanner UI's **Cập nhật EOD** button through the sidecar `POST /eod/import-latest` endpoint. The scanner sidecar also exposes `GET /eod/status` to inspect local CafeF coverage (latest trade date, active/snapshot counts, retention). Only one EOD update may run at a time; the download and ZIP parsing run off the aiohttp event loop, and a concurrent `POST /eod/import-latest` returns HTTP 409.

### Inspect local state

```bash
python examples/sidecars/scanner/cafef_eod.py status
```

### Re-run security classification locally

```bash
python examples/sidecars/scanner/cafef_eod.py reclassify
```

### Deterministic import from a known source

```bash
python examples/sidecars/scanner/cafef_eod.py import-url "https://.../CafeF.SolieuGD.07082026.zip" --mode eod
python examples/sidecars/scanner/cafef_eod.py import-file "/path/to/CafeF.SolieuGD.Upto07082026.zip" --mode upto
```

Environment override:

```text
CAFEF_DOWNLOAD_PAGE
```

The repository does not currently install a cron/Windows Task Scheduler job for CafeF ingestion. Daily import scheduling remains an operator responsibility.

## SSI FastConnect real-API probe

Before SSI is integrated into the chart, `scripts/ssi-probe.mjs` measures the real path from the developer machine to SSI FastConnect: Market Data auth latency, DNS/TLS baseline, cold and warm 500-candle daily requests, REST paging (`pageSize` 10/100/500/1000), page-2 ordering, intraday `5m`/`1h` latency, HOSE/HNX/UPCOM board lists, `X-RATELIMIT-*` headers and real response field shapes.

It intentionally uses only Node 20 `fetch` — no SSI SDK, no Python sidecar, no application cache, no chart code. Run with a local credential file:

```text
.env.ssi-probe
```

Populate from `agent/experiments/ssi-probe/ssi-probe.env.example` (`SSI_API_KEY`/`SSI_API_SECRET`). The report is written to:

```text
agent/experiments/ssi-probe/results/latest.json
```

The report redacts credentials and is designed to be safe to commit; `scripts/check-current-docs.mjs` treats it as runtime-only. Do not commit `.env.ssi-probe`. See `agent/experiments/ssi-probe/README.md` for the runbook.

## Build commands

Workstation production build:

```bash
npm run build:demo
```

Library build:

```bash
npm run build:lib
```

Preview current workstation build:

```bash
npm run preview
```

LAN preview command defined by the repo:

```bash
npm run preview:lan
```

## Test and verification commands

TypeScript type check:

```bash
npm run typecheck
```

Unit tests:

```bash
npm run test:unit
```

Browser tests:

```bash
npm run test:browser
```

Package verification:

```bash
npm run test:package
```

FiinQuant sidecar tests:

```bash
npm run test:sidecar
```

Scanner sidecar tests:

```bash
npm run test:scanner-sidecar
```

Repository test aggregate:

```bash
npm test
```

Full local verification:

```bash
npm run verify
```

`npm run verify` currently chains typecheck, workstation build, repository tests and Playwright browser tests.

## CI

Current `.github/workflows/ci.yml` runs on pushes and pull requests.

It has separate jobs for:

- core TypeScript/unit/build/package/npm audit;
- browser Playwright tests;
- Python sidecars/provider dependency audit;
- tracked-secret scan;
- current documentation validation (`docs` runs `scripts/check-current-docs.mjs`);
- OpenCode documentation-sync runtime validation (`docs-runtime`).

The deterministic current-doc checker is now part of the documented `main` SHA. The separate `.github/workflows/daily-current-doc-sync.yml` workflow runs the OpenCode current-documentation synchronization on a schedule (daily at 05:37 JST) and on manual `workflow_dispatch`. When it produces validated changes it commits them directly to `main` instead of maintaining a rolling `[docs-sync]` pull request.

Sunday runs and runs whose baseline is not an ancestor of target use `full-reconciliation`; otherwise the mode is `incremental`, and the workflow skips entirely when `scripts/build-current-doc-context.mjs` reports zero meaningful changed paths or the documented SHA already equals target.

The daily sync run first builds a deterministic bounded context with `scripts/build-current-doc-context.mjs` (given the baseline/target SHAs, sync mode and a source-file cap) and feeds it to the OpenCode agent. The agent may read at most `DOC_SYNC_MAX_SOURCE_FILES` (25) implementation/test/config files and must stop immediately after its semantic edits. If the agent creates local commits, the workflow collapses them into one pending working-tree docs change (`git reset --mixed` to target) before validation, so the validated commit step is the only place allowed to create a docs commit. The workflow refuses to push if HEAD is not still the target SHA. The `docs-runtime` CI job validates this runtime, including that the bounded-context builder runs, its output has the expected shape, and the sync workflow expresses direct-to-main behavior without pull-request creation or a rolling branch.

## Persistent local state

Important application-local storage includes:

### Browser

- chart/provider preferences and templates in localStorage from `examples/workstation/main.ts`;
- drawings and UI preferences in localStorage;
- paper trading state: `l2chart.paper.v1`;
- chart/replay historical cache IndexedDB: `l2chart.market.history.v1`;
- P/E indicator caches in IndexedDB: `l2chart.fundamentals.v1` (quarterly Vnstock P/E fundamentals) and `l2chart.valuations.v1` (daily FiinQuant stock valuation points).

### Scanner

- SQLite: `examples/sidecars/scanner/data/scanner.db` by default;
- scanner filters stored in browser localStorage as `l2chart.scanner.filters.v2`.

Treat scanner SQLite as rebuildable operational data, but remember that import audit/run audit can be useful for debugging and provenance.

## Common operational boundaries

### FiinQuant sidecar unavailable

The workstation provider runtime is expected to attempt lazy startup. If startup fails, inspect Python 3.11 availability, the managed `.venv`, pinned requirements and FiinQuant `.env` configuration.

### Vnstock unavailable

Inspect `VNSTOCK_PYTHON`/available virtual environments and install `examples/sidecars/vnstock/requirements.txt` into the chosen Python environment.

### Scanner has no `vn_eod` symbols

Import adjusted CafeF data first. The preloaded source intentionally refuses to fall back to network history during scan execution.

### FiinQuant symbol missing from autocomplete

The current workstation can expose a direct-looking symbol as `Direct symbol` for FiinQuant. Selecting it still has to pass the real history load; metadata absence does not make the symbol automatically valid.

### FiinQuant watchlist appears passive

This is intentional in the current runtime patch: background watchlist FiinQuant history/subscription work is suppressed to preserve account symbol quota for visible chart loads.