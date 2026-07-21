# Data integration boundary

[`../../src/datafeed.ts`](../../src/datafeed.ts) defines the provider-neutral
market-data contract used by the L2Chart demo. The chart core consumes candles
and series data; it does not
authenticate with providers, open network connections, or manage credentials.

The files in this directory are reference adapters for the demo:

- `sample.ts` provides deterministic offline data;
- `binance.ts` demonstrates a public-market adapter;
- `dnse.ts` demonstrates a broker adapter;
- `fiinquant.ts` demonstrates a sidecar/backend adapter.

Reference adapters are not exported from the `lamlong-chart` package and are
not a stable public API. They may be copied, replaced, or removed by downstream
applications. No provider SDK is required to build or use the chart library.

## Packaging sidecars/backends

When a provider requires server-side signing, SDKs, or connection pooling,
package that integration as an application backend or sidecar. It can run on
localhost, inside Docker, on a private network, behind a tunnel, or behind a
production domain. The chart only needs the adapter URL and should not depend on
which route is used.

Treat tunnel URLs as development/private access routes, not a different
integration model. The same deployment should keep working when moved to a real
domain if CORS, WebSocket upgrade, authentication, and network latency are
handled by the application.

Production applications should implement `Datafeed` in their own integration
layer. Keep credentials outside browser bundles, cancel obsolete historical
requests, cache recent history, and multiplex subscriptions when an upstream
provider limits concurrent connections.
