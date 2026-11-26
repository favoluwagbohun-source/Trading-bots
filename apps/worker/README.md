# Market scan worker

Run the configurable Binance watchlist scanner with:

```sh
WATCHLIST_SYMBOLS=BTCUSDT,ETHUSDT npm run dev --workspace apps/worker
```

`SCAN_INTERVAL_MS` optionally changes the polling interval (minimum 5000; default
30000). The scanner fetches closed 5-minute candles and historical higher-timeframe candles, evaluates the four strategies independently,
and emits deduplicated setup candidates to the worker log. `renderSignalChart`
turns a candidate's closed candles and strategy annotations into a PNG using the
same snapshot ID, with entry, stop, targets, symbol, and timeframe shown. It does
not place orders or publish Telegram signals.

Telegram publication remains gated until candidates are connected to the
portfolio-risk checks, quality grading, durable paper-trade tracking, and the
matching chart-image pipeline. Scanner de-duplication and Telegram user settings
are currently in memory and do not survive a restart.
