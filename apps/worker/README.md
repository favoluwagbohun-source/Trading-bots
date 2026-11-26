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

`SignalRiskGate` preflights a candidate using exchange instrument rules,
fee/slippage-adjusted position sizing, the fixed 1% account-risk budget, and
configured portfolio limits. Call `confirmPublished` only after a paper signal
has actually been delivered. This preflight is not yet wired into Telegram.

Publication remains gated until the scanner, risk gate, quality grading,
durable paper-trade tracking, and matching chart image are connected end to end.
Scanner de-duplication, portfolio state, and Telegram user settings are currently
in memory and do not survive a restart.
