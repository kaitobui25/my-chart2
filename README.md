# L2Chart

L2Chart (`lamlong-chart`) is a free, open-source financial charting core for the browser. It
uses Canvas 2D, has no opinion about where market data comes from, and is
designed to be extended by applications, brokers, exchanges, and independent
developers.

> **Current repository state:** For the implementation currently present in `my-chart2` — including workstation providers, Replay, scanner, sidecars and local EOD data flow — start with [`docs/current/README.md`](docs/current/README.md). The files under `docs/current/` are the canonical current-state documentation; `agent/plan/` remains historical design context.

The project is licensed under the Apache License 2.0. You may use, modify,
redistribute, and build commercial or non-commercial systems on top of it under
the terms in [`LICENSE`](LICENSE).

> Status: `0.1.x` is a pre-release. The chart core is usable, but APIs may still
> change before `1.0.0`.
>
> **npm status:** `lamlong-chart` has not been published to the npm registry yet.
> Do not run `npm install lamlong-chart` until the first release is announced.

## Project scope

The stable package root is deliberately provider-neutral. It exports:

- the chart engine, panes, scales, and renderable series;
- drawing types and chart interaction APIs;
- the indicator registry and pure technical-analysis functions;
- a small `Datafeed` contract for historical data, realtime bars, quotes, and
  symbol search;
- dark/light theme primitives and shared market-data types.

Broker-specific authentication, trading workspaces, paper trading, and market
data adapters are not part of the stable core API. The repository contains a
demo application and several reference integrations, but applications are free
to replace every one of them.

## Capabilities

- Candlestick, Heikin Ashi, OHLC bar, line, area, histogram, band, and zone series
- Calendar-aware weekly and monthly timeframes (`1W`, `1M`)
- Independent price panes sharing one index-based time scale
- Horizontal and vertical pan, wheel/pinch zoom, autoscale, and manual scales
- Crosshair events and synchronized crosshairs across chart instances
- Dark and light themes with HiDPI rendering and responsive containers
- Drawing primitives, object selection, styling, persistence hooks, undo, and redo
- Parameterized indicator registry and a demo catalog of technical indicators
- Session highlighting, bar replay, volume, and visible-range extrema in the demo
- Multi-chart layouts and a complete workstation demo built on the same public core

## Run the demo

Requirements: Node.js 20 or newer.

```bash
npm install
npm run dev
```

Vite serves the demo on `http://127.0.0.1:53173`. The default data source is a
deterministic offline sample, so no account or credentials are required.

The demo is an example application, not a required runtime dependency of the
library.

## Use as a library

The public npm install command will be available after the first package release:

```bash
npm install lamlong-chart
```

Until then, install a tarball built from a local checkout:

```bash
# In the lamlong-chart repository
npm install
npm pack

# In the consuming application
npm install /path/to/lamlong-chart/lamlong-chart-0.1.0.tgz
```

Then import the provider-neutral API and stylesheet:

```ts
import {
  L2Chart,
  type Candle,
  type Datafeed,
  type QuoteUpdate,
} from 'lamlong-chart';
import 'lamlong-chart/style.css';

class ApplicationDatafeed implements Datafeed {
  readonly name = 'Application backend';

  async getHistory(
    symbol: string,
    interval: string,
    limit = 500,
  ): Promise<Candle[]> {
    const response = await fetch(
      `/api/history?symbol=${encodeURIComponent(symbol)}`
        + `&interval=${encodeURIComponent(interval)}&limit=${limit}`,
    );
    if (!response.ok) throw new Error(`History request failed: ${response.status}`);
    return response.json() as Promise<Candle[]>;
  }

  subscribe(
    symbol: string,
    interval: string,
    onCandle: (candle: Candle) => void,
  ): () => void {
    const stream = new EventSource(
      `/api/stream?symbol=${encodeURIComponent(symbol)}`
        + `&interval=${encodeURIComponent(interval)}`,
    );
    stream.onmessage = (event) => onCandle(JSON.parse(event.data) as Candle);
    return () => stream.close();
  }

  subscribeQuotes?(
    symbols: string[],
    onQuote: (quote: QuoteUpdate) => void,
  ): () => void {
    // Optional: multiplex all symbols through one application-level stream.
    return () => undefined;
  }
}

const element = document.getElementById('chart');
if (!element) throw new Error('Missing chart container');

const chart = new L2Chart(element);
const datafeed = new ApplicationDatafeed();
const candles = await datafeed.getHistory('EXAMPLE', '1d');
chart.setData(candles);

const unsubscribe = datafeed.subscribe('EXAMPLE', '1d', (candle) => {
  chart.updateCandle(candle);
});

// Call when the screen is disposed.
unsubscribe();
chart.destroy();
```

