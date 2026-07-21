# Security Policy

## Reporting a vulnerability

Do not publish credentials, access tokens, or exploitable vulnerability details
in a public issue. Use GitHub private vulnerability reporting for
`pviet85/lamlong-charts`.

Include the affected version or commit, reproduction steps, expected impact,
and any suggested mitigation. Reports will be acknowledged and assessed before
public disclosure.

## Integration boundary

The L2Chart core does not authenticate users or connect to market-data
services. Downstream applications are responsible for authentication,
authorization, secret storage, request signing, rate limits, and data licenses.

Reference adapters in this repository are development examples. Browser-side
secrets and local sidecars must not be exposed as production services without
an application-specific security review, origin restrictions, authentication,
TLS, and appropriate network controls.

The FiinQuant WebSocket never places `SIDECAR_TOKEN` in its URL. A direct
browser connection sends it as the first WebSocket authentication message; the
loopback Vite proxy may instead inject the existing private sidecar header. The
server rejects subscriptions until that authentication step succeeds. Rotate
the sidecar token if it is exposed, and configure reverse proxies not to record
authorization headers or WebSocket payloads.

The workstation example stores only non-sensitive URLs and UI settings in
localStorage. API secrets, passwords, and sidecar tokens are kept in tab memory
only and must be re-entered after reload. Production integrations should move
request signing and credential storage to an authenticated backend.

The workstation's Vite DNSE proxy accepts credentials loaded from `.env` only
for loopback clients. Do not treat `preview:lan` as a production authentication
boundary; remote use should provide an authenticated backend and network access
controls.

Optional provider SDKs are downloaded from their own package indexes and are
outside the chart core's trust boundary. Review their licenses and dependency
chains before distributing a prebuilt integration image. The npm package does
not include provider adapters, sidecars, or provider credentials. CI audits the
installed provider environment, but `FiinQuantX` is absent from PyPI's advisory
mapping and is explicitly reported as unauditable rather than silently treated
as safe.
