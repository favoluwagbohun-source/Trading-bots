# Web chart application

Stage 10 provides a React/Vite market chart using Lightweight Charts. The
browser only calls this platform's API; Binance REST and WebSocket requests are
made by the backend.

From the repository root, start the API and web development server in separate
terminals:

```bash
npm run dev --workspace apps/api
npm run dev --workspace apps/web
```

The Vite server proxies `/api` and WebSocket requests to `http://localhost:3001`.
Set `API_PROXY_TARGET` to use a different local API URL, or set
`VITE_API_BASE_URL` when building the web app for a separately hosted API.

The chart includes Binance-style candles and volume, symbol/timeframe/date
selection, pan/zoom/crosshair, live updates with REST polling fallback, manual
trendline rays, up to three horizontal levels, up to two zones, and entry/stop/
target price lines. All drawing is local to the current page session.

The Performance section is available in Telegram's Mini App and displays
per-chat simulated equity, active trades, strategy results, and recent paper
signals. The API validates the signed WebApp payload before reading account or
trade data; ordinary browser visitors receive no private dashboard data. Set
`TELEGRAM_WEB_APP_URL` to the deployed HTTPS URL in the worker and run the API
with the same bot token and state/ledger paths as the worker.
