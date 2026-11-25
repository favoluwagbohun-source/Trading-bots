# Crypto Signal Platform

A modular cryptocurrency market-analysis, paper-trading, backtesting, charting, and Telegram signal platform.

## Stage 1 status

The repository is initialized as a TypeScript monorepo. Stage 1 provides:

- documented architecture and stage boundaries;
- npm workspace configuration;
- strict TypeScript configuration;
- a shared package scaffold;
- placeholder test/build scripts;
- a stage checklist and architecture specification.

Production exchange orders are intentionally out of scope. The system will support Binance public market data and simulated paper trades only.

## Structure

- `apps/web` - React chart and account interface.
- `apps/api` - Fastify HTTP API.
- `apps/telegram` - Telegram command and notification integration.
- `apps/worker` - continuous market and signal worker.
- `packages/market-data` - Binance REST and WebSocket market data.
- `packages/indicators` - indicators and market structure.
- `packages/strategies` - independent trading strategies.
- `packages/backtesting` - event-driven historical backtesting.
- `packages/risk-engine` - risk, sizing, and portfolio controls.
- `packages/chart-renderer` - chart image generation.
- `packages/shared` - shared types and utilities.
- `research/` - notebooks, datasets, and experiments.
- `tests/` - cross-package acceptance tests.
- `docs/` - design and operational documentation.

## Commands

```bash
npm install
npm run build
npm test
npm run check
```