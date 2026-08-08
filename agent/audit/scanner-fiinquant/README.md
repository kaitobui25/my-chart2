# FiinQuant Scanner Runtime Audit

This folder is intentionally tracked so runtime evidence can be committed back to Git for debugging.

## Run on Windows PowerShell

From the repository root, with the workstation already running at `http://127.0.0.1:53174`:

```powershell
node .\scripts\audit-scanner-fiinquant.mjs http://127.0.0.1:53174 --headed
```

The script uses the repository's existing `@playwright/test` dependency. If the Playwright Chromium binary is missing, install it once:

```powershell
npx playwright install chromium
```

Then rerun the audit command.

The default timeout is 180 seconds. For a slower FiinQuant bootstrap:

```powershell
node .\scripts\audit-scanner-fiinquant.mjs http://127.0.0.1:53174 --headed --timeout=300000
```

If Binance is already known-good and you want a faster FiinQuant-only audit:

```powershell
node .\scripts\audit-scanner-fiinquant.mjs http://127.0.0.1:53174 --headed --skip-binance --timeout=300000
```

## Evidence written

Each run creates a timestamped directory under this folder. It contains:

- `SUMMARY.md`
- `environment.json`
- `probes.json`
- `network.json`
- `console.json`
- `page-errors.json`
- `scan-binance.json` when Binance baseline is enabled
- `scan-fiinquant-ui.json`
- `scan-fiinquant-api.json` when UI cannot start the FiinQuant scan
- screenshots (`.png`)

The audit records only whether `FIINQUANT_USERNAME`, `FIINQUANT_PASSWORD`, and `SIDECAR_TOKEN` exist and are non-empty. It does not write their values. Sensitive request headers/fields are redacted before logs are saved.

It also compares the chart FiinQuant health endpoint with scanner source availability and captures listeners on ports `53174`, `8720`, and `8730` on Windows.

## Commit the evidence

After the run:

```powershell
git add agent/audit/scanner-fiinquant
git commit -m "capture fiinquant scanner runtime audit"
git push
```

Do not edit the generated logs before committing them unless you notice personal information outside the fields the script already redacts.
