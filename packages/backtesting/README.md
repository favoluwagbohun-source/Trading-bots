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

## Out-of-sample validation

`runOutOfSampleValidation` evaluates a fixed strategy callback on sequential,
non-overlapping test folds. `warmupBars` supplies prior closed candles to the
callback for indicator/context calculation, but no signals or positions are
allowed before each test window. Trades are closed at each fold boundary;
signals are entered only at the next candle open. Incomplete trailing windows
are omitted, and the runner requires at least one complete test fold.

This runner does not optimize or select strategy parameters. Freeze the
strategy rules, thresholds, instrument filters, and execution-cost assumptions
before evaluating the held-out periods. The callback must not read future data
through external state. Keep data collection and parameter selection separate
from final out-of-sample reporting.

The report includes individual-fold results, pooled trade counts and net PnL,
profit factor, maximum fold drawdown, and a 95% Wilson interval for win rate.
The interval describes win-rate uncertainty only; it is not a confidence
interval for profitability. PnL is summed across independently reset folds,
not presented as one compounded account equity curve. Results with few or no
trades are weak or insufficient evidence, not a pass. Validation still
requires licensed, timestamped market data and realistic fee/slippage inputs;
the repository does not include a validated historical dataset or claim any
strategy is profitable.

`runWalkForwardValidation` calls a parameter-selection callback with only the
preceding fixed-size training window, then evaluates that selection on the
next disjoint test window. `runParameterSensitivity` and `runCostStressTest`
rerun fixed rules across explicitly named variants and fee/slippage scenarios;
they report results without selecting a winning variant. `runRegimeBreakdown`
groups held-out trades by a caller-supplied, timestamp-aware regime label.
`compareResearchToPaper` compares supplied research PnL values with closed
paper-trade PnL values only; open trades must not be included. These helpers
require real historical inputs and do not imply performance.

## Downloading Binance Spot history

The worker exposes `npm run research:download --workspace apps/worker` to
stream Binance public Spot klines for BTCUSDT and BTCUSDC at 1M, 1w, 1d, 4h,
1h, and 5m. By default it requests the most recent ten calendar years; use
`--start=YYYY-MM-DD --end=YYYY-MM-DD` for a fixed UTC date range or
`--symbols=BTCUSDT,BTCUSDC` to choose markets. Each timeframe is written as
JSON Lines with a manifest into ignored `research-data/`; pages are fetched
sequentially and bounded in memory. Binance history begins at each market's
listing, so requested dates earlier than that return no rows. The downloader
does not fabricate missing candles or turn the dataset into evidence until a
strategy-specific validation run is performed.

As checked against Binance's public API on 2026-11-26, the earliest returned
5-minute rows are August 2017 for BTCUSDT and December 2018 for BTCUSDC. Thus
the requested ten-year window yields shorter, pair-specific histories.
