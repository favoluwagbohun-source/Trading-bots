# Market scan and paper-trade worker

The worker can scan Binance public market data without Telegram, or run the
scanner and Telegram bot together as one process. To enable signal delivery and
automatic paper entries, configure:

```sh
WATCHLIST_SYMBOLS=BTCUSDT,ETHUSDT \
TELEGRAM_BOT_TOKEN=... \
PAPER_FEE_RATE_PER_SIDE=0.001 \
PAPER_SLIPPAGE_RATE_PER_SIDE=0.0005 \
npm run dev --workspace apps/worker
```

Rates are decimal assumptions (the example is illustrative, not a fee quote).
The worker will not assume fees or slippage when Telegram is enabled. Optionally
set `SCAN_INTERVAL_MS` (minimum 5000; default 30000),
`TELEGRAM_STATE_PATH`, `PAPER_TRADES_PATH`, and `TELEGRAM_WEB_APP_URL`.
Run one worker process per pair of state files; do not run the standalone
Telegram command process at the same time.

Automatic entries are disabled per chat by default. Users set their starting
simulated balance with `/account`, select strategies with `/settings`, and opt
in with `/paper on`; `/paper off` prevents new entries but continues monitoring
existing paper trades. Signal delivery pause and the strategy toggles also apply
to new entries. Account balance cannot be changed after that chat has recorded
a paper trade, so persisted risk and performance history remain consistent.
`/signals` lists active tracked paper positions.

Every entry must pass all of these gates:

- strategy quality grade B or better, backed by explicitly configured
  `STRATEGY_QUALITY_EVIDENCE` JSON keyed by strategy ID; without it, the grade
  is capped at C and no entry is opened;
- Binance public `exchangeInfo` quantity and notional filters;
- fee/slippage-adjusted sizing at 1% of the user's current simulated equity;
- the portfolio exposure, daily/weekly loss, duplicate, and correlation limits;
- a matching closed-candle chart image and the durable paper-trade ledger.

Evidence must refer to actual, reviewable strategy validation; do not configure
unsupported or invented evidence. Example JSON shape (the values below are
placeholders, not validated evidence):

```json
{"break_and_retest":{"maximumSupportedGrade":"B","source":"<reviewable validation report>"}}
```

Portfolio defaults are three open trades, 2% daily loss, 6% weekly loss, 100%
gross exposure, and one trade in the shared `crypto` correlation group. They
can be changed with `PAPER_MAX_OPEN_TRADES`,
`PAPER_MAX_DAILY_LOSS_PERCENT`, `PAPER_MAX_WEEKLY_LOSS_PERCENT`,
`PAPER_MAX_GROSS_EXPOSURE_PERCENT`, and `PAPER_MAX_OPEN_PER_GROUP`.
The shared group is intentionally conservative; it does not claim to model
measured correlations.

`PaperTradeLedger` persists active paper trades, risk assumptions, realized
simulated PnL, and lifecycle notifications in `data/paper-trades.json`
(override with `PAPER_TRADES_PATH`). The worker restores per-chat portfolio
risk from the ledger after restarts, replays newly closed 5-minute candles, and
rejects gaps rather than silently skipping them. Event delivery claims are
persisted before sending; ambiguous deliveries are not automatically retried.

`scoreSignalQuality` explains its score across higher-timeframe alignment (20),
trendline validity (15), entry confirmation (15), structural confluence (10),
volume (10), candle quality (10), market regime (10), and geometric TP2 R:R
(10). Factors that do not apply to a strategy are excluded and the result is
normalized over applicable points. The score is a setup rubric, not a win
probability. Grade bands are A (90+), B (80+), C (65+), and D (below 65).

The system uses Binance public market data only. It does not read exchange
account credentials and never sends real orders.

For the single-worker production Compose deployment, backup guidance, and
HTTPS edge requirements, see [`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md).
