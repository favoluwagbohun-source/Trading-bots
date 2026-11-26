# Market and paper-dashboard API

The Fastify API exposes Binance public market data to the web chart and serves
per-chat paper-trading performance to the Telegram Mini App. Binance requests
originate here, not in the browser.

```bash
npm run dev --workspace apps/api
```

Routes:

- `GET /health`
- `GET /api/market/klines?symbol=BTCUSDT&timeframe=5m&limit=500`
- `GET /api/market/stream?symbol=BTCUSDT&timeframe=5m` (WebSocket upgrade)
- `GET /api/paper/dashboard` with `Authorization: tma <Telegram.WebApp.initData>`

The historical route accepts optional UTC millisecond `startTime` and `endTime`
query parameters and enforces Binance symbol, timeframe, and limit validation.
The WebSocket sends typed candle and connection-status messages and stops its
upstream stream when the client disconnects.

The paper dashboard verifies Telegram's signed WebApp `initData` against
`TELEGRAM_BOT_TOKEN` and rejects data older than 24 hours. It reads the same
`TELEGRAM_STATE_PATH` and `PAPER_TRADES_PATH` files as the worker (defaulting
to `./data/telegram-state.json` and `./data/paper-trades.json`). Run the API
and worker with access to the same files on a private shared volume. Never
expose those files through static hosting or run multiple independent writers
against them.

For the single-host production reference deployment, see
[`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md). Keep the API private behind
the web reverse proxy; do not publish its port directly.
