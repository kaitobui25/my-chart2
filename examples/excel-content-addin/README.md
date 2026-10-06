# L2Chart Excel content add-in proof of concept

This example embeds the existing browser-native `L2Chart` canvas directly inside an Excel worksheet by using a Microsoft Office **content add-in**.

## Default market view

The add-in opens in **Japan equity mode** by default:

- Default symbol: `7203.T` (Toyota Motor).
- Default timeframe: `1D`.
- The top command strip is ordered **Symbol → Timeframe → Indicator → AI/Sheet actions**. Symbol is a searchable combobox backed by Yahoo Japan search; timeframe is compact and the indicator picker is a custom dropdown.
- Market history uses a centralized timeframe/lookback policy with a client limit of 5,000 candles. Intraday requests use explicit Yahoo-safe lookback windows and fall back to the provider-safe default request if Yahoo rejects a wider range.
- Live candles use the existing Yahoo Japan datafeed polling path (60 seconds).
- The indicator dropdown contains only built-in OHLCV indicators; Vietnam-specific external indicators are intentionally excluded. Every indicator row has an inline `☆` / `★` favorite control. Favorites are persisted in `localStorage` and are moved into a **Yêu thích** section at the top of the dropdown.
- The stealth chart keeps price/time chrome hidden until the pointer enters the add-in. While the pointer remains anywhere inside the add-in, the price axis and time axis stay visible; they hide again after the pointer leaves the add-in, the window loses focus, or the document becomes hidden.
- While the mouse is over the chart itself, a small pointer dot follows the cursor. The active crosshair projects the hovered value onto the price and time axes with compact labels using 50% opacity and an 8 px font (two-thirds of the normal 12 px axis text).

When the content object is narrower than 480 px, the command strip becomes two rows so the symbol/timeframe controls remain usable instead of being squeezed.

## Watch List

The **Watch List** tab keeps a small persisted list of Tokyo symbols next to the chart workflow:

- The initial list uses the same default Tokyo symbols as the market view and is persisted in `localStorage` after add/remove operations.
- The list is capped at 20 symbols so refresh cost stays bounded inside the Excel WebView.
- Quotes refresh only while the Watch List tab is visible. A single provider batch request fetches two daily candles per symbol every 60 seconds, so `% day` is calculated from the previous close rather than the current session open.
- Rows are reconciled incrementally instead of rebuilding the full list on every refresh.
- Selecting a row switches back to **Chart** and loads that symbol at the currently selected timeframe. Removing a Watch List row never changes the chart that is already open.

Watch List code is split into configuration, persistence, market-data, view, and controller modules so storage/UI/provider concerns can evolve independently.

## AI assistant

The `AI` action opens a non-modal assistant drawer **over the chart** instead of permanently shrinking the chart area. On a normal content-add-in size it docks to the right; below 600 px it becomes a bottom sheet. Closing the drawer keeps the current conversation in memory.

The Excel shell reuses the shared assistant client/context contracts in `examples/assistant` and exposes two assistant providers in the drawer: **ChatGPT** and **Codex**. Context is deliberately bounded: the shared context builder sends only candles around the visible chart range (up to 240 primary candles), the active indicator snapshot, latest quote information, and only explicitly requested extra timeframes. The Excel client does not attach a chart screenshot, keeping request size and rendering overhead low.

Development `/assistant-api` traffic is same-origin proxied to the loopback assistant sidecar. **ChatGPT** uses the local LAMlongchart Chrome extension and the signed-in ChatGPT tab. **Codex** uses the locally installed Codex CLI signed in with ChatGPT. No OpenAI API key is embedded in the add-in. Do not expose the loopback sidecar directly to a network. A multi-user production deployment needs an authenticated per-user backend rather than sharing one host identity/quota.

## Data layout

Select a rectangular range with at least five columns in this order:

```text
Date | Open | High | Low | Close | Volume (optional)
```

The first row may contain headers. Dates can be ordinary Excel date values, parseable date text, Unix seconds, or Unix milliseconds. Auto-detection uses Excel's valid serial-date range to avoid ambiguous numeric values. The add-in exposes `excelRangeOptions.numericTimeFormat` in `stealth-preset.ts` so deployments with ambiguous early Unix timestamps can select an explicit numeric format without changing parser logic.

## Run in Excel desktop

### Recommended: double-click launcher

On Windows, double-click this file from the repository root:

```text
open-excel-chart.bat
```

The launcher checks whether npm dependencies and the trusted Office localhost certificate are already installed. It only runs the missing setup steps, then starts the Excel add-in development server at `https://localhost:3000`.

Keep the command window open while using the add-in in Excel. Press `Ctrl+C` in that window when finished.

### Manual setup

If you prefer to run the commands manually, from the repository root run:

```powershell
npm install
npx office-addin-dev-certs install
npm run excel:dev
```

`npm install` is normally needed only the first time or after dependencies change. The certificate command creates and trusts the localhost development certificate and is normally needed only once per machine. After setup, `npm run excel:dev` is the only command required for subsequent runs. Vite reads the certificate path, host, and port from `addin.config.json`.

Development origin, certificate files, and the requested content-add-in size live in `addin.config.json`. `npm run excel:dev` regenerates the development `manifest.xml` from `manifest.template.xml` before starting Vite.

The Excel Vite server exposes `/yfinance-jp-api` and `/assistant-api` through shared development integrations. Both local sidecars start on demand. Python 3.10+ is required for Japan market data. For **ChatGPT**, load the LAMlongchart ChatGPT Bridge extension from `examples/chatgpt-extension` unpacked in Chrome and keep Chrome signed in to ChatGPT. For **Codex**, install/sign in to Codex CLI. A public tunnel is not required. Production deployments need HTTPS backend routes with appropriate authentication/authorization.

With the server running, open Excel and sideload `examples/excel-content-addin/manifest.xml` through **Home > Add-ins > My Add-ins > Manage My Add-ins > Upload My Add-in**. Then insert/open **L2Chart Excel**, select the OHLC(V) range, and choose **Sheet**.

## Browser-only preview

Run `npm run excel:dev` and open the development origin configured in `addin.config.json`. Outside Excel, the Japan market view and AI drawer remain available; only the worksheet-selection button is disabled.

## Build

```powershell
npm run build:excel
```

The web assets are emitted to `dist/excel-content-addin`. A deployed add-in should host these assets over HTTPS and change `DefaultSettings > SourceLocation` in `manifest.xml` from localhost to the production URL.

Generate a production manifest without changing the development manifest source of truth:

```powershell
npm run excel:manifest -- --origin https://your-production-origin.example --output manifest.production.xml
```
