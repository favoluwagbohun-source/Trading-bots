# Crypto Signal Platform Specification

## Scope

Stage 1 establishes the repository, module boundaries, and delivery workflow. Binance public REST and WebSocket integration, strategies, paper trading, charting, Telegram, backtesting, and replay are staged separately.

## Production packages

| Package | Responsibility |
| --- | --- |
| `market-data` | Public Binance OHLCV REST, WebSocket streams, validation, reconnection, and health |
| `indicators` | Confirmed-candle indicators and market structure |
| `strategies` | Independent strategy implementations and configuration |
| `backtesting` | Event-driven simulation without lookahead |
| `risk-engine` | Position sizing, R:R checks, portfolio limits, and paper-account state |
| `chart-renderer` | Consistent chart snapshots and Telegram image output |
| `shared` | Shared schemas, types, timestamps, and utility contracts |

## Data rules

- Binance public market data is the only allowed live candle source.
- Only backend services may request Binance.
- No API keys, private credentials, mock candles, or real-order execution are part of this project.
- Strategy decisions use closed candles only.
- Signal text and chart images must use the same immutable market-data snapshot.

## Stage boundaries

1. Project setup and architecture.
2. Binance market-data engine.
3. Indicator and market-structure engine.
4. Trendline research and detection.
5. Top-down trendline strategy.
6. Three additional independent strategies.
7. Risk management and position sizing.
8. Historical backtesting.
9. Replay and manual paper trading.
10. Chart application.
11. Telegram integration.
12. Chart image generation.
13. Performance dashboard.
14. Professional validation.
15. Production preparation and deployment.

## Architecture invariants

- Business rules must not depend on Google Colab or Gemini.
- Each strategy owns independent entry, stop, target, validation, and reporting behavior.
- Backtest, replay, live scan, and chart rendering consume timestamped candle snapshots.
- Money and quantity calculations use validated instrument constraints.
- Duplicate signal, notification, trade-event, and update handling is idempotent.
- Every release must include tests for the stage's acceptance criteria.

## Market-analysis engine audit and staged implementation

The requested market-analysis-engine work was audited against the existing
market-data, indicators, strategies, worker, chart, risk, and backtesting code.
The repository already has Binance public-data access, four separately
callable strategy prototypes, fixed-risk sizing and portfolio gates,
signal-quality scoring, conservative OHLC backtesting, and chart rendering
from the signal's closed-candle data.

The audit found these gaps; the market-analysis prompt is being implemented in
small, independently verified stages and is not considered complete:

- The scanner previously contained the analysis flow itself and did not retain
  one immutable, cross-timeframe input snapshot.
- Candle ingestion accepted non-finite volume values because `NaN < 0` is
  false.
- Top-down trendline rules use engineering assumptions, are not source-verified
  as Tori Trades methodology, and use the signal candle as the stop rather than
  a separately identified opposing Safety Line.
- Progressive 4-hour Point A/Point B lifecycle tracking now records touches,
  structural violations, validity, and close-confirmed breaks. The top-down
  scanner consumes trendlines derived from those same lifecycle anchors.
- The analysis snapshot now classifies six deterministic regimes (bullish,
  bearish, range, high volatility, low volatility, and uncertain transition)
  and records a structured approval/rejection evaluation for each strategy
  variation. The thresholds are configurable engineering assumptions, not
  calibrated trading parameters.
- Top-down candidates require a valid opposing 4-hour Safety Line; the chart
  includes Action/Safety Line annotations, and the 0.1% stop buffer is an
  explicitly labeled engineering assumption.
- Liquidity sweeps now consume confirmed 4-hour/1-hour/5-minute levels and
  reject a sweep opposed to 4-hour structure. Break/retest evaluation exposes
  explicit no-break, awaiting-retest, invalidated, and confirmed states.
- Order-block invalidation can be configured as close-through or wick-through.
- Research tooling now supports rolling walk-forward selection on prior-only
  training windows, parameter-sensitivity and fee/slippage stress runs,
  timestamped regime breakdowns, and closed-paper-trade comparisons.
- Backtesting has chronological held-out folds, but parameter sensitivity,
  fee/slippage stress matrices, walk-forward selection protocols,
  market-regime breakdown, and live paper-vs-research comparison remain
  outstanding.
- No reviewable licensed historical dataset is included; the project must not
  claim strategy profitability from its deterministic test fixtures.

`MarketAnalysisOrchestrator` validates candle values and ordering, synchronizes
closed candles independently by timeframe to the latest closed 5-minute
analysis timestamp, freezes the resulting snapshot, and passes that same
snapshot to strategy evaluators. Higher-timeframe bars are selected by their
own close timestamps; they are not assumed to close simultaneously. The
worker's chart candles and signal candle reference the synchronized snapshot.
Market-data validation also rejects non-finite volume and negative timestamps.

Still incomplete: source verification of the requested external methodology,
full multi-timeframe supply/demand and higher-timeframe setup refinement, and
execution of validation against licensed, timestamped historical data and
ongoing live paper results. The repository has no such reviewable dataset, so
no market-performance claims are made. Synthetic test fixtures verify
deterministic behavior only.
