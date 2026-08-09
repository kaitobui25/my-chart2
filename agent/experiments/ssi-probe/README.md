# SSI real API probe

This experiment measures the real path between the developer machine and SSI FastConnect **before** SSI is integrated into the chart.

It intentionally uses Node 20 `fetch` against the raw REST API:

- no SSI SDK;
- no Python sidecar;
- no application cache;
- no automatic retry;
- no chart code.

That keeps the result useful for answering one question: **when a ticker has never been cached, can my-chart2 fetch enough SSI candles fast enough to feel close to Binance rather than FiinQuant?**

## What it measures

The probe records:

1. Market Data authentication latency (`POST /api/v3/auth/token`).
2. DNS/TLS baseline from the local machine to the configured SSI host.
3. The first 500-candle daily request for the first ticker (default `PGI`).
4. REST paging behavior for page sizes `10`, `100`, `500`, and `1000`.
5. Page 2 behavior with `pageSize=500` so ordering/overlap can be inspected.
6. Repeated 500-candle daily requests for warm latency.
7. Switching to a second ticker (default `SSI`) after the session is warm.
8. `5m` and `1h` intraday latency.
9. HOSE/HNX/UPCOM securities-list latency for a future local-memory search index.
10. `X-RATELIMIT-*` response headers, HTTP status, payload size, record counts, and real response field shapes.

The first representative 500-candle OHLC response is stored in full by default so the integration plan can be based on the real payload rather than documentation assumptions.

## Safety

The generated report is designed to be safe to commit. The probe does **not** write:

- API key;
- API secret;
- Authorization header;
- access token;
- refresh token;
- OTP/password.

Sensitive-looking JSON keys are redacted again before the report is written.

Do not commit `.env.ssi-probe`. The repository already ignores `.env.*` files.

## Run on Windows / PowerShell

Checkout the probe branch and update it:

```powershell
git fetch origin
git switch agent/ssi-real-api-probe
git pull
```

Create a local credential file at the repository root:

```powershell
Copy-Item agent/experiments/ssi-probe/ssi-probe.env.example .env.ssi-probe
notepad .env.ssi-probe
```

Fill only your real values locally:

```text
SSI_API_KEY=...
SSI_API_SECRET=...
```

Then run:

```powershell
node --env-file=.env.ssi-probe scripts/ssi-probe.mjs
```

Node 20+ is required by this repository.

The report is written to:

```text
agent/experiments/ssi-probe/results/latest.json
```

## Commit only the result

Review that the report contains no credentials, then commit it on the same branch:

```powershell
git status
git add agent/experiments/ssi-probe/results/latest.json
git commit -m "record SSI real API probe"
git push
```

After that, send the commit SHA (or just say the branch is pushed). The next step is to read the actual timings, paging behavior, headers, and payload shape, then write the SSI provider implementation plan. Do not implement the provider before that review.

## Optional overrides

The defaults deliberately keep request count modest. They can be changed in `.env.ssi-probe`:

```text
SSI_PROBE_SYMBOLS=PGI,SSI
SSI_PROBE_ITERATIONS=3
SSI_PROBE_TIMEOUT_MS=10000
SSI_PROBE_GAP_MS=250
SSI_PROBE_PAGE_SIZES=10,100,500,1000
SSI_PROBE_CAPTURE_FULL=1
```

Automatic date ranges are roughly 900 days for daily and 45 days for intraday. Fixed SSI-formatted ranges can also be supplied when reproducibility is needed.
