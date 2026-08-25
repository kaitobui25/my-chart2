# Contributing to L2Chart

L2Chart welcomes bug reports, documentation improvements, tests, and focused
code contributions.

## Principles

- Keep the chart core independent of brokers, exchanges, and data vendors.
- Put provider-specific behavior behind the `Datafeed` interface and treat
  adapters as optional examples under `examples/providers/`.
- Keep application composition, credentials, trading UI, and provider sidecars
  out of `src/`.
- Prefer small, reviewable changes over broad rewrites.
- Do not commit credentials, private indicators, proprietary datasets, or code
  whose license cannot be verified.
- Do not copy product names, visual assets, or proprietary implementations from
  other charting platforms.

## Local checks

Use Node.js 20 or newer and Python 3.11, then run:

```bash
npm ci
npx playwright install chromium
python3.11 -m pip install aiohttp
npm run verify
```

The npm package smoke test installs the generated tarball into a temporary
consumer project. Sidecar tests use fakes and do not require provider
credentials or the FiinQuantX SDK. CI additionally installs the optional
provider dependencies into an isolated Python 3.11 environment and audits every
package that `pip-audit` can resolve.

## Pull requests

Describe the user-facing problem, the chosen implementation, and the checks
performed. Keep unrelated formatting and refactors out of the same pull
request. New public APIs should include TypeScript types and a short usage
example.

By contributing, you agree that your contribution is licensed under the Apache
License 2.0 used by this repository.
