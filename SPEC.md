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
