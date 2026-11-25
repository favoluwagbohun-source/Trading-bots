# Backtesting package

Chronological, single-symbol event-driven backtester. One invocation accepts
one strategy callback and returns that strategy's results only; do not combine
strategy results into one performance figure.

The callback receives a closed-candle prefix, never the full future dataset.
Signals enter at the next available candle open. If a stop and target are both
touched in one candle, the stop is processed first. Partial targets, fees,
slippage, break-even management, confirmed-swing trailing stops, and
end-of-data liquidation are modeled.

Defaults are TP1 at 1.5R and TP2 at 3R, with one-third allocation at each
target and the remainder as a runner. Position size uses the current simulated
equity and the shared fixed 1% risk-sizing engine. The result includes a
separate trade ledger, equity curve, gross/net metrics, fees, drawdown,
expectancy, average R, losing streaks, and trade duration.

When a candle reaches the +1R break-even trigger and also crosses the entry
price, the runner is conservatively closed at break-even before target
processing; OHLC data cannot establish the intrabar sequence.

The runner is a research simulator, not evidence of profitability. Inputs must
be actual historical candles; it does not fabricate data.
