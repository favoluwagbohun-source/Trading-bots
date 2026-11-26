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
- Trendline construction is pairwise swing-anchor detection, not progressive
  Point A/Point B lifecycle tracking; touch validation and structural
  violations need stronger modeling.
- Market-structure regime classification is only bullish, bearish, or neutral;
  volatility regimes and structured per-strategy approval/rejection evidence
  are not yet implemented.
- Backtesting has chronological held-out folds, but parameter sensitivity,
  fee/slippage stress matrices, walk-forward selection protocols,
  market-regime breakdown, and live paper-vs-research comparison remain
  outstanding.
- No reviewable licensed historical dataset is included; the project must not
  claim strategy profitability from its deterministic test fixtures.

The first implementation stage adds `MarketAnalysisOrchestrator`. It validates
candle values and ordering, synchronizes closed candles independently by
timeframe to the latest closed 5-minute analysis timestamp, freezes the
resulting snapshot, and passes that same snapshot to the existing strategy
evaluators. Higher-timeframe bars are selected by their own close timestamps;
they are not assumed to close simultaneously. The worker's chart candles and
signal candle reference the synchronized snapshot. Market-data validation now
also rejects non-finite volume and negative timestamps.

Still incomplete: structured strategy rejection reports, documented six-state
market regimes, progressive trendline lifecycle and source research,
first-class Action/Safety Lines, broader statistical validation, and
chart-renderer consumption of the complete standardized analysis object.
