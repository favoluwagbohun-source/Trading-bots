# Market-data API

The Stage 10 Fastify API exposes Binance public market data to the web chart.
Binance requests originate here, not in the browser.

```bash
npm run dev --workspace apps/api
```

Routes:

- `GET /health`
- `GET /api/market/klines?symbol=BTCUSDT&timeframe=5m&limit=500`
- `GET /api/market/stream?symbol=BTCUSDT&timeframe=5m` (WebSocket upgrade)

The historical route accepts optional UTC millisecond `startTime` and `endTime`
query parameters and enforces Binance symbol, timeframe, and limit validation.
The WebSocket sends typed candle and connection-status messages and stops its
upstream stream when the client disconnects.
