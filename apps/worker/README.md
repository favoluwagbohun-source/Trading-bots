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

The worker's `PaperTradeLedger` persists active paper trades and lifecycle events
in `data/paper-trades.json` (override with `PAPER_TRADES_PATH`). It replays newly
closed 5-minute candles after restarts, emits deterministic TP/stop/runner events,
and rejects candle gaps rather than silently skipping them. Event delivery claims
are persisted before sending; ambiguous deliveries are not automatically retried.

`scoreSignalQuality` explains its score across higher-timeframe alignment (20),
trendline validity (15), entry confirmation (15), structural confluence (10),
volume (10), candle quality (10), market regime (10), and geometric TP2 R:R
(10). Factors that do not apply to a strategy are excluded and the result is
normalized over applicable points. The score is a setup rubric, not a win
probability. Grade bands are A (90+), B (80+), C (65+), and D (below 65).
Without cited strategy-validation evidence, the grade is capped at C and cannot
pass the Telegram publication gate.

Publication remains gated until the scanner, risk gate, quality grading,
paper-trade ledger, and matching chart image are connected to Telegram end to
end. Portfolio risk state and scanner candidate de-duplication remain in memory.