`subscribeMany`, `searchSymbols`, and `subscribeQuotes` are optional. A provider
adapter should multiplex subscriptions when its upstream connection count is
limited.

## Reference integrations

Provider adapters in [`examples/providers/`](examples/providers/) exist only to
demonstrate the `Datafeed` boundary used by the workstation example:

- `sample.ts`: deterministic offline data;
- `binance.ts` and `binance-cache.ts`: public Binance Spot and USD-M Futures adapters with realtime streams, symbol search, gap recovery, and browser-local IndexedDB history cache;
- `dnse.ts`: an example broker adapter;
- `fiinquant.ts` and [`examples/sidecars/fiinquant/`](examples/sidecars/fiinquant/):
  an example browser-to-sidecar/backend adapter.

These adapters are intentionally not exported from `lamlong-chart`. They are not
required to build or use the library, are not covered by the stable public API,
and may be copied or replaced in downstream applications. L2Chart is not
affiliated with or endorsed by any referenced data provider.

Sidecars and backends are a general packaging pattern for provider-specific
code, not a tunnel-specific requirement. The same adapter can point at localhost
during development, a LAN or private network address, a temporary tunnel URL, or
a production domain. A tunnel is only one route to the same service and can add
latency compared with local or same-network calls.

Credentials, data entitlements, request limits, and redistribution rights are
the responsibility of the application integrating a provider. Never commit
credentials or expose provider secrets in browser code intended for production.

## Architecture

```text
src/
  core/          Canvas renderer, panes, scales, series, drawings, interaction
  indicators/    Pure calculations, registry, and built-in definitions
  datafeed.ts    Provider-neutral integration contract
  index.ts       Stable provider-neutral package exports
  library.ts     Library bundler entry
examples/
  workstation/   Demo UI, paper trading, and application composition
  providers/     Optional Datafeed adapter examples
  sidecars/      Optional backend/sidecar integration examples
```

Important design choices:

- The time scale is index-based, so weekends and market holidays do not create
  visual gaps unless the application supplies them.
- Each pane uses a main canvas and an overlay canvas. Crosshair movement does
  not redraw the full price series.
- Rendering is limited to the visible range, keeping frame cost tied to what is
  on screen rather than total history length.
- The core never opens a network connection. The application owns data loading,
  caching, cancellation, authentication, and connection lifecycle.

## Add an indicator

Register an `IndicatorDef` in application code or add a definition under
`src/indicators/builtin/` for the demo catalog:

```ts
import {
  registerIndicator,
  type IndicatorDef,
  indicators,
} from 'lamlong-chart';

const ema9: IndicatorDef = {
  id: 'ema-9',
  name: 'EMA 9',
  category: 'overlay',
  create(chart) {
    const series = chart.addLine({ title: 'EMA 9', color: '#22a3ff' });
    return {
      recompute: () => series.setData(indicators.ema(chart.getCandles(), 9)),
      remove: () => chart.removeSeries(series),
    };
  },
};

registerIndicator(ema9);
```

Only contribute indicator implementations whose source and license can be
verified. Mathematical definitions should be implemented independently and
tested against known values.

## Development

```bash
npm ci
npx playwright install chromium
python3.11 -m pip install aiohttp
npm run verify
```

`npm run verify` typechecks the source, runs Vitest behavior tests, builds the
workstation, installs the packed npm artifact in a temporary consumer project,
verifies a server-side module import, runs sidecar unit tests, and exercises
rendering and interaction in Chromium with Playwright. CI separately audits npm
plus the complete optional Python provider environment and scans tracked files
for secrets. FiinQuantX itself is not indexed on PyPI, so its source and release
provenance remain a separately documented provider trust boundary.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution rules and
[`SECURITY.md`](SECURITY.md) for reporting security issues. Maintainers should
follow [`RELEASING.md`](RELEASING.md); npm publishing is intentionally blocked
until the one-time first-package bootstrap and trusted-publisher setup are done.

## License and third-party software

- L2Chart source: Apache-2.0, see [`LICENSE`](LICENSE).
- Lucide icons: ISC License, with selected Feather-derived icons under MIT.
- Manrope font: SIL Open Font License 1.1.
- Optional reference adapters and sidecars depend on third-party SDKs and
  services under their own licenses and terms.

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for bundled dependency
notices and optional integration boundaries.

This software is provided as-is and does not provide investment advice.
