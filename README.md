# Crypto Signal Platform

A modular cryptocurrency market-analysis, paper-trading, backtesting, charting, and Telegram signal platform.

## Current implementation

Stages 1-13 are implemented. Stages 14-15 cover professional validation and
production preparation. The repository provides:

- a TypeScript monorepo and documented architecture;
- Binance public market-data, indicators, strategies, risk, and backtesting packages;
- historical candle replay and manual paper trading;
- a React/Vite dark chart and Fastify market-data API;
- a Telegram signal bot with opt-in automated paper entries, durable trade
  tracking, and an authenticated Mini App performance dashboard;
- a stage checklist and package-level tests.

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

Run the chart locally by starting the API and web workspaces in separate
terminals:

```bash
npm run dev --workspace apps/api
npm run dev --workspace apps/web
```